import { afterEach, describe, expect, it, vi } from 'vitest';
import { SpeechInput } from './speechInput';

class FakeSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSED = 3;
  static latest: FakeSocket;
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
    if (JSON.parse(value).setup) queueMicrotask(() => this.onmessage?.({ data: JSON.stringify({ setupComplete: {} }) } as MessageEvent));
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
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    statuses.length = 0;
    transcripts.length = 0;
    track.stop.mockClear();
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

  it('opens the constrained Live session, streams PCM, displays interim/final text, and releases the microphone', async () => {
    const { controller } = setup();
    await controller.start();
    const audio = FakeAudioContext.latest;
    expect(FakeSocket.latest.url).toContain('access_token=ephemeral-token');
    expect(FakeSocket.latest.url).toContain('BidiGenerateContentConstrained');
    expect(JSON.parse(FakeSocket.latest.sent[0])).toMatchObject({ setup: {
      model: 'models/gemini-3.5-transcribe-live',
      inputAudioTranscription: { languageCodes: [] },
    } });
    audio.processor.onaudioprocess?.({ inputBuffer: { getChannelData: () => new Float32Array(4800).fill(.25) } } as unknown as AudioProcessingEvent);
    const audioMessage = JSON.parse(FakeSocket.latest.sent.at(-1)!);
    expect(audioMessage.realtimeInput.audio.mimeType).toBe('audio/pcm;rate=16000');
    expect(atob(audioMessage.realtimeInput.audio.data).length).toBe(3200);

    FakeSocket.latest.onmessage?.({ data: JSON.stringify({ serverContent: { interimInputTranscription: { text: 'hello worl' } } }) } as MessageEvent);
    FakeSocket.latest.onmessage?.({ data: JSON.stringify({ serverContent: { inputTranscription: { text: 'hello world' } } }) } as MessageEvent);
    expect(transcripts.at(-2)).toMatchObject({ committed: '', interim: 'hello worl' });
    expect(transcripts.at(-1)).toMatchObject({ committed: 'hello world', interim: '', corrected: 'hello world' });
    controller.stop();
    expect(track.stop).toHaveBeenCalledOnce();
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
    const { controller } = setup(new Response('{}', { status: 502 }));
    Object.defineProperty(window, 'SpeechRecognition', { configurable: true, value: FakeRecognition });
    await controller.start();
    expect(FakeRecognition.instance.lang).toBe('en-US');
    expect(FakeRecognition.instance.continuous).toBe(true);
    FakeRecognition.instance.onresult?.({ resultIndex: 0, results: [{ isFinal: true, 0: { transcript: 'fallback works' } }] });
    expect(transcripts.at(-1)).toMatchObject({ committed: 'fallback works' });
    expect(statuses.some(status => status.includes('Continuing in English'))).toBe(true);
    controller.stop();
  });
});
