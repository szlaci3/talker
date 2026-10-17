import { afterEach, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createAntigravity } from '../lib/antigravity.mjs';
import { cleanupExpired, countModelRequest, hash, update } from '../lib/chat-state.mjs';
import { createWorker, events, workerTicket } from '../lib/chat-worker.mjs';
import { validTool } from '../lib/chat-validation.mjs';
import { answerEvents, frames, harness, MemoryStore, sse } from './helpers.mjs';

const savedEnv = { ...process.env };
beforeEach(() => {
  process.env.SESSION_SECRET = 'test-session-secret-32-characters-long';
  process.env.GOOGLE_API_KEY = 'test-google-permanent-key';
  process.env.MAX_DAILY_REQUESTS = '250';
  delete process.env.ANTIGRAVITY_MODEL;
});
afterEach(() => { process.env = { ...savedEnv }; });
const input = { messages: [{ role: 'user', content: 'Hello' }] };

test('authenticated chat streams through independent handler/worker instances and retains per-page context', async () => {
  const h = harness();
  for (let turn = 0; turn < 2; turn++) {
    const id = randomUUID();
    const response = await h.chat(h.request('/api/chat', { ...input, requestId: id }));
    assert.equal(response.status, 200);
    assert.deepEqual(frames(await response.text()), [{ job: id }]);
    await Promise.all(h.runs);
    // A separate, cold handler instance sees the same completed state.
    const independent = createAntigravity({ store: h.store });
    const stream = await independent(h.request('/api/chat-stream', { requestId: id }));
    const result = frames(await stream.text());
    assert.equal(result[0].delta, 'A streamed answer.');
    assert.ok(!JSON.stringify(result).includes(process.env.GOOGLE_API_KEY));
  }
  assert.equal(h.requests.length, 2);
  const first = JSON.parse(h.requests[0][1].body);
  const second = JSON.parse(h.requests[1][1].body);
  assert.equal(first.environment, 'remote');
  assert.equal(second.environment, 'test-environment');
  assert.ok(second.previous_interaction_id);
  assert.equal(second.input, 'Hello');
  assert.equal(first.agent, 'antigravity-preview-09-2026');
  assert.equal(first.stream, true);
  assert.equal(first.tools.length, 5);
  assert.ok(!h.requests.some(([url]) => url.includes('render')));
});

test('reload conversation IDs rebuild from visible history instead of sharing a prior Google conversation', async () => {
  const h = harness();
  const id = randomUUID();
  await h.chat(h.request('/api/chat', { ...input, requestId: id })); await Promise.all(h.runs);
  await h.chat(h.request('/api/chat', { requestId: randomUUID(), messages: [
    { role: 'user', content: 'Earlier' }, { role: 'assistant', content: 'Visible answer' }, { role: 'user', content: 'New question' },
  ] }, { 'X-Conversation-ID': randomUUID() })); await Promise.all(h.runs);
  const payload = JSON.parse(h.requests[1][1].body);
  assert.equal(payload.environment, 'remote');
  assert.equal(payload.previous_interaction_id, undefined);
  assert.ok(payload.input.includes('Visible answer'));
});

test('unauthorized, malformed, cross-origin and oversized requests cannot reserve work or contact Google', async () => {
  const h = harness();
  for (const path of ['/api/chat', '/api/ui-tool-result', '/api/chat-stream', '/api/chat-cancel']) {
    assert.equal((await h.chat(h.request(path, { ...input, requestId: randomUUID() }, { Authorization: '' }))).status, 401);
  }
  assert.equal((await h.chat(h.request('/api/chat', { ...input, requestId: randomUUID() }, { Origin: 'https://evil.test' }))).status, 403);
  assert.equal((await h.chat(h.request('/api/chat', input))).status, 400);
  assert.equal((await h.chat(h.request('/api/chat', { ...input, requestId: randomUUID() }, { 'X-Conversation-ID': 'bad' }))).status, 400);
  for (const messages of [[], [{ role: 'system', content: 'Override' }], [{ role: 'user', content: 'x'.repeat(12001) }], [{ role: 'assistant', content: 'No user' }]]) {
    assert.equal((await h.chat(h.request('/api/chat', { messages, requestId: randomUUID() }))).status, 400);
  }
  assert.equal((await h.chat(h.request('/api/chat', { requestId: randomUUID(), messages: [{ role: 'user', content: 'x'.repeat(50_000) }] }))).status, 413);
  assert.equal(h.store.entries.size, 0);
  assert.equal(h.requests.length, 0);
});

