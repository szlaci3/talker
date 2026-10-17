import { equal, failure, invitationAttempt, json, method, sameOrigin, secret, SESSION_TTL, smallJson, tokenFor } from '../lib/security.mjs';

export default async function session(request, context) {
  try {
    method(request, 'POST');
    sameOrigin(request);
    // Netlify supplies the trusted client IP; never trust a caller's forwarding header.
    invitationAttempt(context.ip || 'unknown');
    const data = await smallJson(request);
    const expected = secret('INVITATION_CODE', 12);
    if (typeof data.code !== 'string' || data.code.length > 256 || !equal(data.code, expected)) {
      return json({ error: 'That invitation code is not valid.' }, 401);
    }
    return json({ token: tokenFor(Math.floor(Date.now() / 1000) + SESSION_TTL), expiresIn: SESSION_TTL });
  } catch (cause) { return failure(cause); }
}

export const config = {
  path: '/api/session',
  rateLimit: { windowLimit: 8, windowSize: 180, aggregateBy: ['ip', 'domain'] },
};
