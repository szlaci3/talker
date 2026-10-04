import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import App from './App';
import type { TranscriptUpdate } from './speechInput';

const speechInputMock = vi.hoisted(() => ({ instances: [] as Array<{ callbacks: { onTranscript: (update: TranscriptUpdate) => void; onStatus: (status: string) => void }; stopped: boolean }> }));
vi.mock('./speechInput', () => ({ SpeechInput: class {
  readonly callbacks: typeof speechInputMock.instances[number]['callbacks'];
  stopped = false;
  constructor(_api: string, _getToken: () => string, callbacks: typeof speechInputMock.instances[number]['callbacks']) {
    this.callbacks = callbacks;
    speechInputMock.instances.push(this);
  }
  async start() { this.callbacks.onStatus('Listening'); }
  stop() { this.stopped = true; }
} }));

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

function voiceCatalogue() {
  return new Response(JSON.stringify({ voices: [{ name: 'en-US-BrianMultilingualNeural', locale: 'en-US', friendlyName: 'Brian' }] }), { status: 200 });
}

function mockApi(sessionCheck: () => Promise<Response> = async () => new Response('{}', { status: 200 })) {
  const responses = vi.fn();
  vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith('/api/voices')) return Promise.resolve(voiceCatalogue());
    if (url.endsWith('/api/session') && (!init?.method || init.method === 'GET')) return sessionCheck();
    if (url.endsWith('/api/chat') || url.endsWith('/api/ui-tool-result')
      || (url.endsWith('/api/session') && init?.method === 'POST')) return responses(input, init);
    throw new Error(`Unexpected test request: ${init?.method || 'GET'} ${url}`);
  }));
  return responses;
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

describe('invitation loading feedback', () => {
  it.each(['Enter', 'Continue'])('shows loading immediately after %s and opens chat when the request completes', async submit => {
    const fetchMock = mockApi();
    let complete!: (response: Response) => void;
    fetchMock.mockReturnValueOnce(new Promise<Response>(resolve => { complete = resolve; }));
    const user = userEvent.setup();
    render(<App />);
    const code = screen.getByRole('textbox', { name: 'Invitation code' });
    await user.type(code, 'test-code');
    if (submit === 'Enter') await user.keyboard('{Enter}');
    else await user.click(screen.getByRole('button', { name: /Continue/ }));

    expect(screen.getByRole('status')).toHaveTextContent('Opening chat');
    expect(screen.getByRole('button', { name: 'Connecting…' })).toBeDisabled();
    expect(code).toBeDisabled();
    fireEvent.submit(code.closest('form')!);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    complete(new Response(JSON.stringify({ token: 'test-session-token' }), { status: 200 }));
    expect(await screen.findByRole('textbox', { name: 'Message' })).toBeInTheDocument();
    expect(screen.queryByText(/Opening chat/)).not.toBeInTheDocument();
  });

  it('clears loading on failure, preserves the code, and permits retry', async () => {
    const fetchMock = mockApi();
    let fail!: (cause: Error) => void;
    fetchMock.mockReturnValueOnce(new Promise<Response>((_resolve, reject) => { fail = reject; }));
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ token: 'test-session-token' }), { status: 200 }));
    const user = userEvent.setup();
    render(<App />);
    await user.type(screen.getByRole('textbox', { name: 'Invitation code' }), 'test-code');
    await user.click(screen.getByRole('button', { name: /Continue/ }));
    expect(screen.getByRole('status')).toHaveTextContent('Opening chat');
    fail(new Error('Connection interrupted.'));

    expect(await screen.findByText('Connection interrupted.')).toBeInTheDocument();
    expect(screen.queryByText(/Opening chat/)).not.toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: 'Invitation code' })).toHaveValue('test-code');
    expect(screen.getByRole('button', { name: /Continue/ })).toBeEnabled();
    await user.click(screen.getByRole('button', { name: /Continue/ }));
    expect(await screen.findByRole('textbox', { name: 'Message' })).toBeInTheDocument();
  });
});

