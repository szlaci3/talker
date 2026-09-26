import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import App from './App';

function eventStream(...events: Array<Record<string, unknown>>) {
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const event of events) controller.enqueue(encoder.encode('data: ' + JSON.stringify(event) + '\n\n'));
      controller.enqueue(encoder.encode('data: [DONE]\n\n'));
      controller.close();
    },
  });
  return { ok: true, status: 200, body } as Response;
}

function responseAfterAbort(signal: AbortSignal | undefined, delta: string) {
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode('data: ' + JSON.stringify({ delta }) + '\n\n'));
      signal?.addEventListener('abort', () => {
        controller.error(new DOMException('Aborted by test', 'AbortError'));
      }, { once: true });
    },
  });
  return { ok: true, status: 200, body } as Response;
}

function chatPayload(fetchMock: ReturnType<typeof vi.fn>, index: number) {
  const request = fetchMock.mock.calls.filter(([url]) => String(url).endsWith('/api/chat'))[index];
  return JSON.parse(request[1]?.body as string) as { messages: Array<{ role: string; content: string }> };
}

describe('chat cancellation and recovery', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    sessionStorage.setItem('chat-token', 'test-session-token');
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
  });

  it('marks a pre-token cancellation and excludes that unanswered question from the next request', async () => {
    fetchMock.mockImplementationOnce((_input: RequestInfo | URL, init?: RequestInit) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          reject(new DOMException('Aborted by test', 'AbortError'));
        }, { once: true });
      })
    );
    fetchMock.mockResolvedValueOnce(eventStream({ delta: 'STRAWBERRY_REPLY' }));

    const user = userEvent.setup();
    render(<App />);
    await user.type(screen.getByRole('textbox', { name: 'Message' }), 'Explain the causes in detail');
    await user.click(screen.getByRole('button', { name: '↑' }));
    await user.click(await screen.findByRole('button', { name: 'Stop' }));

    expect(await screen.findByText('Canceled before a response')).toBeInTheDocument();
    await user.type(screen.getByRole('textbox', { name: 'Message' }), 'How many r letters are in strawberry?');
    await user.click(screen.getByRole('button', { name: '↑' }));
    expect(await screen.findByText('STRAWBERRY_REPLY')).toBeInTheDocument();

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    expect(chatPayload(fetchMock, 1).messages).toEqual([
      { role: 'user', content: 'How many r letters are in strawberry?' },
    ]);
  });

  it('keeps partial output marked as stopped and rebuilds the next request from completed visible turns', async () => {
    fetchMock.mockResolvedValueOnce(eventStream({ delta: 'FIRST_ANSWER' }));
    fetchMock.mockImplementationOnce((_input: RequestInfo | URL, init?: RequestInit) =>
      Promise.resolve(responseAfterAbort(init?.signal as AbortSignal | undefined, 'PARTIAL_ANSWER'))
    );
    fetchMock.mockResolvedValueOnce(eventStream({ delta: 'THIRD_ANSWER' }));

    const user = userEvent.setup();
    render(<App />);
    const textbox = screen.getByRole('textbox', { name: 'Message' });
    await user.type(textbox, 'Explain the Thirty Years’ War');
    await user.click(screen.getByRole('button', { name: '↑' }));
    expect(await screen.findByText('FIRST_ANSWER')).toBeInTheDocument();

    await user.type(textbox, 'Give a detailed account of the consequences');
    await user.click(screen.getByRole('button', { name: '↑' }));
    expect(await screen.findByText('PARTIAL_ANSWER')).toBeInTheDocument();
    await user.click(await screen.findByRole('button', { name: 'Stop' }));
    expect(await screen.findByText('Stopped')).toBeInTheDocument();
    expect(screen.queryByText('Canceled before a response')).not.toBeInTheDocument();

    await user.type(textbox, 'What were the consequences?');
    await user.click(screen.getByRole('button', { name: '↑' }));
    expect(await screen.findByText('THIRD_ANSWER')).toBeInTheDocument();

    expect(chatPayload(fetchMock, 2).messages).toEqual([
      { role: 'user', content: 'Explain the Thirty Years’ War' },
      { role: 'assistant', content: 'FIRST_ANSWER' },
      { role: 'user', content: 'What were the consequences?' },
    ]);
  });
});
