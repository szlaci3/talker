import { authenticated, failure, json, method, sameOrigin, secret, smallJson } from './security.mjs';
import { countModelRequest, hash, read, update, UUID } from './chat-state.mjs';
import { messages, toolResults } from './chat-validation.mjs';
import { terminal, workerTicket } from './chat-worker.mjs';

export const CHAT_PATHS = ['/api/chat', '/api/ui-tool-result', '/api/chat-stream', '/api/chat-cancel'];
export const STORE_NAME = 'talker-antigravity-v1';
const encoder = new TextEncoder();
const frame = event => encoder.encode('data: ' + JSON.stringify(event) + '\n\n');

export function createAntigravity({ store, fetcher = globalThis.fetch, now = Date.now, dispatch,
  streamWindowMs = 20_000, pollMs = 750 }) {
  async function failJob(key, conversationKey, id, expiresAt, error, status = 'failed') {
    const jobExpiresAt = Math.min((await read(store, key))?.expiresAt || expiresAt, now() + 900_000);
    await update(store, key, current => ({ ...(current || { id, text: '', conversationKey, expiresAt: jobExpiresAt }),
      status, error, payload: null }), jobExpiresAt);
    await update(store, conversationKey, state => {
      const canceled = [...new Set([...(state?.canceled || []), id])].slice(-8);
      return { ...state, canceled, ...(state?.active === id || (!state?.active && (state?.pending?.requestId === id || state?.lastRequestId === id))
        ? { active: null, previous: null, pending: null } : {}) };
    }, expiresAt);
  }

  return async function chat(request) {
    let identity;
    let created = false;
    try {
      method(request, 'POST'); sameOrigin(request);
      const token = authenticated(request);
      const conversationId = request.headers.get('X-Conversation-ID') || '';
      if (!UUID.test(conversationId)) throw json({ error: 'A valid conversation ID is required.' }, 400);
      const path = new URL(request.url).pathname;
      if (!CHAT_PATHS.includes(path)) throw json({ error: 'Not found.' }, 404);
      const data = await smallJson(request, 48_000);
      if (typeof data.requestId !== 'string' || !UUID.test(data.requestId)) throw json({ error: 'A valid request ID is required.' }, 400);
      const sessionKey = hash(token);
      const sessionExpiry = Number(Buffer.from(token, 'base64url').toString('ascii').split('.')[0]) * 1000;
      const expiresAt = sessionExpiry + 600_000;
      const conversationKey = `conversations/${sessionKey}/${conversationId}`;
      const key = `jobs/${sessionKey}/${conversationId}/${data.requestId}`;
      identity = { key, conversationKey, id: data.requestId, expiresAt };

      if (path === '/api/chat-cancel') {
        // Tombstone even a not-yet-created job, covering Stop racing with POST.
        await failJob(key, conversationKey, data.requestId, expiresAt, 'Request canceled.', 'canceled');
        return json({ ok: true });
      }
      if (path === '/api/chat-stream') {
        const offset = data.offset ?? 0;
        if (!Number.isInteger(offset) || offset < 0 || offset > 24_000) throw json({ error: 'Invalid stream position.' }, 400);
        const job = await read(store, key);
        if (!job || job.expiresAt <= now() || offset > job.text.length) throw json({ error: 'The chat request is unavailable.' }, 404);
        const stop = new AbortController();
        const body = new ReadableStream({
          async start(controller) {
            const until = now() + streamWindowMs;
            let position = offset;
            try {
              while (!stop.signal.aborted && !request.signal.aborted) {
                const current = await read(store, key);
                if (!current) throw new Error('Unavailable');
                if (!terminal(current.status) && current.deadline <= now()) {
                  await failJob(key, conversationKey, data.requestId, expiresAt, 'The chat request timed out. Please try again.');
                  continue;
                }
                if (current.text.length > position) {
                  controller.enqueue(frame({ delta: current.text.slice(position) }));
                  position = current.text.length;
                }
                if (terminal(current.status)) {
                  if (current.status === 'requires_action') controller.enqueue(frame({ tool_calls: current.calls }));
                  else if (current.status !== 'complete') controller.enqueue(frame({ error: current.error || 'The chat request ended.' }));
                  controller.enqueue(encoder.encode('data: [DONE]\n\n'));
                  return;
                }
                if (now() >= until) { controller.enqueue(frame({ resume: true, offset: position })); return; }
                await new Promise(resolve => {
                  const finish = () => { clearTimeout(timer); stop.signal.removeEventListener('abort', finish); resolve(); };
                  const timer = setTimeout(finish, pollMs);
                  stop.signal.addEventListener('abort', finish, { once: true });
                });
              }
            } catch {
              if (!stop.signal.aborted && !request.signal.aborted) controller.enqueue(frame({ error: 'The chat connection ended unexpectedly. Please try again.' }));
            } finally { if (!stop.signal.aborted) controller.close(); }
          },
          cancel() { stop.abort(); },
        });
        return new Response(body, { headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'private, no-store, no-transform', 'X-Content-Type-Options': 'nosniff' } });
      }

      secret('GOOGLE_API_KEY', 12);
      // Validate before reserving work; state and provider cursors stay server-side.
      const clean = path === '/api/chat' ? messages(data) : null;
      const duplicate = await read(store, key);
      if (duplicate) {
        if (duplicate.status === 'canceled') throw json({ error: 'Request canceled.' }, 409);
        return new Response(frame({ job: data.requestId }), { headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store' } });
      }
      const state = await update(store, conversationKey, current => {
        if (current?.canceled?.includes(data.requestId)) throw json({ error: 'Request canceled.' }, 409);
        if (current?.active) throw json({ error: 'A chat request is already running. Please stop it first.' }, 409);
        if (path === '/api/ui-tool-result') {
          toolResults(data, current?.pending);
          if ((current.pending.depth || 0) >= 2) throw json({ error: 'The assistant requested too many UI changes in one response.' }, 400);
        }
        return { ...current, active: data.requestId };
      }, expiresAt);
      created = true;
      const previous = path === '/api/ui-tool-result' || !state.pending ? state.previous : null;
      const input = clean ? (previous ? clean.at(-1).content
        : clean.map(item => `${item.role === 'assistant' ? 'Assistant' : 'User'}: ${item.content}`).join('\n'))
        : toolResults(data, state.pending);
      const payload = { input, environment: previous?.environmentId || 'remote',
        ...(previous ? { previous_interaction_id: previous.interactionId } : {}) };
      await countModelRequest(store, sessionKey, expiresAt, now());
      const job = { id: data.requestId, conversationKey, conversationExpiresAt: expiresAt,
        expiresAt: Math.min(expiresAt, now() + 900_000), deadline: now() + 180_000,
        depth: path === '/api/ui-tool-result' ? (state.pending.depth || 0) + 1 : 0,
        status: 'queued', text: '', calls: [], payload };
      const result = await store.setJSON(key, job, { onlyIfNew: true, metadata: { expiresAt: job.expiresAt } });
      if (!result.modified) throw json({ error: 'Request canceled or already started.' }, 409);
      const ticket = workerTicket(key, now() + 240_000);
      if (dispatch) await dispatch(ticket);
      else {
        const accepted = await fetcher(new URL('/.netlify/functions/antigravity-worker', request.url), {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ticket }), signal: AbortSignal.timeout(10_000),
        });
        if (accepted.status !== 202) throw new Error('Worker unavailable');
      }
      return new Response(frame({ job: data.requestId }), { headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'private, no-store' } });
    } catch (cause) {
      if (created && identity) {
        await failJob(identity.key, identity.conversationKey, identity.id, identity.expiresAt,
          'The chat request could not start. Please try again.').catch(() => {});
      }
      return failure(cause);
    }
  };
}

export async function antigravityRoute(request) {
  const { getStore } = await import('@netlify/blobs');
  return createAntigravity({ store: getStore({ name: STORE_NAME, consistency: 'strong' }) })(request);
}