describe('chat cancellation and recovery', () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  let sessionCheck: ReturnType<typeof vi.fn<() => Promise<Response>>>;

  beforeEach(() => {
    speechInputMock.instances = [];
    sessionStorage.setItem('chat-token', 'test-session-token');
    sessionCheck = vi.fn(async () => new Response('{}', { status: 200 }));
    fetchMock = mockApi(sessionCheck);
  });

  it('appends live dictation to a typed draft, highlights corrections, and ends capture before sending', async () => {
    const user = userEvent.setup();
    render(<App />);
    const textbox = screen.getByRole('textbox', { name: 'Message' });
    await user.type(textbox, 'Please review: ');
    await user.click(screen.getByRole('button', { name: 'Mic' }));
    speechInputMock.instances[0].callbacks.onTranscript({ committed: '', interim: 'the old phrase', corrected: null });
    await waitFor(() => expect(textbox).toHaveValue('Please review: the old phrase'));
    expect(screen.queryByText('Corrected:')).not.toBeInTheDocument();
    speechInputMock.instances[0].callbacks.onTranscript({ committed: 'the new phrase', interim: '', corrected: { before: 'old', after: 'new' } });
    await waitFor(() => expect(textbox).toHaveValue('Please review: the new phrase'));
    expect(screen.getByText('old').tagName).toBe('DEL');
    expect(screen.getByText('new').tagName).toBe('MARK');
    fetchMock.mockResolvedValueOnce(eventStream({ delta: 'Reviewed.' }));
    await user.click(screen.getByRole('button', { name: '↑' }));
    expect(speechInputMock.instances[0].stopped).toBe(true);
    expect(chatPayload(fetchMock, 0).messages.at(-1)?.content).toBe('Please review: the new phrase');
  });

  it('shows deleted words separately and expires the correction after five seconds even as new words arrive', async () => {
    const user = userEvent.setup();
    render(<App />);
    await user.click(screen.getByRole('button', { name: 'Mic' }));
    const callback = speechInputMock.instances[0].callbacks.onTranscript;
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      act(() => callback({ committed: '', interim: 'I like tea', corrected: { before: 'really', after: '' } }));
      expect(screen.getByText('really').tagName).toBe('DEL');
      expect(screen.getByText('(removed)').tagName).toBe('MARK');
      expect(screen.getByRole('textbox', { name: 'Message' })).toHaveValue('I like tea');
      act(() => vi.advanceTimersByTime(4000));
      act(() => callback({ committed: '', interim: 'I like tea and coffee', corrected: null }));
      expect(screen.getByText('Corrected:')).toBeInTheDocument();
      act(() => vi.advanceTimersByTime(1000));
      expect(screen.queryByText('Corrected:')).not.toBeInTheDocument();
      expect(screen.getByRole('textbox', { name: 'Message' })).toHaveValue('I like tea and coffee');
    } finally {
      vi.useRealTimers();
    }
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
    await user.click(await screen.findByRole('button', { name: 'Interrupt' }));

    expect(await screen.findByText('Canceled before a response')).toBeInTheDocument();
    await user.type(screen.getByRole('textbox', { name: 'Message' }), 'How many r letters are in strawberry?');
    await user.click(screen.getByRole('button', { name: '↑' }));
    expect(await screen.findByText('STRAWBERRY_REPLY')).toBeInTheDocument();

    await waitFor(() => expect(fetchMock.mock.calls.filter(([url]) => String(url).endsWith('/api/chat'))).toHaveLength(2));
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
    await user.click(await screen.findByRole('button', { name: 'Interrupt' }));
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

  it('asks for the invitation code on composer focus when the stored session expired', async () => {
    sessionCheck.mockResolvedValueOnce(new Response('{}', { status: 401 }));
    const user = userEvent.setup();
    render(<App />);
    const textbox = screen.getByRole('textbox', { name: 'Message' });
    fireEvent.change(textbox, { target: { value: 'Test 3 Q1' } });
    await user.click(textbox);

    expect(await screen.findByRole('textbox', { name: 'Invitation code' })).toBeInTheDocument();
    expect(sessionStorage.getItem('chat-token')).toBeNull();
    expect(screen.queryByText('Test 3 Q1')).not.toBeInTheDocument();

    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ token: 'renewed-token' }), { status: 200 }));
    await user.type(screen.getByRole('textbox', { name: 'Invitation code' }), 'valid-invitation-code');
    await user.click(screen.getByRole('button', { name: /Continue/ }));

    expect(await screen.findByRole('textbox', { name: 'Message' })).toHaveValue('Test 3 Q1');
  });

  it('restores the unsent draft when the session expires during submission', async () => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ error: 'Your session expired. Enter the code again.' }), { status: 401 }));
    const user = userEvent.setup();
    render(<App />);
    const textbox = screen.getByRole('textbox', { name: 'Message' });
    await user.type(textbox, 'Test 3 Q1');
    await user.click(screen.getByRole('button', { name: '↑' }));

    expect(await screen.findByRole('textbox', { name: 'Invitation code' })).toBeInTheDocument();
    expect(screen.queryByText('Test 3 Q1')).not.toBeInTheDocument();
    expect(sessionStorage.getItem('chat-token')).toBeNull();
  });
});