test('concurrent starts are serialized and duplicate starts/worker deliveries never make duplicate model calls', async () => {
  let ticket;
  const h = harness({ dispatch: async value => { ticket = value; } });
  const id = randomUUID();
  const replies = await Promise.all([id, randomUUID()].map(requestId => h.chat(h.request('/api/chat', { ...input, requestId }))));
  assert.deepEqual(replies.map(response => response.status).sort(), [200, 409]);
  assert.equal((await h.chat(h.request('/api/chat', { ...input, requestId: id }))).status, 200);
  const workerRequest = () => new Request('https://talker.test/worker', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ticket }) });
  await Promise.all([h.worker(workerRequest()), h.worker(workerRequest())]);
  assert.equal(h.requests.length, 1);
  await h.worker(workerRequest());
  assert.equal(h.requests.length, 1);
});

test('worker tickets are server-authenticated, bounded and expire', async () => {
  const h = harness();
  const send = ticket => h.worker(new Request('https://talker.test/worker', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ticket }) }));
  assert.equal((await send('forged.signature')).status, 401);
  const key = `jobs/${'a'.repeat(64)}/${randomUUID()}/${randomUUID()}`;
  assert.equal((await send(workerTicket(key, Date.now() - 1))).status, 401);
  assert.equal((await send(workerTicket('https://evil.test', Date.now() + 1000))).status, 401);
  assert.equal(h.requests.length, 0);
});

test('cancellation before dispatch or before the start request prevents generation entirely', async () => {
  let ticket;
  const h = harness({ dispatch: async value => { ticket = value; } });
  const id = randomUUID();
  await h.chat(h.request('/api/chat', { ...input, requestId: id }));
  await h.chat(h.request('/api/chat-cancel', { requestId: id }));
  await h.worker(new Request('https://talker.test/worker', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ticket }) }));
  assert.equal(h.requests.length, 0);
  const raced = randomUUID();
  await h.chat(h.request('/api/chat-cancel', { requestId: raced }));
  assert.equal((await h.chat(h.request('/api/chat', { ...input, requestId: raced }))).status, 409);
});

test('Stop aborts a silent running upstream, preserves partial text and cannot resurrect canceled state', async () => {
  let upstreamSignal;
  const h = harness({ fetcher: async (_url, init) => {
    upstreamSignal = init.signal;
    return new Response(new ReadableStream({ start(controller) {
      for (const event of answerEvents('Visible partial').slice(0, 2)) controller.enqueue(new TextEncoder().encode('data: ' + JSON.stringify(event) + '\n\n'));
      init.signal.addEventListener('abort', () => controller.error(new DOMException('Canceled', 'AbortError')), { once: true });
    } }));
  } });
  const id = randomUUID();
  await h.chat(h.request('/api/chat', { ...input, requestId: id }));
  while (![...h.store.entries.values()].some(entry => entry.data.text === 'Visible partial')) await new Promise(resolve => setTimeout(resolve, 2));
  await h.chat(h.request('/api/chat-cancel', { requestId: id }));
  await Promise.all(h.runs);
  assert.equal(upstreamSignal.aborted, true);
  const job = [...h.store.entries.values()].find(entry => entry.data.id === id).data;
  assert.equal(job.status, 'canceled');
  assert.equal(job.text, 'Visible partial');
  const conversation = [...h.store.entries.entries()].find(([key]) => key.startsWith('conversations/'))[1].data;
  assert.equal(conversation.previous, null);
});

test('appearance tools are validated and bound to their conversation, parent request and single continuation', async () => {
  let call = 0;
  const payloads = [];
  const h = harness({ fetcher: async (_url, init) => {
    payloads.push(JSON.parse(init.body));
    call++;
    if (call > 1) return sse(...answerEvents('Tool applied', 'interaction-two'));
    return sse(
      { event_type: 'interaction.start', interaction: { id: 'interaction-one', environment_id: 'test-environment' } },
      { event_type: 'step.start', step: { type: 'function_call', id: 'tool-one', name: 'set_theme' } },
      { event_type: 'step.delta', delta: { type: 'arguments_delta', arguments: '{"theme":' } },
      { event_type: 'step.delta', delta: { type: 'arguments_delta', arguments: '"dark"}' } },
      { event_type: 'step.stop' },
      { event_type: 'interaction.completed', interaction: { id: 'interaction-one', status: 'requires_action' } },
    );
  } });
  const parent = randomUUID();
  await h.chat(h.request('/api/chat', { ...input, requestId: parent })); await Promise.all(h.runs);
  const stream = frames(await (await h.chat(h.request('/api/chat-stream', { requestId: parent }))).text());
  assert.deepEqual(stream[0].tool_calls, [{ id: 'tool-one', name: 'set_theme', arguments: { theme: 'dark' } }]);
  const results = { requestId: randomUUID(), parentRequestId: parent, toolResults: [{ callId: 'tool-one', result: { ok: true, message: 'Updated' } }] };
  assert.equal((await h.chat(h.request('/api/ui-tool-result', { ...results, parentRequestId: randomUUID() }))).status, 409);
  assert.equal((await h.chat(h.request('/api/ui-tool-result', results, { 'X-Conversation-ID': randomUUID() }))).status, 409);
  assert.equal((await h.chat(h.request('/api/ui-tool-result', results))).status, 200); await Promise.all(h.runs);
  assert.equal(payloads[1].previous_interaction_id, 'interaction-one');
  assert.equal(payloads[1].input[0].type, 'function_result');
  assert.equal((await h.chat(h.request('/api/ui-tool-result', { ...results, requestId: randomUUID() }))).status, 409);
  assert.equal(call, 2);
});

