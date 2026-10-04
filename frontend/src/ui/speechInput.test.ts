import { afterEach, describe, expect, it, vi } from 'vitest';
import { SpeechInput } from './speechInput';

function binaryJson(value: unknown): ArrayBuffer {
  return new Uint8Array(new TextEncoder().encode(JSON.stringify(value))).buffer;
}

class FakeSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSED = 3;
  static latest: FakeSocket;
  static setupReply: unknown = { setupComplete: {} };
  static binaryFrames = true;
  binaryType: BinaryType = 'blob';
  readyState: number = WebSocket.CONNECTING;
  onopen: ((event: Event) => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  onclose: ((event: CloseEvent) => void) | null = null;
  sent: string[] = [];
  constructor(public url: string) {
    FakeSocket.latest = this;
    queueMicrotask(() => { this.readyState = WebSocket.OPEN; this.onopen?.(new Event('open')); });
  }
  send(value: string) {
    this.sent.push(value);
    if (JSON.parse(value).setup && FakeSocket.setupReply !== null) queueMicrotask(() => this.receive(FakeSocket.setupReply));
  }
  receive(value: unknown) {
    const data = FakeSocket.binaryFrames
      ? (this.binaryType === 'arraybuffer' ? binaryJson(value) : new Blob([JSON.stringify(value)]))
      : JSON.stringify(value);
    this.onmessage?.({ data } as MessageEvent);
  }
  close() { this.readyState = WebSocket.CLOSED; this.onclose?.({} as CloseEvent); }
}

class FakeAudioContext {
  static latest: FakeAudioContext;
  constructor() { FakeAudioContext.latest = this; }
  sampleRate = 48000;
  destination = {} as AudioNode;
  processor = { onaudioprocess: null as ((event: AudioProcessingEvent) => void) | null, connect: vi.fn(), disconnect: vi.fn() } as unknown as ScriptProcessorNode;
  source = { connect: vi.fn(), disconnect: vi.fn() } as unknown as MediaStreamAudioSourceNode;
  gain = { gain: { value: 1 }, connect: vi.fn(), disconnect: vi.fn() } as unknown as GainNode;
  resume = vi.fn(async () => undefined);
  close = vi.fn(async () => undefined);
  createMediaStreamSource = vi.fn(() => this.source);
  createScriptProcessor = vi.fn(() => this.processor);
  createGain = vi.fn(() => this.gain);
}