describe('conversational appearance tools', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    sessionStorage.setItem('chat-token', 'test-session-token');
    fetchMock = mockApi();
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

  it.each(['object', 'JSON string'])('routes assistant appearance calls through native WebMCP with %s arguments', async format => {
    const registered: Array<Record<string, unknown>> = [];
    const executeTool = vi.fn(async (tool: { name: string }, input: unknown) => {
      if (format === 'JSON string' && typeof input !== 'string') {
        throw new DOMException('Failed to parse input arguments', 'UnknownError');
      }
      const descriptor = registered.find(candidate => candidate.name === tool.name)!;
      const execute = descriptor.execute as (args: unknown) => unknown;
      return JSON.stringify(await execute(typeof input === 'string' ? JSON.parse(input) : input));
    });
    Object.defineProperty(document, 'modelContext', { configurable: true, value: {
      registerTool: vi.fn(async (tool: Record<string, unknown>) => { registered.push(tool); }),
      getTools: vi.fn(async () => registered.map(tool => ({ name: String(tool.name) }))),
      executeTool,
    } });
    fetchMock.mockResolvedValueOnce(eventStream({
      tool_calls: [{ id: 'native-tool', name: 'set_theme', arguments: { theme: 'dark' } }],
    }));
    fetchMock.mockResolvedValueOnce(eventStream({ delta: 'Dark mode is on.' }));

    try {
      const user = userEvent.setup();
      render(<App />);
      await user.type(screen.getByRole('textbox', { name: 'Message' }), 'Switch to dark mode');
      await user.click(screen.getByRole('button', { name: '↑' }));

      expect(await screen.findByText('Dark mode is on.')).toBeInTheDocument();
      expect(executeTool).toHaveBeenCalledWith({ name: 'set_theme' }, { theme: 'dark' }, expect.objectContaining({ signal: expect.any(AbortSignal) }));
      expect(executeTool).toHaveBeenCalledTimes(format === 'object' ? 1 : 2);
      if (format === 'JSON string') {
        expect(executeTool).toHaveBeenLastCalledWith({ name: 'set_theme' }, JSON.stringify({ theme: 'dark' }), expect.objectContaining({ signal: expect.any(AbortSignal) }));
      }
      expect(document.documentElement.dataset.theme).toBe('dark');
    } finally {
      delete (document as Document & { modelContext?: unknown }).modelContext;
    }
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
      const execute = colorTool?.execute as (input: unknown) => { ok: boolean };
      const result = execute({ target: 'composerBackground', color: '#123456' });
      expect(result.ok).toBe(true);
      await waitFor(() => expect(document.documentElement.style.getPropertyValue('--ui-composer-bg')).toBe('#123456'));
    } finally {
      delete (document as Document & { modelContext?: unknown }).modelContext;
    }
  });
});