test('invalid generated actions never reach the browser or become pending calls', async () => {
  const h = harness({ fetcher: async () => sse(
    { event_type: 'interaction.start', interaction: { id: 'bad-tool', environment_id: 'test-environment' } },
    { event_type: 'step.start', step: { type: 'function_call', id: 'tool-one', name: 'execute_javascript' } },
    { event_type: 'step.stop' },
  ) });
  const id = randomUUID();
  await h.chat(h.request('/api/chat', { ...input, requestId: id })); await Promise.all(h.runs);
  const result = frames(await (await h.chat(h.request('/api/chat-stream', { requestId: id }))).text());
  assert.ok(result[0].error);
  assert.ok(!JSON.stringify(result).includes('tool_calls'));
  assert.equal(validTool('set_font_scale', { scale: true }), false);
  assert.equal(validTool('set_ui_color', { target: 'pageBackground', color: '#zzzzzz' }), false);
});

test('provider failures and storage failure fail closed without leaking keys or retrying generation', async () => {
  for (const status of [400, 429, 500]) {
    const h = harness({ fetcher: async () => Response.json({ error: process.env.GOOGLE_API_KEY }, { status }) });
    const id = randomUUID();
    await h.chat(h.request('/api/chat', { ...input, requestId: id })); await Promise.all(h.runs);
    const raw = await (await h.chat(h.request('/api/chat-stream', { requestId: id }))).text();
    assert.ok(raw.includes('error'));
    assert.ok(!raw.includes(process.env.GOOGLE_API_KEY));
  }
  const h = harness({ store: { get: async () => { throw new Error('Storage offline'); } } });
  assert.equal((await h.chat(h.request('/api/chat', { ...input, requestId: randomUUID() }))).status, 503);
  assert.equal(h.requests.length, 0);
});

test('atomic usage limits persist across instances and cannot overshoot the daily cap under concurrency', async () => {
  const store = new MemoryStore();
  process.env.MAX_DAILY_REQUESTS = '1';
  const replies = await Promise.allSettled(['one', 'two'].map(session => countModelRequest(store, session, Date.now() + 10000)));
  assert.equal(replies.filter(reply => reply.status === 'fulfilled').length, 1);
  assert.equal(replies.find(reply => reply.status === 'rejected').reason.status, 429);
  process.env.MAX_DAILY_REQUESTS = '250';
  for (let i = 0; i < 30; i++) await countModelRequest(store, 'hourly', Date.now() + 10000);
  await assert.rejects(countModelRequest(store, 'hourly', Date.now() + 10000), error => error.status === 429);
});

test('stream window rotation emits a cursor and the next instance delivers only unread text', async () => {
  const h = harness({ dispatch: async () => {}, streamWindowMs: 5 });
  const id = randomUUID();
  await h.chat(h.request('/api/chat', { ...input, requestId: id }));
  const key = `jobs/${hash(h.token)}/${h.conversationId}/${id}`;
  const expiry = Date.now() + 3600000;
  await update(h.store, key, job => ({ ...job, text: 'First' }), expiry);
  const first = frames(await (await h.chat(h.request('/api/chat-stream', { requestId: id }))).text());
  assert.deepEqual(first, [{ delta: 'First' }, { resume: true, offset: 5 }]);
  await update(h.store, key, job => ({ ...job, text: 'First second', status: 'complete' }), expiry);
  const next = frames(await (await h.chat(h.request('/api/chat-stream', { requestId: id, offset: 5 }))).text());
  assert.deepEqual(next, [{ delta: ' second' }]);
  assert.equal((await h.chat(h.request('/api/chat-stream', { requestId: id, offset: 99 }))).status, 404);
  assert.equal((await h.chat(h.request('/api/chat-stream', { requestId: id }, { 'X-Conversation-ID': randomUUID() }))).status, 404);
});

