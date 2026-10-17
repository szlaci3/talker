import tools from './ui-tools.json' with { type: 'json' };
import { json } from './security.mjs';

export { tools };
export const SYSTEM_INSTRUCTION = "You are a helpful general-purpose assistant in a developer portfolio chat. Keep answers clear and concise. You can change only the chat appearance using the declared UI functions. Call at most one UI function at a time, and use it only when the user clearly requests an appearance change or asks to inspect/reset it; normal chat and discussion about UI should not trigger a function. Never claim a change was applied unless its function result says it succeeded. Ask which component the user means when a color request has no clear target. Never execute code, browse, access files, or claim voice features.";

export function messages(data) {
  const items = data.messages;
  if (!Array.isArray(items) || items.length < 1 || items.length > 24) throw json({ error: 'Send between 1 and 24 messages.' }, 400);
  for (const item of items) {
    if (!item || !['user', 'assistant'].includes(item.role) || typeof item.content !== 'string'
        || !item.content.trim() || item.content.trim().length > 12_000) {
      throw json({ error: 'Message format is invalid.' }, 400);
    }
  }
  if (items.at(-1).role !== 'user') throw json({ error: 'The latest message must be from the user.' }, 400);
  return items.map(item => ({ role: item.role, content: item.content.trim() }));
}

export function validTool(name, args) {
  const tool = tools.find(item => item.name === name);
  if (!tool || !args || typeof args !== 'object' || Array.isArray(args)) return false;
  const schema = tool.parameters;
  const keys = Object.keys(args);
  if (keys.some(key => !Object.hasOwn(schema.properties, key)) || (schema.required || []).some(key => !keys.includes(key))) return false;
  for (const [key, value] of Object.entries(args)) {
    const field = schema.properties[key];
    if (field.type === 'string' && (typeof value !== 'string' || (field.enum && !field.enum.includes(value)) || (field.pattern && !new RegExp(field.pattern).test(value)))) return false;
    if (field.type === 'number' && (typeof value !== 'number' || !Number.isFinite(value) || value < field.minimum || value > field.maximum)) return false;
  }
  return true;
}

export function toolResults(data, pending) {
  if (!pending || data.parentRequestId !== pending.requestId) throw json({ error: 'The UI action request has expired. Please try again.' }, 409);
  const results = data.toolResults;
  if (!Array.isArray(results) || results.length < 1 || results.length > 4 || results.length !== pending.calls.length) {
    throw json({ error: 'UI tool results are invalid.' }, 400);
  }
  return results.map((supplied, index) => {
    const call = pending.calls[index];
    const result = supplied?.result;
    if (supplied?.callId !== call.id || typeof result?.ok !== 'boolean' || typeof result.message !== 'string') {
      throw json({ error: 'UI tool results are invalid.' }, 400);
    }
    return { type: 'function_result', name: call.name, call_id: call.id,
      result: { ok: result.ok, message: result.message.slice(0, 500) } };
  });
}
