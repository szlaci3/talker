import { authenticated, failure, json, method, sameOrigin, secret } from '../lib/security.mjs';
import { liveTokenPayload } from '../lib/live.mjs';
import { CHAT_PATHS, antigravityRoute } from '../lib/antigravity.mjs';

export default async function liveAccess(request) {
  try {
    sameOrigin(request);
    const path = new URL(request.url).pathname;
    if (CHAT_PATHS.includes(path)) return await antigravityRoute(request);
    const check = path === '/api/session/check';
    if (!check && !['/api/dialog-token', '/api/live-token'].includes(path)) return json({ error: 'Not found.' }, 404);
    method(request, check ? 'GET' : 'POST');
    authenticated(request);
    if (check) return json({ ok: true });
    const dialog = path === '/api/dialog-token';
    const payload = liveTokenPayload(dialog);
    const apiKey = secret('GOOGLE_API_KEY', 12);
    let result;
    try {
      const response = await fetch('https://generativelanguage.googleapis.com/v1beta/auth_tokens', {
        method: 'POST',
        headers: { 'x-goog-api-key': apiKey, 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(15_000),
      });
      result = await response.json();
      if (!response.ok) {
        // Do not forward provider bodies: they can echo credentials or request data.
        return json({ error: `Gemini Live token request was rejected (HTTP ${response.status}). Please try again later.` }, response.status === 429 ? 429 : 502);
      }
      if (typeof result?.name !== 'string' || !result.name.startsWith('auth_tokens/')) throw new Error();
    } catch {
      return json({ error: dialog
        ? 'Gemini Dialog token service could not be reached. Try Dialog again or use Live.'
        : 'Gemini Live token service could not be reached. English browser recognition will be used if available.' }, 502);
    }
    return json({ token: result.name, ...(dialog ? { setup: payload.bidiGenerateContentSetup } : {}) });
  } catch (cause) { return failure(cause); }
}

// Two project rules total, fitting Netlify's Free plan. No three-per-minute cap.
export const config = {
  path: ['/api/dialog-token', '/api/live-token', '/api/session/check', '/api/chat', '/api/ui-tool-result', '/api/chat-stream', '/api/chat-cancel'],
  rateLimit: { windowLimit: 30, windowSize: 180, aggregateBy: ['ip', 'domain'] },
};
