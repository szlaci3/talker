import { fireEvent, render, screen, waitFor } from '@testing-library/react';
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
    expect(screen.getAllByText('Stopped')).toHaveLength(1);
    expect(screen.queryByText('Canceled before a response')).not.toBeInTheDocument();
    expect(screen.getByText('Give a detailed account of the consequences').closest('article')).toHaveClass('stale');
    expect(screen.getByText('PARTIAL_ANSWER').closest('article')).toHaveClass('stale');

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

describe('conversational appearance tools', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    sessionStorage.setItem('chat-token', 'test-session-token');
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
  });

  it('applies a validated model color action in the browser and returns its result to Antigravity', async () => {
    fetchMock.mockResolvedValueOnce(eventStream({
      tool_calls: [{ id: 'tool-1', name: 'set_ui_color', arguments: { target: 'composerBackground', color: '#ff0000' } }],
    }));
    fetchMock.mockResolvedValueOnce(eventStream({ delta: 'I changed the input background to red.' }));

    const user = userEvent.setup();
    render(<App />);
    await user.type(screen.getByRole('textbox', { name: 'Message' }), 'Make the input box red');
    await user.click(screen.getByRole('button', { name: '↑' }));

    expect(await screen.findByText('I changed the input background to red.')).toBeInTheDocument();
    expect(document.documentElement.style.getPropertyValue('--ui-composer-bg')).toBe('#ff0000');
    const toolResultCall = fetchMock.mock.calls.find(([url]) => String(url).endsWith('/api/ui-tool-result'));
    expect(toolResultCall).toBeDefined();
    expect(JSON.parse(toolResultCall![1]?.body as string)).toMatchObject({
      toolResults: [{ callId: 'tool-1', result: { ok: true } }],
    });
  });

  it('continues a second appearance action requested after the first tool result', async () => {
    fetchMock.mockResolvedValueOnce(eventStream({
      tool_calls: [{ id: 'tool-green', name: 'set_ui_color', arguments: { target: 'messageBackground', color: '#aaffaa' } }],
    }));
    fetchMock.mockResolvedValueOnce(eventStream({
      tool_calls: [{ id: 'tool-blue', name: 'set_ui_color', arguments: { target: 'messageBackground', color: '#aaddff' } }],
    }));
    fetchMock.mockResolvedValueOnce(eventStream({ delta: 'I changed the assistant message background to light blue.' }));

    const user = userEvent.setup();
    render(<App />);
    await user.type(screen.getByRole('textbox', { name: 'Message' }), 'Make assistant message background light green-yellow, then light blue');
    await user.click(screen.getByRole('button', { name: '↑' }));

    expect(await screen.findByText('I changed the assistant message background to light blue.')).toBeInTheDocument();
    expect(document.documentElement.style.getPropertyValue('--ui-message-bg')).toBe('#aaddff');
    expect(fetchMock.mock.calls.filter(([url]) => String(url).endsWith('/api/ui-tool-result'))).toHaveLength(2);
  });

  it('does not apply an unknown target or malformed color from a model tool call', async () => {
    fetchMock.mockResolvedValueOnce(eventStream({
      tool_calls: [{ id: 'tool-2', name: 'set_ui_color', arguments: { target: 'bodyStyle', color: 'red; background:url(x)' } }],
    }));
    fetchMock.mockResolvedValueOnce(eventStream({ delta: 'That appearance request was invalid.' }));

    const user = userEvent.setup();
    render(<App />);
    await user.type(screen.getByRole('textbox', { name: 'Message' }), 'Change the site styling');
    await user.click(screen.getByRole('button', { name: '↑' }));

    expect(await screen.findByText('That appearance request was invalid.')).toBeInTheDocument();
    expect(document.documentElement.style.getPropertyValue('--ui-composer-bg')).toBe('');
    const toolResultCall = fetchMock.mock.calls.find(([url]) => String(url).endsWith('/api/ui-tool-result'));
    expect(JSON.parse(toolResultCall![1]?.body as string)).toMatchObject({
      toolResults: [{ callId: 'tool-2', result: { ok: false } }],
    });
  });

  it('shares validated appearance changes with manual controls and reset', async () => {
    const user = userEvent.setup();
    render(<App />);
    await user.selectOptions(screen.getByRole('combobox', { name: 'Theme' }), 'dark');
    await user.click(screen.getByRole('button', { name: 'Increase text size' }));
    await user.click(screen.getByText('Colors'));
    await user.selectOptions(screen.getByRole('combobox', { name: 'Color target' }), 'composerBackground');
    fireEvent.change(screen.getByLabelText('Color value'), { target: { value: '#123456' } });

    await waitFor(() => {
      expect(document.documentElement.dataset.theme).toBe('dark');
      expect(document.documentElement.style.getPropertyValue('--scale')).toBe('1.1');
      expect(document.documentElement.style.getPropertyValue('--ui-composer-bg')).toBe('#123456');
    });
    await user.click(screen.getByRole('button', { name: 'Reset appearance' }));
    await waitFor(() => {
      expect(document.documentElement.dataset.theme).toBe('system');
      expect(document.documentElement.style.getPropertyValue('--scale')).toBe('1');
      expect(document.documentElement.style.getPropertyValue('--ui-composer-bg')).toBe('');
    });
  });

  it('keeps the color picker panel separate from a custom composer color in dark mode', async () => {
    const user = userEvent.setup();
    render(<App />);
    await user.selectOptions(screen.getByRole('combobox', { name: 'Theme' }), 'dark');
    await user.click(screen.getByText('Colors'));
    await user.selectOptions(screen.getByRole('combobox', { name: 'Color target' }), 'composerBackground');
    fireEvent.change(screen.getByLabelText('Color value'), { target: { value: '#ff0000' } });

    await waitFor(() => {
      expect(document.documentElement.dataset.theme).toBe('dark');
      expect(document.documentElement.style.getPropertyValue('--ui-composer-bg')).toBe('#ff0000');
      expect(document.documentElement.style.getPropertyValue('--ui-color-panel-bg')).toBe('');
    });
  });

  it('registers the shared actions when a WebMCP ModelContext is available', async () => {
    const registered: Array<Record<string, unknown>> = [];
    const registerTool = vi.fn(async (tool: Record<string, unknown>) => { registered.push(tool); });
    Object.defineProperty(document, 'modelContext', { configurable: true, value: { registerTool } });
    try {
      render(<App />);
      await waitFor(() => expect(registerTool).toHaveBeenCalledTimes(5));
      expect(screen.getByText('WebMCP tools are registered. Chat remains available.')).toBeInTheDocument();
      const colorTool = registered.find(tool => tool.name === 'set_ui_color');
      const execute = colorTool?.execute as (input: unknown) => string;
      const result = JSON.parse(execute({ target: 'composerBackground', color: '#123456' }));
      expect(result.ok).toBe(true);
      await waitFor(() => expect(document.documentElement.style.getPropertyValue('--ui-composer-bg')).toBe('#123456'));
    } finally {
      delete (document as Document & { modelContext?: unknown }).modelContext;
    }
  });
});