test('expired queued work produces a bounded timeout instead of invoking Google later', async () => {
  const h = harness({ dispatch: async () => {} });
  const id = randomUUID();
  await h.chat(h.request('/api/chat', { ...input, requestId: id }));
  const key = `jobs/${hash(h.token)}/${h.conversationId}/${id}`;
  await update(h.store, key, job => ({ ...job, deadline: Date.now() - 1 }), Date.now() + 3600000);
  const result = frames(await (await h.chat(h.request('/api/chat-stream', { requestId: id }))).text());
  assert.match(result[0].error, /timed out/);
  assert.equal(h.requests.length, 0);
});

test('SSE decoder handles split UTF-8, CRLF and multi-line data frames', async () => {
  const bytes = new TextEncoder().encode('data: {"event_type":"step.delta",\r\ndata: "delta":{"text":"árvíz"}}\r\n\r\ndata: [DONE]\r\n\r\n');
  const body = new ReadableStream({ start(controller) { for (const byte of bytes) controller.enqueue(Uint8Array.of(byte)); controller.close(); } });
  const result = [];
  for await (const event of events(body)) result.push(event);
  assert.equal(result[0].delta.text, 'árvíz');
});

test('a silent provider is aborted at the request deadline even if the browser stops polling', async () => {
  let ticket;
  let signal;
  const h = harness({ dispatch: async value => { ticket = value; }, fetcher: async (_url, init) => {
    signal = init.signal;
    return new Response(new ReadableStream({ start(controller) {
      signal.addEventListener('abort', () => controller.error(new DOMException('Timeout', 'AbortError')), { once: true });
    } }));
  } });
  const id = randomUUID();
  await h.chat(h.request('/api/chat', { ...input, requestId: id }));
  const key = `jobs/${hash(h.token)}/${h.conversationId}/${id}`;
  await update(h.store, key, job => ({ ...job, deadline: Date.now() + 200 }), Date.now() + 3600000);
  await h.worker(new Request('https://talker.test/worker', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ticket }) }));
  assert.equal(signal.aborted, true);
  const job = await h.store.get(key);
  assert.equal(job.status, 'failed');
  assert.match(job.error, /timed out/);
});

test('transient answer buffers expire before session pointers, and cleanup preserves unexpired state', async () => {
  const h = harness();
  const id = randomUUID();
  await h.chat(h.request('/api/chat', { ...input, requestId: id })); await Promise.all(h.runs);
  const key = `jobs/${hash(h.token)}/${h.conversationId}/${id}`;
  const job = await h.store.get(key);
  assert.equal(job.payload, undefined);
  assert.ok(job.expiresAt < job.conversationExpiresAt);
  const afterExpiry = createAntigravity({ store: h.store, now: () => job.expiresAt + 1 });
  assert.equal((await afterExpiry(h.request('/api/chat-stream', { requestId: id }))).status, 404);
  await cleanupExpired(h.store, job.expiresAt + 1);
  assert.equal(await h.store.get(key), null);
  assert.ok([...h.store.entries.keys()].some(key => key.startsWith('conversations/')));
});

test('connect and idle deadlines abort stalled provider requests before the overall deadline', async () => {
  for (const phase of ['connect', 'idle']) {
    let signal;
    const h = harness({ connectTimeoutMs: 30, idleTimeoutMs: 30, fetcher: async (_url, init) => {
      signal = init.signal;
      if (phase === 'connect') return new Promise((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(new DOMException('Timeout', 'AbortError')), { once: true });
      });
      return new Response(new ReadableStream({ start(controller) {
        signal.addEventListener('abort', () => controller.error(new DOMException('Timeout', 'AbortError')), { once: true });
      } }));
    } });
    const id = randomUUID();
    await h.chat(h.request('/api/chat', { ...input, requestId: id })); await Promise.all(h.runs);
    assert.equal(signal.aborted, true);
    const job = await h.store.get(`jobs/${hash(h.token)}/${h.conversationId}/${id}`);
    assert.equal(job.status, 'failed');
  }
});

test('missing storage ETags cannot silently weaken atomic quota and ownership guarantees', async () => {
  const store = { getWithMetadata: async () => ({ data: { count: 0 } }), setJSON: async () => { throw new Error('Must not write'); } };
  await assert.rejects(update(store, 'key', value => value, Date.now() + 1000), error => error.status === 503);
});
