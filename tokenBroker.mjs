import { GoogleGenAI } from '@google/genai';
import { buildLiveConnectConfig, LIVE_MODEL, normalizeLivePracticeInput } from './livePromptBuilder.mjs';
import { createQuotaStore } from './quotaStore.mjs';

const DEFAULT_ALLOWED_ORIGINS = [
  'http://localhost:5173',
  'http://127.0.0.1:5173',
  'http://localhost:4173',
  'http://127.0.0.1:4173',
];

function parseAllowedOrigins(raw) {
  if (!raw || !raw.trim()) return DEFAULT_ALLOWED_ORIGINS;
  return raw
    .split(',')
    .map((o) => o.trim().replace(/\/+$/, ''))
    .filter(Boolean);
}

function resolveCorsOrigin(requestOrigin, allowedOrigins) {
  if (!requestOrigin) return null;
  // Browsers send Origin: "null" when opening ELLO-Standalone.html directly via file://
  if (requestOrigin === 'null') return '*';
  if (allowedOrigins.includes('*')) return requestOrigin;
  if (allowedOrigins.includes(requestOrigin)) return requestOrigin;
  return null;
}

async function readJsonBody(req, maxBytes = 32_768) {
  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    total += chunk.length;
    if (total > maxBytes) {
      throw Object.assign(new Error('Request payload too large'), { status: 413, code: 'PAYLOAD_TOO_LARGE' });
    }
    chunks.push(chunk);
  }
  const raw = Buffer.concat(chunks).toString('utf8').trim();
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    throw Object.assign(new Error('Invalid JSON payload'), { status: 400, code: 'INVALID_JSON' });
  }
}

