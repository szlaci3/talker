import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import App from './App';

vi.hoisted(() => {
  vi.stubEnv('VITE_ACCESS_API_URL', 'same-origin');
  vi.stubEnv('VITE_CHAT_API_URL', 'same-origin');
});
beforeEach(() => { sessionStorage.setItem('chat-token', 'test-session'); });
afterEach(() => { vi.unstubAllEnvs(); });
const encoder = new TextEncoder();
function stream(...events: unknown[]) {
  return new Response(events.map(event => 'data: ' + JSON.stringify(event) + '\n\n').join(''), { headers: { 'Content-Type': 'text/event-stream' } });
}

it('streams across Netlify windows, applies tools, continues and sends the next turn without Render', async () => {
  const requests: Array<{ url: string; data: any }> = [];
  let originalJob: string;
  let nextJob: string;
  let turn = 0;
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const data = init?.body ? JSON.parse(String(init.body)) : {};
    requests.push({ url, data });
    if (url === '/api/session/check') return Response.json({ ok: true });
    if (url === '/api/chat') {
      turn++;
      if (turn === 1) originalJob = data.requestId;
      else nextJob = data.requestId;
      return stream({ job: data.requestId });
    }
    if (url === '/api/chat-stream') {
      if (data.requestId === originalJob) {
        return data.offset === 0 ? stream({ delta: 'First ' }, { resume: true, offset: 6 })
          : stream({ delta: 'answer. ' }, { tool_calls: [{ id: 'theme-call', name: 'set_theme', arguments: { theme: 'dark' } }] });
      }
      return stream({ delta: data.requestId === nextJob ? 'Follow-up answer.' : 'Theme updated.' });
    }
    if (url === '/api/ui-tool-result') return stream({ job: data.requestId });
    throw new Error('Render is unavailable: ' + url);
  }));
  const user = userEvent.setup();
  render(<App />);
  await user.type(screen.getByRole('textbox', { name: 'Message' }), 'Change the theme');
  await user.click(screen.getByRole('button', { name: '↑' }));
  await screen.findByText('First answer. Theme updated.');
  expect(document.documentElement.dataset.theme).toBe('dark');
  const continuation = requests.find(request => request.url === '/api/ui-tool-result')!;
  expect(continuation.data.parentRequestId).toBe(originalJob!);
  expect(continuation.data.toolResults).toMatchObject([{ callId: 'theme-call', result: { ok: true } }]);
  expect(requests.filter(request => request.url === '/api/chat-stream')[1].data.offset).toBe(6);
  await user.type(screen.getByRole('textbox', { name: 'Message' }), 'A follow up');
  await user.click(screen.getByRole('button', { name: '↑' }));
  await screen.findByText('Follow-up answer.');
  expect(requests.filter(request => request.url === '/api/chat')[1].data.messages[1].content).toBe('First answer. Theme updated.');
  expect(requests.every(request => request.url.startsWith('/api/'))).toBe(true);
});

it('Interrupt cancels the remote job, keeps the visible cutoff and rebuilds the next conversation', async () => {
  const requests: Array<{ url: string; init?: RequestInit; data: any }> = [];
  let turn = 0;
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const data = init?.body ? JSON.parse(String(init.body)) : {};
    requests.push({ url, init, data });
    if (url === '/api/session/check' || url === '/api/chat-cancel') return Response.json({ ok: true });
    if (url === '/api/chat') { turn++; return stream({ job: data.requestId }); }
    if (url === '/api/chat-stream' && turn > 1) return stream({ delta: 'Recovered answer.' });
    if (url === '/api/chat-stream') return new Response(new ReadableStream({ start(controller) {
      controller.enqueue(encoder.encode('data: {"delta":"Visible cutoff"}\n\n'));
      init?.signal?.addEventListener('abort', () => controller.error(new DOMException('Canceled', 'AbortError')), { once: true });
    } }));
    throw new Error('Unexpected backend request');
  }));
  const user = userEvent.setup();
  render(<App />);
  await user.type(screen.getByRole('textbox', { name: 'Message' }), 'First question');
  await user.click(screen.getByRole('button', { name: '↑' }));
  await screen.findByText('Visible cutoff');
  await user.click(screen.getByRole('button', { name: 'Interrupt' }));
  await screen.findByText('Interrupted');
  await waitFor(() => expect(requests.some(request => request.url === '/api/chat-cancel')).toBe(true));
  const first = requests.find(request => request.url === '/api/chat')!;
  expect(requests.find(request => request.url === '/api/chat-cancel')!.data.requestId).toBe(first.data.requestId);
  await user.type(screen.getByRole('textbox', { name: 'Message' }), 'Next question');
  await user.click(screen.getByRole('button', { name: '↑' }));
  await screen.findByText('Recovered answer.');
  const next = requests.filter(request => request.url === '/api/chat')[1];
  expect((next.init?.headers as Record<string, string>)['X-Conversation-ID']).not.toBe((first.init?.headers as Record<string, string>)['X-Conversation-ID']);
  expect(next.data.messages[1].content).toContain('Visible cutoff');
  expect(next.data.messages[1].content).toContain('[Interrupted.');
});

it('shows serverless failures and restores controls for another request', async () => {
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    if (String(input) === '/api/session/check' || String(input) === '/api/chat-cancel') return Response.json({ ok: true });
    return Response.json({ error: 'The daily chat limit has been reached.' }, { status: 429 });
  }));
  const user = userEvent.setup();
  render(<App />);
  await user.type(screen.getByRole('textbox', { name: 'Message' }), 'A question');
  await user.click(screen.getByRole('button', { name: '↑' }));
  expect(await screen.findByText('The daily chat limit has been reached.')).toBeInTheDocument();
  expect(screen.getByRole('textbox', { name: 'Message' })).toBeEnabled();
  expect(screen.queryByRole('button', { name: 'Interrupt' })).not.toBeInTheDocument();
});
