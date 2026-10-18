import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, expect, it, vi } from 'vitest';
import App from './App';

// Exercise production's same-origin access routing with the real voice controllers.
vi.hoisted(() => { vi.stubEnv('VITE_ACCESS_API_URL', 'same-origin'); });
afterEach(() => { vi.unstubAllEnvs(); });

class Socket {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSED = 3;
  static latest: Socket;
  readyState = 0;
  binaryType = 'blob';
  sent: any[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(public url: string) {
    Socket.latest = this;
    queueMicrotask(() => { this.readyState = 1; this.onopen?.(); });
  }
  send(raw: string) {
    const message = JSON.parse(raw);
    this.sent.push(message);
    if (message.setup) queueMicrotask(() => this.receive({ setupComplete: {} }));
  }
  receive(value: unknown) { this.onmessage?.({ data: JSON.stringify(value) }); }
  close() { this.readyState = 3; this.onclose?.(); }
}

class Audio {
  static instances: Audio[] = [];
  sampleRate = 48000;
  currentTime = 1;
  destination = {};
  sources: any[] = [];
  processor = { onaudioprocess: null as null | ((event: any) => void), connect: vi.fn(), disconnect: vi.fn() };
  constructor() { Audio.instances.push(this); }
  resume = vi.fn(async () => {});
  close = vi.fn(async () => {});
  createGain() { return { gain: { value: 1 }, connect: vi.fn(), disconnect: vi.fn() }; }
  createMediaStreamSource() { return { connect: vi.fn(), disconnect: vi.fn() }; }
  createScriptProcessor() { return this.processor; }
  createBuffer(_channels: number, length: number, rate: number) {
    return { duration: length / rate, getChannelData: () => new Float32Array(length) };
  }
  createBufferSource() {
    const source = { buffer: null, connect: vi.fn(), disconnect: vi.fn(), start: vi.fn(), stop: vi.fn(), onended: null };
    this.sources.push(source);
    return source;
  }
}

function sessionAt(expiry: number) {
  return btoa(`${expiry}.test-signature`).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

it('opens the gate immediately for an expired stored session without waking Render', async () => {
  sessionStorage.setItem('chat-token', sessionAt(Math.floor(Date.now() / 1000) - 1));
  vi.stubGlobal('fetch', vi.fn(() => { throw new Error('No network expected'); }));
  render(<App />);
  expect(await screen.findByRole('textbox', { name: 'Invitation code' })).toBeInTheDocument();
  expect(sessionStorage.getItem('chat-token')).toBeNull();
  expect(fetch).not.toHaveBeenCalled();
});

it('detects overnight expiry when the tab becomes visible and preserves the draft', async () => {
  const now = Date.now();
  const clock = vi.spyOn(Date, 'now').mockReturnValue(now);
  sessionStorage.setItem('chat-token', sessionAt(Math.floor(now / 1000) + 60));
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({ token: 'renewed-session' })));
  const user = userEvent.setup();
  render(<App />);
  fireEvent.change(screen.getByRole('textbox', { name: 'Message' }), { target: { value: 'Morning question' } });
  clock.mockReturnValue(now + 61_000);
  fireEvent(document, new Event('visibilitychange'));
  expect(await screen.findByRole('textbox', { name: 'Invitation code' })).toBeInTheDocument();
  expect(fetch).not.toHaveBeenCalled();
  await user.type(screen.getByRole('textbox', { name: 'Invitation code' }), 'valid-invitation');
  await user.click(screen.getByRole('button', { name: /Continue/ }));
  expect(await screen.findByRole('textbox', { name: 'Message' })).toHaveValue('Morning question');
  expect(vi.mocked(fetch).mock.calls.map(([url]) => url)).toEqual(['/api/session']);
});

it('checks expiry again on Send even when the composer stayed focused overnight', async () => {
  const now = Date.now();
  const clock = vi.spyOn(Date, 'now').mockReturnValue(now);
  sessionStorage.setItem('chat-token', sessionAt(Math.floor(now / 1000) + 60));
  vi.stubGlobal('fetch', vi.fn(() => { throw new Error('No network expected'); }));
  render(<App />);
  const composer = screen.getByRole('textbox', { name: 'Message' });
  fireEvent.change(composer, { target: { value: 'Morning question' } });
  clock.mockReturnValue(now + 61_000);
  fireEvent.keyDown(composer, { key: 'Enter' });
  expect(await screen.findByRole('textbox', { name: 'Invitation code' })).toBeInTheDocument();
  expect(fetch).not.toHaveBeenCalled();
  expect(screen.queryByText(/Thinking/)).not.toBeInTheDocument();
});

it('awaits the in-flight Netlify focus check before Send and never contacts sleeping Render for an invalid session', async () => {
  sessionStorage.setItem('chat-token', 'stored-session');
  let finish!: (response: Response) => void;
  const pending = new Promise<Response>(resolve => { finish = resolve; });
  vi.stubGlobal('fetch', vi.fn((url: RequestInfo | URL) => {
    if (url === '/api/session/check') return pending;
    throw new Error('Render must not be contacted');
  }));
  render(<App />);
  const composer = screen.getByRole('textbox', { name: 'Message' });
  fireEvent.focus(composer);
  fireEvent.change(composer, { target: { value: 'Morning question' } });
  fireEvent.keyDown(composer, { key: 'Enter' });
  fireEvent.keyDown(composer, { key: 'Enter' });
  expect(screen.getByText('Checking session…')).toBeInTheDocument();
  expect(screen.queryByText(/Thinking/)).not.toBeInTheDocument();
  expect(fetch).toHaveBeenCalledTimes(1);
  await act(async () => finish(Response.json({}, { status: 401 })));
  expect(await screen.findByRole('textbox', { name: 'Invitation code' })).toBeInTheDocument();
  expect(fetch).toHaveBeenCalledTimes(1);
});