describe('Gemini Live dictation', () => {
  const track = { stop: vi.fn() };
  const stream = { getTracks: () => [track] } as unknown as MediaStream;
  const statuses: string[] = [];
  const transcripts: Array<{ committed: string; interim: string; corrected: string }> = [];

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    statuses.length = 0;
    transcripts.length = 0;
    track.stop.mockClear();
    FakeSocket.setupReply = { setupComplete: {} };
    FakeSocket.binaryFrames = true;
    Object.defineProperty(window, 'SpeechRecognition', { configurable: true, value: undefined });
  });

  function setup(tokenResponse: Response = Response.json({ token: 'ephemeral-token' })) {
    vi.stubGlobal('WebSocket', FakeSocket);
    vi.stubGlobal('fetch', vi.fn(async () => tokenResponse));
    vi.stubGlobal('AudioContext', FakeAudioContext);
    Object.defineProperty(window, 'AudioContext', { configurable: true, value: FakeAudioContext });
    Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: { getUserMedia: vi.fn(async () => stream) } });
    const controller = new SpeechInput('http://localhost:8080', () => 'session-token', {
      onStatus: value => statuses.push(value), onTranscript: value => transcripts.push(value),
    });
    return { controller };
  }

  it.each([true, false])('handles binary frames=%s for setup and transcripts, streams PCM, and releases the microphone', async binary => {
    FakeSocket.binaryFrames = binary;
    const { controller } = setup();
    await controller.start();
    const audio = FakeAudioContext.latest;
    expect(FakeSocket.latest.url).toContain('access_token=ephemeral-token');
    expect(FakeSocket.latest.url).toContain('BidiGenerateContentConstrained');
    expect(FakeSocket.latest.binaryType).toBe('arraybuffer');
    expect(statuses).toEqual(['Connecting to Gemini Live…', 'Listening']);
    expect(JSON.parse(FakeSocket.latest.sent[0])).toMatchObject({ setup: {
      model: 'models/gemini-3.5-transcribe-live',
      inputAudioTranscription: { languageCodes: [] },
    } });
    audio.processor.onaudioprocess?.({ inputBuffer: { getChannelData: () => new Float32Array(4800).fill(.25) } } as unknown as AudioProcessingEvent);
    const audioMessage = JSON.parse(FakeSocket.latest.sent.at(-1)!);
    expect(audioMessage.realtimeInput.audio.mimeType).toBe('audio/pcm;rate=16000');
    expect(atob(audioMessage.realtimeInput.audio.data).length).toBe(3200);

    FakeSocket.latest.receive({ serverContent: { interimInputTranscription: { text: 'hello worl' } } });
    FakeSocket.latest.receive({ serverContent: { inputTranscription: { text: 'hello world' } } });
    expect(transcripts.at(-2)).toMatchObject({ committed: '', interim: 'hello worl' });
    expect(transcripts.at(-1)).toMatchObject({ committed: 'hello world', interim: '', corrected: 'hello world' });
    controller.stop();
    expect(track.stop).toHaveBeenCalledOnce();
    FakeSocket.latest.receive({ serverContent: { inputTranscription: { text: 'stale words' } } });
    expect(transcripts.at(-1)?.committed).toBe('hello world');
  });

  it('surfaces binary provider errors instead of waiting for a setup timeout', async () => {
    FakeSocket.setupReply = { error: { message: 'Transcription model is unavailable.' } };
    const { controller } = setup();
    await controller.start();
    expect(statuses.some(status => status.includes('Transcription model is unavailable.'))).toBe(true);
    expect(statuses).not.toContain('Listening');
    expect(FakeSocket.latest.readyState).toBe(FakeSocket.CLOSED);
    controller.stop();
  });

  it('fails explicitly on malformed frames and ignores subsequent messages from the abandoned socket', async () => {
    const { controller } = setup();
    await controller.start();
    const socket = FakeSocket.latest;
    socket.onmessage?.({ data: new Uint8Array([255]).buffer } as MessageEvent);
    const statusCount = statuses.length;
    socket.receive({ setupComplete: {} });
    socket.receive({ serverContent: { inputTranscription: { text: 'late words' } } });
    expect(statuses.some(status => status.includes('unreadable message'))).toBe(true);
    expect(statuses).toHaveLength(statusCount);
    expect(transcripts).toEqual([]);
    controller.stop();
  });

  it('keeps the setup timeout bounded and ignores a late setup confirmation', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    FakeSocket.setupReply = null;
    const { controller } = setup();
    const starting = controller.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(statuses).toEqual(['Connecting to Gemini Live…']);
    await vi.advanceTimersByTimeAsync(12000);
    await starting;
    expect(statuses.some(status => status.includes('setup timed out'))).toBe(true);
    FakeSocket.latest.receive({ setupComplete: {} });
    expect(statuses).not.toContain('Listening');
    expect(FakeSocket.latest.readyState).toBe(FakeSocket.CLOSED);
    controller.stop();
  });

  it('falls back to English browser recognition when Live token creation fails', async () => {
    class FakeRecognition {
      static instance: FakeRecognition;
      continuous = false;
      interimResults = false;
      lang = '';
      onresult: ((event: { resultIndex: number; results: ArrayLike<{ isFinal: boolean; 0: { transcript: string } }> }) => void) | null = null;
      onerror: ((event: { error?: string }) => void) | null = null;
      onend: (() => void) | null = null;
      start = vi.fn();
      stop = vi.fn();
      constructor() { FakeRecognition.instance = this; }
    }
    const { controller } = setup(Response.json({ error: 'Google reported invalid token constraints.' }, { status: 502 }));
    Object.defineProperty(window, 'SpeechRecognition', { configurable: true, value: FakeRecognition });
    await controller.start();
    expect(FakeRecognition.instance.lang).toBe('en-US');
    expect(FakeRecognition.instance.continuous).toBe(true);
    FakeRecognition.instance.onresult?.({ resultIndex: 0, results: [{ isFinal: true, 0: { transcript: 'fallback works' } }] });
    expect(transcripts.at(-1)).toMatchObject({ committed: 'fallback works' });
    expect(statuses.some(status => status.includes('Google reported invalid token constraints') && status.includes('Continuing in English'))).toBe(true);
    controller.stop();
  });
});
