import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createLiveTokenHandler } from './tokenBroker.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Load optional local env files (never required in production containers)
for (const envCandidate of [
  path.resolve(__dirname, '.env.local'),
  path.resolve(__dirname, '.env'),
  path.resolve(__dirname, '..', '.env.local'),
]) {
  if (fs.existsSync(envCandidate) && typeof process.loadEnvFile === 'function') {
    try {
      process.loadEnvFile(envCandidate);
    } catch {
      // Ignore malformed optional env file
    }
  }
}

const port = Number(process.env.LIVE_SERVER_PORT || process.env.PORT || 8787);
const handler = createLiveTokenHandler();
const server = http.createServer(handler);

server.listen(port, () => {
  const configured = Boolean(process.env.GEMINI_API_KEY);
  console.log(
    `[ELLO Live Token Broker] listening on http://localhost:${port} | GEMINI_API_KEY: ${
      configured ? 'configured' : 'MISSING (set in server/.env or env)'
    }`
  );
});