export function createLiveTokenHandler(options = {}) {
  const apiKey = options.apiKey ?? process.env.GEMINI_API_KEY ?? '';
  const allowedOrigins = parseAllowedOrigins(options.allowedOrigins ?? process.env.ALLOWED_ORIGINS);
  const quotaStore = options.quotaStore ?? createQuotaStore();
  const nowFn = options.nowFn ?? (() => Date.now());

  const createAuthToken =
    options.createAuthToken ??
    (async ({ liveConfig, expireIso, newSessionExpireIso }) => {
      const ai = new GoogleGenAI({
        apiKey,
        httpOptions: { apiVersion: 'v1alpha' },
      });
      return ai.authTokens.create({
        config: {
          uses: 1,
          newSessionExpireTime: newSessionExpireIso,
          expireTime: expireIso,
          liveConnectConstraints: {
            model: LIVE_MODEL,
            config: liveConfig,
          },
        },
      });
    });

  function sendJson(res, status, payload, corsOrigin) {
    const headers = {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
    };
    if (corsOrigin) {
      headers['Access-Control-Allow-Origin'] = corsOrigin;
      headers['Access-Control-Allow-Methods'] = 'GET, POST, OPTIONS';
      headers['Access-Control-Allow-Headers'] = 'Content-Type, Authorization';
      headers['Vary'] = 'Origin';
    }
    res.writeHead(status, headers);
    res.end(JSON.stringify(payload));
  }

  return async function handleRequest(req, res) {
    const reqUrl = new URL(req.url || '/', 'http://localhost');
    const originHeader = typeof req.headers.origin === 'string' ? req.headers.origin : '';
    const corsOrigin = resolveCorsOrigin(originHeader, allowedOrigins);

    if (req.method === 'OPTIONS') {
      if (originHeader && !corsOrigin) {
        sendJson(res, 403, { code: 'ORIGIN_FORBIDDEN', message: 'Origin not allowed' }, null);
        return;
      }
      res.writeHead(204, {
        ...(corsOrigin
          ? {
              'Access-Control-Allow-Origin': corsOrigin,
              'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
              'Access-Control-Allow-Headers': 'Content-Type, Authorization',
              Vary: 'Origin',
            }
          : {}),
      });
      res.end();
      return;
    }

    if (req.method === 'GET' && reqUrl.pathname === '/api/health') {
      sendJson(
        res,
        200,
        {
          ok: true,
          service: 'ello-live-token-broker',
          liveConfigured: Boolean(apiKey),
          model: LIVE_MODEL,
        },
        corsOrigin
      );
      return;
    }

    if (req.method === 'GET' && reqUrl.pathname === '/api/live/quota') {
      const userId = reqUrl.searchParams.get('userId') || '';
      if (!userId.trim()) {
        sendJson(res, 400, { code: 'INVALID_USER', message: 'Missing userId' }, corsOrigin);
        return;
      }
      sendJson(res, 200, quotaStore.getQuota(userId, nowFn()), corsOrigin);
      return;
    }

    if (req.method === 'POST' && reqUrl.pathname === '/api/live/token') {
      if (!apiKey) {
        sendJson(
          res,
          503,
          {
            code: 'LIVE_NOT_CONFIGURED',
            message: 'Server ยังไม่ได้ตั้งค่า GEMINI_API_KEY สำหรับโหมดคุยสด',
          },
          corsOrigin
        );
        return;
      }

      try {
        const body = await readJsonBody(req);
        const userId = typeof body.userId === 'string' ? body.userId.trim() : '';
        const reservation = quotaStore.reserveSession(userId, nowFn());
        if (!reservation.ok) {
          sendJson(
            res,
            reservation.status,
            { code: reservation.code, message: reservation.message, quota: reservation.quota },
            corsOrigin
          );
          return;
        }

        const nowMs = nowFn();
        const normalizedInput = normalizeLivePracticeInput(body);
        const liveConfig = buildLiveConnectConfig(normalizedInput);
        const newSessionExpireIso = new Date(nowMs + 90_000).toISOString();
        const expireIso = new Date(nowMs + (reservation.allowedDurationSeconds + 60) * 1000).toISOString();

        const authToken = await createAuthToken({
          liveConfig,
          expireIso,
          newSessionExpireIso,
        });

        if (!authToken?.name) {
          sendJson(
            res,
            502,
            { code: 'TOKEN_ISSUE_FAILED', message: 'ไม่สามารถออก Ephemeral Token ได้ในขณะนี้' },
            corsOrigin
          );
          return;
        }

        sendJson(
          res,
          200,
          {
            token: authToken.name,
            model: LIVE_MODEL,
            liveSessionId: reservation.liveSessionId,
            allowedDurationSeconds: reservation.allowedDurationSeconds,
            expiresAt: expireIso,
            quota: reservation.quota,
          },
          corsOrigin
        );
      } catch (err) {
        const status = typeof err?.status === 'number' ? err.status : 500;
        const code = typeof err?.code === 'string' ? err.code : 'TOKEN_BROKER_ERROR';
        const message =
          status < 500
            ? err.message
            : 'เกิดข้อผิดพลาดฝั่ง Token Server กรุณาลองใหม่อีกครั้ง';
        sendJson(res, status, { code, message }, corsOrigin);
      }
      return;
    }

    if (req.method === 'POST' && reqUrl.pathname === '/api/live/usage') {
      try {
        const body = await readJsonBody(req);
        const userId = typeof body.userId === 'string' ? body.userId.trim() : '';
        const liveSessionId = typeof body.liveSessionId === 'string' ? body.liveSessionId.trim() : '';
        const elapsedSeconds = Number(body.elapsedSeconds ?? 0);
        const ended = Boolean(body.ended);

        const result = quotaStore.reportUsage(userId, liveSessionId, elapsedSeconds, ended, nowFn());
        if (!result.ok) {
          sendJson(res, result.status, { code: result.code, message: result.message }, corsOrigin);
          return;
        }
        sendJson(res, 200, result, corsOrigin);
      } catch (err) {
        const status = typeof err?.status === 'number' ? err.status : 500;
        const code = typeof err?.code === 'string' ? err.code : 'USAGE_REPORT_ERROR';
        sendJson(res, status, { code, message: err?.message || 'Unable to record usage' }, corsOrigin);
      }
      return;
    }

    sendJson(res, 404, { code: 'NOT_FOUND', message: 'Endpoint not found' }, corsOrigin);
  };
}
