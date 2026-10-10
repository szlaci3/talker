import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import App from './App';
import type { TranscriptUpdate } from './speechInput';
import type { DialogCallbacks } from './dialog';

const dialogMock = vi.hoisted(() => ({ latest: null as null | { callbacks: DialogCallbacks; stopped: boolean } }));
vi.mock('./dialog', () => ({ Dialog: class {
  stopped = false;
  constructor(_api: string, _token: unknown, public callbacks: DialogCallbacks) { dialogMock.latest = this; }
  async start() { this.callbacks.onStatus('Dialog is listening'); }
  stop() { this.stopped = true; }
} }));

const speechInputMock = vi.hoisted(() => ({ instances: [] as Array<{ callbacks: { onTranscript: (update: TranscriptUpdate) => void; onStatus: (status: string) => void; onSpeechStarted?: () => void; onSpeechEnded?: (elapsed?: number) => void }; stopped: boolean }> }));
const speechOutputMock = vi.hoisted(() => ({ instances: [] as Array<{ phase: string; messageId: string | null; plays: Array<[string, string]>; toggles: Array<[string, string]>; streamed: string[]; stops: number }> }));
vi.mock('./speechInput', () => ({ SpeechInput: class {
  readonly callbacks: typeof speechInputMock.instances[number]['callbacks'];
  stopped = false;
  constructor(_api: string, _getToken: () => string, callbacks: typeof speechInputMock.instances[number]['callbacks']) {
    this.callbacks = callbacks;
    speechInputMock.instances.push(this);
  }
  async start() { this.callbacks.onStatus('Gemini is listening'); }
  stop() { this.stopped = true; }
  resetTranscript() { this.callbacks.onTranscript({ committed: '', interim: '', corrected: null }); }
} }));
vi.mock('./speechOutput', () => ({ SpeechOutput: class {
  phase = 'idle';
  messageId: string | null = null;
  plays: Array<[string, string]> = [];
  toggles: Array<[string, string]> = [];
  streamed: string[] = [];
  stops = 0;
  constructor(_api: string, _getToken: () => string, private onSnapshot: (value: { messageId: string | null; phase: string; service: string; detail: string }) => void) {
    speechOutputMock.instances.push(this);
  }
  snapshot() { return { messageId: this.messageId, phase: this.phase, service: 'idle', detail: '' }; }
  async warmup() {}
  unlock() {}
  play(messageId: string, text: string) { this.messageId = messageId; this.phase = 'speaking-browser'; this.plays.push([messageId, text]); this.onSnapshot(this.snapshot()); }
  startStreaming(messageId: string) { this.messageId = messageId; this.phase = 'loading'; this.streamed.push('start'); this.onSnapshot(this.snapshot()); }
  appendStreaming(_messageId: string, text: string) { this.streamed.push(text); }
  finishStreaming(messageId: string, text: string) { this.streamed.push('finish'); this.messageId = messageId; this.phase = 'speaking-browser'; this.plays.push([messageId, text]); this.onSnapshot(this.snapshot()); }
  toggle(messageId: string, text: string) {
    this.toggles.push([messageId, text]);
    if (this.messageId === messageId && this.phase === 'paused') this.phase = 'speaking-browser';
    else if (this.messageId === messageId && this.phase === 'speaking-browser') this.phase = 'paused';
    else { this.messageId = messageId; this.phase = 'speaking-browser'; this.plays.push([messageId, text]); }
    this.onSnapshot(this.snapshot());
  }
  stop() { this.stops++; this.phase = 'idle'; this.onSnapshot(this.snapshot()); }
  dispose() { this.stop(); }
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

describe('Dialog integration', () => {
  beforeEach(() => { sessionStorage.setItem('chat-token', 'test-session-token'); mockApi(); });

  it('hides Live, shows Dialog transcripts, applies shared tools and ends on another action', async () => {
    const user = userEvent.setup();
    render(<App />);
    expect(screen.queryByRole('button', { name: 'Start Live' })).not.toBeInTheDocument();
    expect(screen.getByLabelText('Start Live')).not.toBeVisible();
    await user.click(screen.getByRole('button', { name: 'Start Dialog' }));
    expect(screen.getByText('Dialog is listening')).toBeInTheDocument();
    const controller = dialogMock.latest!;
    act(() => controller.callbacks.onTurn({ userId: 'dialog-user', assistantId: 'dialog-answer', input: 'Hello Gemini', output: 'Hello there', status: 'complete' }));
    expect(screen.getByText('Hello Gemini')).toBeInTheDocument();
    expect(screen.getByText('Hello there')).toBeInTheDocument();
    await act(async () => { await controller.callbacks.invokeTool('set_theme', { theme: 'dark' }, new AbortController().signal); });
    expect(document.documentElement.dataset.theme).toBe('dark');
    await user.click(screen.getByRole('button', { name: 'Play' }));
    expect(controller.stopped).toBe(true);
    expect(screen.getByRole('button', { name: 'Start Dialog' })).toBeInTheDocument();
    expect(speechOutputMock.instances.at(-1)?.toggles.at(-1)).toEqual(['dialog-answer', 'Hello there']);
  });

  it('restores controls after provider failure and preserves the composer draft', async () => {
    const user = userEvent.setup();
    render(<App />);
    await user.type(screen.getByRole('textbox', { name: 'Message' }), 'Unsent draft');
    await user.click(screen.getByRole('button', { name: 'Start Dialog' }));
    act(() => dialogMock.latest!.callbacks.onError(new Error('Dialog quota exhausted')));
    expect(screen.getByText('Dialog quota exhausted')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Start Dialog' })).toBeEnabled();
    expect(screen.getByRole('textbox', { name: 'Message' })).toHaveValue('Unsent draft');
    expect(dialogMock.latest!.stopped).toBe(true);
  });

  it('ends Dialog on keyboard submission and carries its visible partial answer into typed chat', async () => {
    const fetchMock = mockApi();
    fetchMock.mockResolvedValue(eventStream({ delta: 'Typed reply' }));
    const user = userEvent.setup();
    render(<App />);
    await user.type(screen.getByRole('textbox', { name: 'Message' }), 'Follow up');
    await user.click(screen.getByRole('button', { name: 'Start Dialog' }));
    act(() => dialogMock.latest!.callbacks.onTurn({ userId: 'dialog-user', assistantId: 'dialog-answer', input: 'Spoken question', output: 'Visible partial', status: 'pending' }));
    // Keyboard focus does not click the shell, so send itself must end Dialog.
    fireEvent.keyDown(screen.getByRole('textbox', { name: 'Message' }), { key: 'Enter' });
    expect(dialogMock.latest!.stopped).toBe(true);
    await screen.findByText('Typed reply');
    const payload = chatPayload(fetchMock, 0);
    expect(payload.messages[0]).toMatchObject({ role: 'user', content: 'Spoken question' });
    expect(payload.messages[1].content).toContain('Visible partial');
    expect(payload.messages[1].content).toContain('[Interrupted.');
    expect(payload.messages[2].content).toBe('Follow up');
  });
});

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
    speechOutputMock.instances = [];
    sessionStorage.setItem('chat-token', 'test-session-token');
    sessionCheck = vi.fn(async () => new Response('{}', { status: 200 }));
    fetchMock = mockApi(sessionCheck);
  });

  it('shows the three service states together in the status row', async () => {
    const user = userEvent.setup();
    render(<App />);
    const row = document.querySelector('.status-row')!;
    expect(row.children).toHaveLength(3);
    expect(row.children[0]).toHaveTextContent('Checking Brian voice');
    expect(row.children[2]).toHaveTextContent('Standard chat (no WebMCP)');
    await user.click(screen.getByRole('button', { name: 'Mic' }));
    expect(await screen.findByText('Gemini is listening')).toBeInTheDocument();
    expect(row.children[1]).toHaveTextContent('Gemini is listening');
  });

  it('opens and closes the grouped appearance controls', async () => {
    const user = userEvent.setup();
    render(<App />);
    const toggle = screen.getByRole('button', { name: 'Appearance' });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    await user.click(toggle);
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    expect(document.querySelector('#appearance-toolbar')).toHaveClass('is-open');
    await user.click(toggle);
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
  });

  it('keeps Live active, auto-sends after four seconds of silence, counts down, and speaks the full answer', async () => {
    fetchMock.mockResolvedValueOnce(eventStream({ delta: 'LIVE_ANSWER' }));
    render(<App />);
    // Exercise retained Live logic directly while its control is hidden.
    fireEvent.click(screen.getByLabelText('Start Live'));
    const recognizer = speechInputMock.instances[0];
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'Date'] });
    act(() => {
      recognizer.callbacks.onTranscript({ committed: '', interim: 'What is the weather?', corrected: null });
      recognizer.callbacks.onSpeechEnded?.(0);
    });
    expect(screen.getByRole('textbox', { name: 'Message' })).toHaveValue('What is the weather?');
    try {
      await act(async () => { await vi.advanceTimersByTimeAsync(2000); });
      expect(document.querySelector('.dictation-status')).toHaveTextContent('Sending in 2…');
      // Recognition revisions update the draft but do not restart the silence countdown.
      act(() => recognizer.callbacks.onTranscript({ committed: '', interim: 'What is the weather like?', corrected: null }));
      await act(async () => { await vi.advanceTimersByTimeAsync(2000); });
      expect(chatPayload(fetchMock, 0).messages.at(-1)?.content).toBe('What is the weather like?');
      expect(await screen.findByText('LIVE_ANSWER')).toBeInTheDocument();
      expect(speechOutputMock.instances[0].plays.at(-1)?.[1]).toBe('LIVE_ANSWER');
      expect(screen.getByLabelText('End Live')).toBeInTheDocument();
      expect(recognizer.stopped).toBe(false);
      expect(screen.getByRole('button', { name: 'Pause' })).toBeInTheDocument();
      fireEvent.click(screen.getByRole('button', { name: 'Pause' }));
      expect(screen.queryByLabelText('End Live')).not.toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Resume' })).toBeInTheDocument();
      fireEvent.click(screen.getByRole('button', { name: 'Resume' }));
      expect(screen.getByRole('button', { name: 'Stop' })).toBeInTheDocument();
      fireEvent.click(screen.getByRole('button', { name: 'Stop' }));
      fireEvent.click(screen.getByRole('button', { name: 'Play' }));
      expect(speechOutputMock.instances[0].plays.at(-1)?.[1]).toBe('LIVE_ANSWER');
    } finally {
      vi.useRealTimers();
    }
  });

  it('lets speech interrupt playback, keeps the complete answer, and uses the next utterance as a new turn', async () => {
    fetchMock.mockResolvedValueOnce(eventStream({ delta: 'COMPLETE_LIVE_ANSWER' }));
    fetchMock.mockResolvedValueOnce(eventStream({ delta: 'SECOND_LIVE_ANSWER' }));
    render(<App />);
    fireEvent.click(screen.getByLabelText('Start Live'));
    const recognizer = speechInputMock.instances[0];
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'Date'] });
    act(() => {
      recognizer.callbacks.onTranscript({ committed: '', interim: 'First question', corrected: null });
      recognizer.callbacks.onSpeechEnded?.(0);
    });
    try {
      await act(async () => { await vi.advanceTimersByTimeAsync(4000); });
      expect(await screen.findByText('COMPLETE_LIVE_ANSWER')).toBeInTheDocument();
      expect(speechOutputMock.instances[0].plays).toHaveLength(1);
      act(() => recognizer.callbacks.onSpeechStarted?.());
      expect(speechOutputMock.instances[0].stops).toBeGreaterThan(0);
      expect(screen.getByText('COMPLETE_LIVE_ANSWER').closest('article')).not.toHaveTextContent('Interrupted');
      act(() => {
        recognizer.callbacks.onTranscript({ committed: '', interim: 'Next question', corrected: null });
        recognizer.callbacks.onSpeechEnded?.(0);
      });
      await act(async () => { await vi.advanceTimersByTimeAsync(4000); });
      expect(chatPayload(fetchMock, 1).messages).toEqual([
        { role: 'user', content: 'First question' },
        { role: 'assistant', content: 'COMPLETE_LIVE_ANSWER' },
        { role: 'user', content: 'Next question' },
      ]);
      expect(await screen.findByText('SECOND_LIVE_ANSWER')).toBeInTheDocument();
      expect(screen.getByLabelText('End Live')).toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });

  it('ends Live on an older message click and still plays that message', async () => {
    fetchMock.mockResolvedValueOnce(eventStream({ delta: 'OLDER_ANSWER' }));
    const user = userEvent.setup();
    render(<App />);
    await user.type(screen.getByRole('textbox', { name: 'Message' }), 'First question');
    await user.click(screen.getByRole('button', { name: '↑' }));
    expect(await screen.findByText('OLDER_ANSWER')).toBeInTheDocument();

    fireEvent.click(screen.getByLabelText('Start Live'));
    expect(screen.getByLabelText('End Live')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Play' }));

    expect(screen.queryByLabelText('End Live')).not.toBeInTheDocument();
    expect(speechInputMock.instances[0].stopped).toBe(true);
    expect(speechOutputMock.instances[0].toggles.at(-1)?.[1]).toBe('OLDER_ANSWER');
    expect(speechOutputMock.instances[0].phase).toBe('speaking-browser');
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
    expect(screen.queryByText('Corrected:')).not.toBeInTheDocument();
    const highlightedDraft = document.querySelector('.composer-preview .composer-correction');
    expect(highlightedDraft).toHaveTextContent('new');
    expect(highlightedDraft).toHaveClass('composer-correction');
    fetchMock.mockResolvedValueOnce(eventStream({ delta: 'Reviewed.' }));
    await user.click(screen.getByRole('button', { name: '↑' }));
    expect(speechInputMock.instances[0].stopped).toBe(true);
    expect(chatPayload(fetchMock, 0).messages.at(-1)?.content).toBe('Please review: the new phrase');
  });

  it('expands the composer for multiple lines and scrolls long live dictation to the newest text', async () => {
    const user = userEvent.setup();
    render(<App />);
    const textarea = screen.getByRole('textbox', { name: 'Message' }) as HTMLTextAreaElement;
    Object.defineProperty(textarea, 'scrollHeight', { configurable: true, get: () => Math.max(44, Math.ceil(textarea.value.length / 24) * 24) });
    fireEvent.change(textarea, { target: { value: 'First line\nSecond line\nThird line' } });
    await waitFor(() => expect(document.querySelector('.composer-field')).toHaveStyle({ height: '48px' }));

    fireEvent.change(textarea, { target: { value: '' } });
    await user.click(screen.getByRole('button', { name: 'Mic' }));
    act(() => speechInputMock.instances[0].callbacks.onTranscript({ committed: 'A long dictated sentence '.repeat(36), interim: '', corrected: null }));
    const maxHeight = Math.min(320, window.innerHeight * 0.4);
    await waitFor(() => {
      expect(parseFloat((document.querySelector('.composer-field') as HTMLElement).style.height)).toBeCloseTo(maxHeight);
      expect(textarea.style.overflowY).toBe('auto');
      expect(textarea.scrollTop).toBeGreaterThan(0);
      expect(document.querySelector('.composer-preview-content')).toHaveStyle({ transform: `translateY(-${textarea.scrollTop}px)` });
    });
  });

  it('shows corrected words in the draft for five seconds without a separate correction line', async () => {
    const user = userEvent.setup();
    render(<App />);
    await user.click(screen.getByRole('button', { name: 'Mic' }));
    const callback = speechInputMock.instances[0].callbacks.onTranscript;
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      act(() => callback({ committed: '', interim: 'I like dogs today', corrected: { before: 'cats', after: 'dogs' } }));
      expect(screen.getByRole('textbox', { name: 'Message' })).toHaveValue('I like dogs today');
      expect(document.querySelector('.composer-correction')).toHaveTextContent('dogs');
      expect(screen.queryByText('Corrected:')).not.toBeInTheDocument();
      act(() => vi.advanceTimersByTime(4000));
      act(() => callback({ committed: '', interim: 'I like dogs today and coffee', corrected: null }));
      expect(document.querySelector('.composer-correction')).toHaveTextContent('dogs');
      act(() => vi.advanceTimersByTime(1000));
      expect(document.querySelector('.composer-correction')).not.toBeInTheDocument();
      expect(screen.queryByText('Corrected:')).not.toBeInTheDocument();
      expect(screen.getByRole('textbox', { name: 'Message' })).toHaveValue('I like dogs today and coffee');
    } finally {
      vi.useRealTimers();
    }
  });

  it.each(['Connecting to Gemini Live…', 'Gemini is listening'])('mutes during %s, keeps the draft, and resumes dictation without late updates', async status => {
    const user = userEvent.setup();
    render(<App />);
    const textbox = screen.getByRole('textbox', { name: 'Message' });
    await user.type(textbox, 'Draft:');
    await user.click(screen.getByRole('button', { name: 'Mic' }));
    const first = speechInputMock.instances[0];
    act(() => first.callbacks.onStatus(status));
    act(() => first.callbacks.onTranscript({ committed: '', interim: 'first words', corrected: null }));
    expect(textbox).toHaveValue('Draft: first words');
    await user.click(screen.getByRole('button', { name: 'Mute' }));
    expect(first.stopped).toBe(true);
    expect(screen.getByRole('button', { name: 'Mic' })).toBeInTheDocument();
    expect(screen.queryByText(status)).not.toBeInTheDocument();
    expect(textbox).toHaveValue('Draft: first words');
    expect(fetchMock).not.toHaveBeenCalled();
    act(() => {
      first.callbacks.onTranscript({ committed: 'late words', interim: '', corrected: null });
      first.callbacks.onStatus('Late error');
    });
    expect(textbox).toHaveValue('Draft: first words');
    expect(screen.queryByText('Late error')).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Mic' }));
    const second = speechInputMock.instances[1];
    act(() => first.callbacks.onTranscript({ committed: 'stale restart', interim: '', corrected: null }));
    act(() => second.callbacks.onTranscript({ committed: 'more words', interim: '', corrected: null }));
    expect(textbox).toHaveValue('Draft: first words more words');
    fetchMock.mockResolvedValueOnce(eventStream({ delta: 'Reply.' }));
    await user.click(screen.getByRole('button', { name: '↑' }));
    expect(second.stopped).toBe(true);
    expect(await screen.findByRole('button', { name: 'Mic' })).toBeInTheDocument();
    expect(chatPayload(fetchMock, 0).messages.at(-1)?.content).toBe('Draft: first words more words');
  });

  it('keeps a pre-token interruption and tells the next response it ended before any answer text', async () => {
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

    expect(await screen.findByText('Interrupted')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Mic' })).toBeInTheDocument();
    await user.type(screen.getByRole('textbox', { name: 'Message' }), 'How many r letters are in strawberry?');
    await user.click(screen.getByRole('button', { name: '↑' }));
    expect(await screen.findByText('STRAWBERRY_REPLY')).toBeInTheDocument();

    await waitFor(() => expect(fetchMock.mock.calls.filter(([url]) => String(url).endsWith('/api/chat'))).toHaveLength(2));
    expect(chatPayload(fetchMock, 1).messages).toEqual([
      { role: 'user', content: 'Explain the causes in detail' },
      { role: 'assistant', content: '[Interrupted before any answer text was displayed.]' },
      { role: 'user', content: 'How many r letters are in strawberry?' },
    ]);
  });

  it('keeps partial output marked Interrupted and rebuilds context through the exact visible cutoff', async () => {
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
    expect(await screen.findByText('Interrupted')).toBeInTheDocument();
    expect(screen.getAllByText('Interrupted')).toHaveLength(1);
    expect(screen.getByText('Give a detailed account of the consequences').closest('article')).not.toHaveClass('stale');
    expect(screen.getByText('PARTIAL_ANSWER').closest('article')).not.toHaveClass('stale');

    await user.type(textbox, 'What were the consequences?');
    await user.click(screen.getByRole('button', { name: '↑' }));
    expect(await screen.findByText('THIRD_ANSWER')).toBeInTheDocument();

    expect(chatPayload(fetchMock, 2).messages).toEqual([
      { role: 'user', content: 'Explain the Thirty Years’ War' },
      { role: 'assistant', content: 'FIRST_ANSWER' },
      { role: 'user', content: 'Give a detailed account of the consequences' },
      { role: 'assistant', content: '[Interrupted. The answer ended at this exact visible cutoff; no later text was shown.]\n\nPARTIAL_ANSWER' },
      { role: 'user', content: 'What were the consequences?' },
    ]);
  });

  it('keeps a completed answer in context when only speech playback is stopped', async () => {
    fetchMock.mockResolvedValueOnce(eventStream({ delta: 'COMPLETE_ANSWER' }));
    fetchMock.mockResolvedValueOnce(eventStream({ delta: 'FOLLOW_UP' }));
    const user = userEvent.setup();
    render(<App />);
    const textbox = screen.getByRole('textbox', { name: 'Message' });
    await user.type(textbox, 'First question');
    await user.click(screen.getByRole('button', { name: '↑' }));
    expect(await screen.findByText('COMPLETE_ANSWER')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Play' }));
    await user.click(screen.getByRole('button', { name: 'Stop' }));
    expect(screen.getByText('COMPLETE_ANSWER').closest('article')).not.toHaveTextContent('Interrupted');

    await user.type(textbox, 'Follow up');
    await user.click(screen.getByRole('button', { name: '↑' }));
    expect(await screen.findByText('FOLLOW_UP')).toBeInTheDocument();
    expect(chatPayload(fetchMock, 1).messages).toEqual([
      { role: 'user', content: 'First question' },
      { role: 'assistant', content: 'COMPLETE_ANSWER' },
      { role: 'user', content: 'Follow up' },
    ]);
  });

  it('dims and excludes both sides of a turn when the request fails', async () => {
    fetchMock.mockResolvedValueOnce(eventStream({ delta: 'EARLIER_ANSWER' }));
    fetchMock.mockResolvedValueOnce(eventStream({ delta: 'PARTIAL_BEFORE_ERROR' }, { error: 'Provider failed.' }));
    fetchMock.mockResolvedValueOnce(eventStream({ delta: 'RECOVERED_ANSWER' }));
    const user = userEvent.setup();
    render(<App />);
    const textbox = screen.getByRole('textbox', { name: 'Message' });
    await user.type(textbox, 'Earlier question');
    await user.click(screen.getByRole('button', { name: '↑' }));
    expect(await screen.findByText('EARLIER_ANSWER')).toBeInTheDocument();

    await user.type(textbox, 'Question that fails');
    await user.click(screen.getByRole('button', { name: '↑' }));
    expect(await screen.findByText('Provider failed.')).toBeInTheDocument();
    expect(screen.getByText('Question that fails').closest('article')).toHaveClass('stale');
    expect(screen.getByText('PARTIAL_BEFORE_ERROR').closest('article')).toHaveClass('stale');
    expect(screen.getByText('Error').closest('article')).toHaveClass('stale');

    await user.type(textbox, 'Try again with context');
    await user.click(screen.getByRole('button', { name: '↑' }));
    expect(await screen.findByText('RECOVERED_ANSWER')).toBeInTheDocument();
    expect(chatPayload(fetchMock, 2).messages).toEqual([
      { role: 'user', content: 'Earlier question' },
      { role: 'assistant', content: 'EARLIER_ANSWER' },
      { role: 'user', content: 'Try again with context' },
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
      expect(screen.getByRole('status', { name: 'WebMCP tools active' })).toBeInTheDocument();
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
