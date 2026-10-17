import { afterEach, beforeEach, test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import session, { config as sessionConfig } from '../functions/session.mjs';
import liveAccess, { config as liveConfig } from '../functions/live-access.mjs';
import { tokenFor, SESSION_TTL } from '../lib/security.mjs';
import { liveTokenPayload } from '../lib/live.mjs';

const site = 'https://talker.example';
const signingSecret = 'test-signing-secret-32-characters-long';
let client = 0;
const savedEnv = { ...process.env };
beforeEach(() => {
  process.env.INVITATION_CODE = 'test-invitation-code';
  process.env.SESSION_SECRET = signingSecret;
  process.env.GOOGLE_API_KEY = 'test-permanent-google-key';
  process.env.DIALOG_FREE_TIER_CONFIRMED = 'true';
  delete process.env.DIALOG_MODEL;
});
afterEach(() => { mock.restoreAll(); process.env = { ...savedEnv }; });

const credential = () => tokenFor(Math.floor(Date.now() / 1000) + SESSION_TTL);
const request = (path, token = credential(), init = {}) => new Request(site + path, {
  method: path === '/api/session/check' ? 'GET' : 'POST',
  headers: { Authorization: 'Bearer ' + token, Origin: site, 'Content-Type': 'application/json' },
  ...init,
});
const enter = (code = 'test-invitation-code', ip = `test-client-${++client}`, init = {}) => session(
  request('/api/session', '', { body: JSON.stringify({ code }), ...init }), { ip },
);

test('gate validates the invitation, issues an expiring session, and disables caching', async () => {
  const invalid = await enter('wrong');
  assert.equal(invalid.status, 401);
  assert.equal((await enter(null)).status, 401);
  const response = await enter();
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('Cache-Control'), 'private, no-store');
  const body = await response.json();
  assert.equal(body.expiresIn, SESSION_TTL);
  assert.equal((await liveAccess(request('/api/session/check', body.token))).status, 200);
  assert.ok(!JSON.stringify(body).includes(process.env.INVITATION_CODE));
  assert.ok(!JSON.stringify(body).includes(signingSecret));
});

test('Netlify sessions have exactly the existing Python/Render wire format', () => {
  // Standalone stdlib verifier: no .env, server import, network, or real credentials.
  const expiry = Math.floor(Date.now() / 1000) + SESSION_TTL;
  const result = spawnSync('python', ['-c', [
    'import base64,hashlib,hmac,json,sys',
    'expiry,secret,token=json.load(sys.stdin)',
    'payload,signature=base64.urlsafe_b64decode(token+"="*(-len(token)%4)).split(b".",1)',
    'assert int(payload)==expiry',
    'assert hmac.compare_digest(signature,hmac.new(secret.encode(),payload,hashlib.sha256).digest())',
    'print(base64.urlsafe_b64encode(str(expiry).encode()+b"."+signature).decode().rstrip("="))',
  ].join('\n')], { input: JSON.stringify([expiry, signingSecret, tokenFor(expiry)]), encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), tokenFor(expiry));
});

test('missing, expired, malformed and tampered sessions cannot obtain either token or session check', async () => {
  const provider = mock.method(globalThis, 'fetch', async () => { throw new Error('must not call Google'); });
  for (const token of ['', 'invalid', 'a'.repeat(1000), tokenFor(1), credential().slice(0, -4) + 'abcd']) {
    for (const path of ['/api/dialog-token', '/api/live-token', '/api/session/check']) {
      assert.equal((await liveAccess(request(path, token))).status, 401);
    }
  }
  assert.equal(provider.mock.callCount(), 0);
});

test('origin, method, JSON type and streaming size validation fail closed', async () => {
  assert.equal((await enter(undefined, undefined, { headers: { Origin: 'https://evil.example' } })).status, 403);
  assert.equal((await enter(undefined, undefined, { method: 'PUT' })).status, 405);
  assert.equal((await enter(undefined, undefined, { body: '[]' })).status, 400);
  assert.equal((await enter(undefined, undefined, { body: 'not json' })).status, 400);
  assert.equal((await enter(undefined, undefined, { body: JSON.stringify({ code: 'x'.repeat(3000) }) })).status, 413);
  assert.equal((await liveAccess(request('/api/dialog-token', credential(), { method: 'GET' }))).status, 405);
  assert.equal((await liveAccess(request('/api/unknown'))).status, 404);
});

test('original process-local invitation limiter rejects attempt nine, with deployed platform rules as well', async () => {
  const ip = `limited-client-${++client}`;
  for (let i = 0; i < 8; i++) assert.equal((await enter('wrong', ip)).status, 401);
  assert.equal((await enter(undefined, ip)).status, 429);
  assert.deepEqual(sessionConfig.rateLimit, { windowLimit: 8, windowSize: 180, aggregateBy: ['ip', 'domain'] });
  assert.deepEqual(liveConfig.rateLimit, { windowLimit: 30, windowSize: 180, aggregateBy: ['ip', 'domain'] });
  // These assertions check configuration, not Netlify's deployed enforcement.
});

