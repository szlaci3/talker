import { createHmac, timingSafeEqual } from 'node:crypto';

export const SESSION_TTL = 8 * 60 * 60;

export function json(body, status = 200) {
  return Response.json(body, { status, headers: {
    'Cache-Control': 'private, no-store',
    'X-Content-Type-Options': 'nosniff',
  } });
}

export function secret(name, minimum = 1) {
  const value = process.env[name] || '';
  if (value.length < minimum) throw json({ error: `Server is missing ${name}.` }, 503);
  return value;
}

export function equal(a, b) {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

// Byte-for-byte compatible with Render's existing signed bearer sessions.
export function tokenFor(expiry) {
  const payload = Buffer.from(String(expiry));
  const signature = createHmac('sha256', secret('SESSION_SECRET', 32)).update(payload).digest();
  return Buffer.concat([payload, Buffer.from('.'), signature]).toString('base64url');
}

export function authenticated(request) {
  const auth = request.headers.get('Authorization') || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  // Canonical encoding and fixed signature length reject malformed credentials.
  if (/^[A-Za-z0-9_-]{1,128}$/.test(token)) {
    const raw = Buffer.from(token, 'base64url');
    const separator = raw.indexOf(46);
    const expiry = raw.subarray(0, separator).toString();
    if (/^\d{10}$/.test(expiry) && Number(expiry) > Math.floor(Date.now() / 1000)
        && Number(expiry) <= Math.floor(Date.now() / 1000) + SESSION_TTL
        && equal(token, tokenFor(Number(expiry)))) return token;
  }
  throw json({ error: 'Your session expired. Enter the code again.' }, 401);
}

export function sameOrigin(request) {
  const origin = request.headers.get('Origin');
  if (origin && origin !== new URL(request.url).origin) {
    throw json({ error: 'Origin is not allowed.' }, 403);
  }
}

export function method(request, expected) {
  if (request.method !== expected) throw json({ error: 'Method is not allowed.' }, 405);
}

// Supplement the deployed platform limit with the original 8/600s guardrail.
// This map alone is NOT a distributed or durable quota.
const attempts = new Map();
export function invitationAttempt(ip) {
  const now = Date.now();
  for (const [key, entries] of attempts) {
    if (entries.at(-1) <= now - 600_000) attempts.delete(key);
  }
  const entries = (attempts.get(ip) || []).filter(at => at > now - 600_000);
  if (entries.length >= 8) throw json({ error: 'Too many requests. Please wait and try again.' }, 429);
  if (!attempts.has(ip) && attempts.size >= 10_000) {
    throw json({ error: 'Invitation service is busy. Please try again later.' }, 503);
  }
  entries.push(now);
  attempts.set(ip, entries);
}

export async function smallJson(request) {
  if (!request.headers.get('Content-Type')?.toLowerCase().startsWith('application/json')) {
    throw json({ error: 'Expected JSON.' }, 400);
  }
  // Enforce the bound while reading, including chunked requests.
  const reader = request.body?.getReader();
  let size = 0;
  const chunks = [];
  if (reader) {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 2048) {
        await reader.cancel();
        throw json({ error: 'Request is too large.' }, 413);
      }
      chunks.push(Buffer.from(value));
    }
  }
  try {
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error();
    return body;
  } catch {
    throw json({ error: 'Expected a JSON object.' }, 400);
  }
}

export function failure(cause) {
  return cause instanceof Response ? cause : json({ error: 'The service is temporarily unavailable.' }, 503);
}
