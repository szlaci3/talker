import { createHmac, randomUUID } from 'node:crypto';
import { equal, failure, json, method, secret, smallJson } from './security.mjs';
import { read, update } from './chat-state.mjs';
import { SYSTEM_INSTRUCTION, tools, validTool } from './chat-validation.mjs';

export const INTERACTIONS = 'https://generativelanguage.googleapis.com/v1beta/interactions';
const terminal = status => ['complete', 'requires_action', 'failed', 'canceled'].includes(status);
export { terminal };

function signature(payload) {
  return createHmac('sha256', secret('SESSION_SECRET', 32)).update('talker-chat-worker-v1\0' + payload).digest('base64url');
}

export function workerTicket(key, expiresAt) {
  const payload = Buffer.from(JSON.stringify({ key, expiresAt })).toString('base64url');
  return payload + '.' + signature(payload);
}

function ticketKey(ticket, now) {
  if (typeof ticket !== 'string' || ticket.length > 1200) throw json({ error: 'Unauthorized worker request.' }, 401);
  const [payload, supplied, extra] = ticket.split('.');
  if (!payload || !supplied || extra || !equal(supplied, signature(payload))) throw json({ error: 'Unauthorized worker request.' }, 401);
  let data;
  try { data = JSON.parse(Buffer.from(payload, 'base64url').toString()); } catch { throw json({ error: 'Unauthorized worker request.' }, 401); }
  if (typeof data.key !== 'string' || !/^jobs\/[a-f0-9]{64}\/[0-9a-f-]{36}\/[0-9a-f-]{36}$/i.test(data.key)
      || !Number.isFinite(data.expiresAt) || data.expiresAt <= now || data.expiresAt > now + 300_000) {
    throw json({ error: 'Unauthorized worker request.' }, 401);
  }
  return data.key;
}

// Parse complete SSE frames, independent of TCP chunk boundaries and CRLF.
export async function* events(body) {
  if (!body) throw new Error('Provider stream is unavailable.');
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let data = [];
  try {
    while (true) {
      const { done, value } = await reader.read();
      buffer += done ? decoder.decode() : decoder.decode(value, { stream: true });
      if (buffer.length > 128_000) throw new Error('Provider event is too large.');
      let newline;
      while ((newline = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, newline).replace(/\r$/, '');
        buffer = buffer.slice(newline + 1);
        if (line.startsWith('data:')) data.push(line.slice(5).trimStart());
        else if (!line && data.length) {
          const raw = data.join('\n'); data = [];
          if (raw === '[DONE]') return;
          yield JSON.parse(raw);
        }
        if (data.join('').length > 128_000) throw new Error('Provider event is too large.');
      }
      if (done) {
        if (buffer.startsWith('data:')) data.push(buffer.slice(5).trimStart());
        if (data.length && data.join('\n') !== '[DONE]') yield JSON.parse(data.join('\n'));
        return;
      }
    }
  } finally { await reader.cancel().catch(() => {}); }
}