it('keeps the question without calling Render when Netlify session validation fails', async () => {
  sessionStorage.setItem('chat-token', 'stored-session');
  vi.stubGlobal('fetch', vi.fn(async (url: RequestInfo | URL) => {
    if (url === '/api/session/check') return Response.json({}, { status: 503 });
    throw new Error('Render must not be contacted');
  }));
  render(<App />);
  const composer = screen.getByRole('textbox', { name: 'Message' });
  fireEvent.change(composer, { target: { value: 'Morning question' } });
  fireEvent.keyDown(composer, { key: 'Enter' });
  expect(await screen.findByText('Could not verify your session. Your question is kept; try sending again.')).toBeInTheDocument();
  expect(composer).toHaveValue('Morning question');
  expect(vi.mocked(fetch).mock.calls.map(([url]) => url)).toEqual(['/api/session/check']);
});

it('bounds a stalled session check and keeps the question available for retry', async () => {
  vi.useFakeTimers();
  try {
    sessionStorage.setItem('chat-token', 'stored-session');
    vi.stubGlobal('fetch', vi.fn((_url: RequestInfo | URL, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new DOMException('Timed out', 'AbortError')), { once: true });
    })));
    render(<App />);
    const composer = screen.getByRole('textbox', { name: 'Message' });
    fireEvent.change(composer, { target: { value: 'Morning question' } });
    fireEvent.keyDown(composer, { key: 'Enter' });
    await act(async () => { await vi.advanceTimersByTimeAsync(8000); });
    expect(screen.getByText('Could not verify your session. Your question is kept; try sending again.')).toBeInTheDocument();
    expect(composer).toHaveValue('Morning question');
    expect(screen.getByRole('button', { name: '↑' })).toBeEnabled();
    expect(fetch).toHaveBeenCalledTimes(1);
  } finally { vi.useRealTimers(); }
});

it('authenticates, runs Dialog and Dictation, and restarts with Render unreachable', async () => {
  Audio.instances = [];
  const tracks = { stop: vi.fn() };
  vi.stubGlobal('WebSocket', Socket);
  vi.stubGlobal('AudioContext', Audio);
  Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: {
    getUserMedia: vi.fn(async () => ({ getTracks: () => [tracks] })),
  } });
  const requests: string[] = [];
  const backendRequests: string[] = [];
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    requests.push(url);
    if (url === '/api/session') return Response.json({ token: 'signed-test-session' });
    if (url === '/api/session/check') return Response.json({ ok: true });
    if (url === '/api/live-token') return Response.json({ token: 'auth_tokens/dictation' });
    if (url === '/api/dialog-token') return Response.json({ token: 'auth_tokens/dialog', setup: {
      model: 'models/gemini-2.5-flash-native-audio-preview-12-2025',
      generationConfig: { responseModalities: ['AUDIO'] }, inputAudioTranscription: {}, outputAudioTranscription: {},
    } });
    backendRequests.push(url);
    throw new Error('Render is unavailable');
  }));
  const user = userEvent.setup();
  render(<App />);
  expect(requests).toEqual([]);
  await user.type(screen.getByRole('textbox', { name: 'Invitation code' }), 'test-invitation');
  await user.click(screen.getByRole('button', { name: /Continue/ }));
  await screen.findByRole('button', { name: 'Start Dialog' });
  expect(requests).toEqual(['/api/session']);
  await user.click(screen.getByRole('button', { name: 'Start Dialog' }));
  await screen.findByText('Dialog is listening');
  expect(Socket.latest.url).toMatch(/^wss:\/\/generativelanguage.googleapis.com\//);
  const capture = Audio.instances.find(audio => audio.processor.onaudioprocess)!;
  act(() => capture.processor.onaudioprocess?.({ inputBuffer: { getChannelData: () => new Float32Array(4800).fill(0.2) } }));
  expect(Socket.latest.sent.some(message => message.realtimeInput?.audio?.data)).toBe(true);
  await act(async () => Socket.latest.receive({ serverContent: {
    inputTranscription: { text: 'Hello from the microphone' },
    outputTranscription: { text: 'Hello from Gemini' },
    modelTurn: { parts: [{ inlineData: { data: 'AAAAAA==', mimeType: 'audio/pcm;rate=24000' } }] },
  } }));
  expect(screen.getByText('Hello from the microphone')).toBeInTheDocument();
  expect(screen.getByText('Hello from Gemini')).toBeInTheDocument();
  const playing = Audio.instances.flatMap(audio => audio.sources);
  expect(playing).toHaveLength(1);
  expect(playing[0].start).toHaveBeenCalled();
  act(() => Socket.latest.receive({ serverContent: { interrupted: true } }));
  expect(playing[0].stop).toHaveBeenCalled();
  await user.click(screen.getByRole('button', { name: 'End Dialog' }));
  expect(tracks.stop).toHaveBeenCalled();
  await user.click(screen.getByRole('button', { name: 'Start Dialog' }));
  await screen.findByText('Dialog is listening');
  await user.click(screen.getByRole('button', { name: 'End Dialog' }));
  await user.click(screen.getByRole('button', { name: 'Mic' }));
  await screen.findByText('Gemini is listening');
  act(() => Socket.latest.receive({ serverContent: { inputTranscription: { text: 'Dictated draft', finished: true } } }));
  await waitFor(() => expect(screen.getByRole('textbox', { name: 'Message' })).toHaveValue('Dictated draft'));
  await user.click(screen.getByRole('button', { name: 'Mute' }));
  expect(requests.filter(url => url === '/api/dialog-token')).toHaveLength(2);
  expect(requests).toContain('/api/live-token');
  expect(backendRequests).toEqual([]);
});
