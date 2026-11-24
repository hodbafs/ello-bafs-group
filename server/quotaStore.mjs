import crypto from 'node:crypto';

export const DEFAULT_MAX_SESSION_SECONDS = 300; // 5 minutes per call
export const DEFAULT_DAILY_LIMIT_SECONDS = 900; // 15 minutes per user per day
export const DEFAULT_MAX_REQUESTS_PER_MINUTE = 6;

export function getBangkokDateKey(nowMs = Date.now()) {
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Bangkok',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  return formatter.format(new Date(nowMs));
}

export function createQuotaStore(options = {}) {
  const maxSessionSeconds = options.maxSessionSeconds ?? DEFAULT_MAX_SESSION_SECONDS;
  const dailyLimitSeconds = options.dailyLimitSeconds ?? DEFAULT_DAILY_LIMIT_SECONDS;
  const maxRequestsPerMinute = options.maxRequestsPerMinute ?? DEFAULT_MAX_REQUESTS_PER_MINUTE;

  const usageByUserDay = new Map();
  const sessionsById = new Map();
  const requestTimestampsByUser = new Map();

  function userDayKey(userId, nowMs) {
    return `${userId}::${getBangkokDateKey(nowMs)}`;
  }

  function getUsedSeconds(userId, nowMs) {
    return usageByUserDay.get(userDayKey(userId, nowMs)) ?? 0;
  }

  function getQuota(userId, nowMs = Date.now()) {
    const usedSecondsToday = getUsedSeconds(userId, nowMs);
    const remainingSecondsToday = Math.max(0, dailyLimitSeconds - usedSecondsToday);
    return {
      usedSecondsToday,
      remainingSecondsToday,
      dailyLimitSeconds,
      maxSessionSeconds,
      bangkokDate: getBangkokDateKey(nowMs),
    };
  }

  function checkRateLimit(userId, nowMs) {
    const cutoff = nowMs - 60_000;
    const prev = requestTimestampsByUser.get(userId) ?? [];
    const recent = prev.filter((ts) => ts > cutoff);
    if (recent.length >= maxRequestsPerMinute) {
      requestTimestampsByUser.set(userId, recent);
      return false;
    }
    recent.push(nowMs);
    requestTimestampsByUser.set(userId, recent);
    return true;
  }

  function reserveSession(userId, nowMs = Date.now()) {
    if (!userId || typeof userId !== 'string' || userId.trim().length < 2) {
      return {
        ok: false,
        status: 400,
        code: 'INVALID_USER',
        message: 'ต้องระบุรหัสผู้ใช้งาน (userId) ก่อนเริ่มคุยสด',
      };
    }

    if (!checkRateLimit(userId, nowMs)) {
      return {
        ok: false,
        status: 429,
        code: 'RATE_LIMITED',
        message: 'คำขอเปิดสายคุยสดถี่เกินไป กรุณารอสักครู่แล้วลองใหม่',
        quota: getQuota(userId, nowMs),
      };
    }

    const quota = getQuota(userId, nowMs);
    if (quota.remainingSecondsToday <= 0) {
      return {
        ok: false,
        status: 429,
        code: 'DAILY_QUOTA_EXCEEDED',
        message: 'ใช้งานโหมดคุยสดครบโควตา 15 นาทีต่อวันแล้ว สามารถฝึกต่อได้ในโหมดซ้อมพิมพ์ครับ',
        quota,
      };
    }

    const allowedDurationSeconds = Math.min(maxSessionSeconds, quota.remainingSecondsToday);
    const liveSessionId = `live_${crypto.randomUUID().replace(/-/g, '').slice(0, 16)}`;

    sessionsById.set(liveSessionId, {
      id: liveSessionId,
      userId,
      dayKey: userDayKey(userId, nowMs),
      allowedDurationSeconds,
      reportedSeconds: 0,
      ended: false,
      createdAtMs: nowMs,
    });

    return {
      ok: true,
      liveSessionId,
      allowedDurationSeconds,
      quota,
    };
  }

  function reportUsage(userId, liveSessionId, elapsedSeconds, ended = false, nowMs = Date.now()) {
    const session = sessionsById.get(liveSessionId);
    if (!session || session.userId !== userId) {
      return {
        ok: false,
        status: 404,
        code: 'LIVE_SESSION_NOT_FOUND',
        message: 'ไม่พบ Live session นี้หรือไม่มีสิทธิ์เข้าถึง',
      };
    }

    const sanitizedElapsed = Number.isFinite(elapsedSeconds)
      ? Math.max(0, Math.min(session.allowedDurationSeconds, Math.floor(elapsedSeconds)))
      : session.reportedSeconds;

    // Monotonic increase only so tampered lower values cannot refund quota
    const nextReported = Math.max(session.reportedSeconds, sanitizedElapsed);
    const delta = nextReported - session.reportedSeconds;

    if (delta > 0) {
      const prevUsed = usageByUserDay.get(session.dayKey) ?? 0;
      usageByUserDay.set(session.dayKey, Math.min(dailyLimitSeconds, prevUsed + delta));
      session.reportedSeconds = nextReported;
    }

    if (ended) {
      session.ended = true;
    }

    return {
      ok: true,
      reportedSeconds: session.reportedSeconds,
      ended: session.ended,
      quota: getQuota(userId, nowMs),
    };
  }

  return {
    getQuota,
    reserveSession,
    reportUsage,
  };
}