test('token issuance locks both configurations, keeps permanent credentials server-side, and ignores client overrides', async () => {
  const calls = [];
  mock.method(globalThis, 'fetch', async (url, init) => {
    calls.push([url, init]);
    return Response.json({ name: 'auth_tokens/test-ephemeral-token' });
  });
  for (const path of ['/api/dialog-token', '/api/live-token']) {
    const response = await liveAccess(request(path, credential(), { body: JSON.stringify({ model: 'evil', uses: 99 }) }));
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.token, 'auth_tokens/test-ephemeral-token');
    assert.ok(!JSON.stringify(body).includes(process.env.GOOGLE_API_KEY));
    const [url, init] = calls.at(-1);
    assert.equal(url, 'https://generativelanguage.googleapis.com/v1beta/auth_tokens');
    assert.equal(init.headers['x-goog-api-key'], process.env.GOOGLE_API_KEY);
    const payload = JSON.parse(init.body);
    assert.equal(payload.uses, 1);
    const remaining = Date.parse(payload.newSessionExpireTime) - Date.now();
    assert.ok(remaining > 50_000 && remaining <= 60_000);
    assert.ok(Date.parse(payload.expireTime) - Date.now() <= 1_800_000);
    const setup = payload.bidiGenerateContentSetup;
    assert.deepEqual(payload.fieldMask.split(','), Object.keys(setup));
    if (path === '/api/dialog-token') {
      assert.deepEqual(body.setup, setup);
      assert.equal(setup.model, 'models/gemini-2.5-flash-native-audio-preview-12-2025');
      assert.equal(setup.generationConfig.speechConfig.voiceConfig.prebuiltVoiceConfig.voiceName, 'Aoede');
      assert.ok(setup.inputAudioTranscription && setup.outputAudioTranscription);
      assert.equal(setup.tools[0].functionDeclarations.length, 5);
    } else {
      assert.equal(setup.model, 'models/gemini-3.5-transcribe-live');
      assert.deepEqual(setup.generationConfig.responseModalities, ['TEXT']);
    }
    assert.ok(!payload.fieldMask.includes('sessionResumption'));
  }
});

test('Netlify tool declarations stay identical to the existing backend', () => {
  const result = spawnSync('python', ['-c', [
    'import ast,json,sys',
    'module=ast.parse(sys.stdin.read())',
    'tools=next(ast.literal_eval(n.value) for n in module.body if isinstance(n,ast.Assign) and any(isinstance(t,ast.Name) and t.id=="UI_TOOLS" for t in n.targets))',
    'print(json.dumps(tools))',
  ].join('\n')], { input: readFileSync(new URL('../../../backend/server.py', import.meta.url).pathname.replace(/^\/(\w:)/, '$1'), 'utf8'), encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(liveTokenPayload(true).bidiGenerateContentSetup.tools[0].functionDeclarations,
    JSON.parse(result.stdout).map(tool => ({ name: tool.name, description: tool.description, parametersJsonSchema: tool.parameters })));
});

test('missing secrets, unconfirmed billing and unsupported models do not call Google', async () => {
  const provider = mock.method(globalThis, 'fetch', async () => { throw new Error(); });
  process.env.DIALOG_FREE_TIER_CONFIRMED = 'false';
  assert.equal((await liveAccess(request('/api/dialog-token'))).status, 503);
  process.env.DIALOG_FREE_TIER_CONFIRMED = 'true';
  process.env.DIALOG_MODEL = 'unsupported';
  assert.equal((await liveAccess(request('/api/dialog-token'))).status, 503);
  delete process.env.GOOGLE_API_KEY;
  assert.equal((await liveAccess(request('/api/live-token'))).status, 503);
  delete process.env.SESSION_SECRET;
  assert.equal((await enter()).status, 503);
  assert.equal(provider.mock.callCount(), 0);
});

test('provider failures, malformed responses and timeouts return bounded errors without echoing secrets', async () => {
  for (const status of [400, 429, 500]) {
    const provider = mock.method(globalThis, 'fetch', async () => Response.json({ error: { message: process.env.GOOGLE_API_KEY } }, { status }));
    const response = await liveAccess(request('/api/dialog-token'));
    assert.equal(response.status, status === 429 ? 429 : 502);
    assert.ok(!(await response.text()).includes(process.env.GOOGLE_API_KEY));
    provider.mock.restore();
  }
  for (const implementation of [async () => Response.json({}), async () => { throw new Error('timeout'); }]) {
    const provider = mock.method(globalThis, 'fetch', implementation);
    assert.equal((await liveAccess(request('/api/dialog-token'))).status, 502);
    provider.mock.restore();
  }
});