export function createWorker({ store, fetcher = globalThis.fetch, now = Date.now, beforeModelRequest = async () => {}, pollMs = 1000,
  connectTimeoutMs = 10_000, idleTimeoutMs = 90_000 }) {
  return async function worker(request) {
    let key;
    let runId;
    let job;
    let timer;
    let monitor;
    let connectTimer;
    let idleTimer;
    const abort = new AbortController();
    try {
      method(request, 'POST');
      key = ticketKey((await smallJson(request)).ticket, now());
      const existing = await read(store, key);
      if (!existing || existing.status !== 'queued') return json({ ok: true });
      runId = randomUUID();
      job = await update(store, key, current => {
        if (current?.status !== 'queued' || current.deadline <= now()) throw json({ error: 'Worker already claimed or expired.' }, 409);
        const claimed = { ...current, status: 'running', runId };
        delete claimed.payload;
        return claimed;
      }, existing.expiresAt);
      const payload = existing.payload;
      timer = setTimeout(() => abort.abort(), Math.max(1, job.deadline - now()));
      // Cancellation also works during provider silence; never depend on tab lifetime.
      let checking = false;
      monitor = setInterval(async () => {
        if (checking) return;
        checking = true;
        try {
          const current = await read(store, key);
          if (!current || current.status !== 'running' || current.runId !== runId) abort.abort();
        } catch { abort.abort(); }
        finally { checking = false; }
      }, pollMs);
      const apiKey = secret('GOOGLE_API_KEY', 12);
      const agent = process.env.ANTIGRAVITY_AGENT || 'antigravity-preview-09-2026';
      const model = (process.env.ANTIGRAVITY_MODEL || '').trim();
      await beforeModelRequest();
      if (abort.signal.aborted) throw new Error('Canceled');
      connectTimer = setTimeout(() => abort.abort(), connectTimeoutMs);
      const upstream = await fetcher(INTERACTIONS, {
        method: 'POST', signal: abort.signal,
        headers: { 'x-goog-api-key': apiKey, 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...payload, agent, stream: true, tools, system_instruction: SYSTEM_INSTRUCTION,
          ...(model ? { agent_config: { type: 'antigravity', model } } : {}) }),
      });
      clearTimeout(connectTimer);
      if (!upstream.ok) {
        await upstream.body?.cancel();
        throw new Error(upstream.status === 429 ? 'The Antigravity quota is exhausted.' : `Antigravity request failed (HTTP ${upstream.status}). Check API access and agent configuration.`);
      }
      let interactionId;
      let environmentId = payload.environment === 'remote' ? null : payload.environment;
      let status;
      let activeCall;
      const calls = [];
      let text = '';
      let flushed = '';
      let flushedAt = 0;
      const seen = new Set();
      idleTimer = setTimeout(() => abort.abort(), idleTimeoutMs);
      for await (const event of events(upstream.body)) {
        if (abort.signal.aborted) throw new Error('Canceled');
        clearTimeout(idleTimer);
        idleTimer = setTimeout(() => abort.abort(), idleTimeoutMs);
        if (event.event_id) {
          if (seen.has(event.event_id)) continue;
          seen.add(event.event_id);
          if (seen.size > 10_000) throw new Error('The assistant returned too many events.');
        }
        const type = event.event_type || event.type;
        const interaction = event.interaction || {};
        if (typeof interaction.id === 'string') interactionId = interaction.id;
        if (typeof interaction.environment_id === 'string') environmentId = interaction.environment_id;
        if (type === 'step.start' && event.step?.type === 'function_call') {
          if (activeCall) throw new Error('The assistant returned overlapping UI actions.');
          activeCall = { id: event.step.id, name: event.step.name, arguments: '' };
        } else if (type === 'step.delta') {
          const delta = event.delta || {};
          if (delta.type === 'text' && typeof delta.text === 'string') {
            text += delta.text;
            if (text.length > 24_000) throw new Error('The answer exceeded the response size limit.');
            if (!flushed || now() - flushedAt >= 400 || text.length - flushed.length >= 512) {
              await update(store, key, current => {
                if (current?.status !== 'running' || current.runId !== runId) throw new Error('Canceled');
                return { ...current, text };
              }, job.expiresAt);
              flushed = text; flushedAt = now();
            }
          } else if (delta.type === 'arguments_delta' && activeCall && typeof delta.arguments === 'string') {
            activeCall.arguments += delta.arguments;
            if (activeCall.arguments.length > 4096) throw new Error('The assistant returned an oversized UI action.');
          }
        } else if (type === 'step.stop' && activeCall) {
          let args;
          try { args = JSON.parse(activeCall.arguments || '{}'); } catch { throw new Error('The assistant requested an invalid UI action.'); }
          if (typeof activeCall.id !== 'string' || !activeCall.id || activeCall.id.length > 512 || !validTool(activeCall.name, args)
              || calls.length >= 4 || calls.some(call => call.id === activeCall.id)) throw new Error('The assistant requested an invalid UI action.');
          calls.push({ ...activeCall, arguments: args }); activeCall = null;
        } else if (type === 'interaction.completed' || type === 'interaction.status_update') {
          const next = interaction.status || event.status || (type === 'interaction.completed' ? 'completed' : null);
          if (['completed', 'requires_action'].includes(next)) { status = next; break; }
          if (['failed', 'cancelled', 'canceled', 'incomplete'].includes(next)) throw new Error('Antigravity could not complete this response. Check API access and quota.');
        } else if (type === 'interaction.failed' || type === 'error') {
          throw new Error('Antigravity could not complete this response. Check API access and quota.');
        }
      }
      if (!status || activeCall || !interactionId || interactionId.length > 2048) throw new Error('Antigravity did not return complete conversation state. Please try again.');
      if (!environmentId) {
        const detail = await fetcher(`${INTERACTIONS}/${encodeURIComponent(interactionId)}`, {
          headers: { 'x-goog-api-key': apiKey }, signal: AbortSignal.any([abort.signal, AbortSignal.timeout(15_000)]),
        });
        if (!detail.ok) { await detail.body?.cancel(); throw new Error('Antigravity conversation state is unavailable.'); }
        environmentId = (await detail.json()).environment_id;
      }
      if (typeof environmentId !== 'string' || !environmentId || environmentId.length > 2048
          || (status === 'requires_action' && !calls.length) || (status === 'completed' && calls.length)) {
        throw new Error('Antigravity requested an unsupported UI action or returned incomplete state.');
      }
      const previous = { interactionId, environmentId };
      await update(store, job.conversationKey, state => {
        if (state?.active !== job.id) throw new Error('Canceled');
        return { ...state, active: null, previous, lastRequestId: job.id,
          pending: status === 'requires_action' ? { requestId: job.id, calls, depth: job.depth } : null };
      }, job.conversationExpiresAt);
      await update(store, key, current => {
        if (current?.status !== 'running' || current.runId !== runId) throw new Error('Canceled');
        return { ...current, text, status: status === 'completed' ? 'complete' : 'requires_action', calls };
      }, job.expiresAt);
      return json({ ok: true });
    } catch (cause) {
      abort.abort();
      if (job && key && runId) {
        // Never echo arbitrary provider errors, bodies, or credentials.
        const safeMessages = /^(The Antigravity quota|Antigravity request failed \(HTTP \d+\)|The answer exceeded|The assistant returned|The assistant requested|Antigravity could not|Antigravity did not|Antigravity conversation state|Antigravity requested)/;
        const error = now() >= job.deadline ? 'The chat request timed out. Please try again.'
          : cause instanceof Error && safeMessages.test(cause.message) ? cause.message : 'The chat connection ended unexpectedly. Please try again.';
        await update(store, key, current => current?.status === 'running' && current.runId === runId
          ? { ...current, status: 'failed', error } : current, job.expiresAt).catch(() => {});
        await update(store, job.conversationKey, state => state?.active === job.id
          ? { ...state, active: null, previous: null, pending: null } : state, job.conversationExpiresAt).catch(() => {});
      }
      return failure(cause);
    } finally { clearTimeout(timer); clearTimeout(connectTimer); clearTimeout(idleTimer); clearInterval(monitor); }
  };
}
