import { afterEach, describe, expect, it, vi } from 'vitest';
import { NativeSession, SpeechInput, TranscriptUpdate } from './speechInput';

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
  resume = vi.fn(async (): Promise<void> => undefined);
  close = vi.fn(async () => undefined);
  createMediaStreamSource = vi.fn(() => this.source);
  createScriptProcessor = vi.fn(() => this.processor);
  createGain = vi.fn(() => this.gain);
}

describe('Gemini Live dictation', () => {
  const track = { stop: vi.fn() };
  const stream = { getTracks: () => [track] } as unknown as MediaStream;
  const statuses: string[] = [];
  const transcripts: TranscriptUpdate[] = [];
  const speechEvents: string[] = [];

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    statuses.length = 0;
    transcripts.length = 0;
    speechEvents.length = 0;
    track.stop.mockClear();
    FakeSocket.setupReply = { setupComplete: {} };
    FakeSocket.binaryFrames = true;
    Object.defineProperty(window, 'SpeechRecognition', { configurable: true, value: undefined });
  });

  function setup(tokenResponse: Response = Response.json({ token: 'ephemeral-token' }), native?: NativeSession) {
    vi.stubGlobal('WebSocket', FakeSocket);
    vi.stubGlobal('fetch', vi.fn(async () => tokenResponse));
    vi.stubGlobal('AudioContext', FakeAudioContext);
    Object.defineProperty(window, 'AudioContext', { configurable: true, value: FakeAudioContext });
    Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: { getUserMedia: vi.fn(async () => stream) } });
    const controller = new SpeechInput('http://localhost:8080', () => 'session-token', {
      onStatus: value => statuses.push(value), onTranscript: value => transcripts.push(value),
      onSpeechStarted: () => speechEvents.push('started'),
      onSpeechEnded: elapsed => speechEvents.push(`ended:${elapsed ?? ''}`),
    }, native);
    return { controller };
  }

  it('uses constrained Dialog setup, forwards binary audio/tool events, and fails without browser fallback', async () => {
    const native = { onMessage: vi.fn(), onReady: vi.fn(), onError: vi.fn() };
    const config = { model: 'models/gemini-2.5-flash-native-audio-preview-12-2025', generationConfig: { responseModalities: ['AUDIO'] }, inputAudioTranscription: {}, outputAudioTranscription: {} };
    const { controller } = setup(Response.json({ token: 'dialog-token', setup: config }), native);
    await controller.start();
    expect(fetch).toHaveBeenCalledWith('http://localhost:8080/api/dialog-token', expect.anything());
    expect(JSON.parse(FakeSocket.latest.sent[0])).toEqual({ setup: { ...config, sessionResumption: {} } });
    expect(native.onReady).toHaveBeenCalledWith(false);
    const content = { serverContent: { modelTurn: { parts: [{ inlineData: { data: 'AAAA', mimeType: 'audio/pcm;rate=24000' } }] } }, toolCall: { functionCalls: [{ id: '1', name: 'reset_ui', args: {} }] } };
    FakeSocket.latest.receive(content);
    expect(native.onMessage).toHaveBeenCalledWith(content);
    const socket = FakeSocket.latest;
    socket.receive({ error: { message: 'Quota exhausted' } });
    expect(native.onError).toHaveBeenCalledWith(expect.objectContaining({ message: 'Quota exhausted' }));
    expect(track.stop).toHaveBeenCalled();
    const count = native.onMessage.mock.calls.length;
    socket.receive(content);
    expect(native.onMessage).toHaveBeenCalledTimes(count);
    expect(statuses).not.toContain('Browser is listening');
  });

  it('detects speech boundaries, sends the final audio packet, and flushes Gemini at the end of a phrase', async () => {
    const { controller } = setup();
    await controller.start();
    const audio = FakeAudioContext.latest;
    const frame = (value: number) => audio.processor.onaudioprocess?.({
      inputBuffer: { getChannelData: () => new Float32Array(4800).fill(value) },
    } as unknown as AudioProcessingEvent);
    const before = FakeSocket.latest.sent.length;
    frame(.2);
    frame(.2);
    expect(speechEvents).toEqual(['started']);
    frame(0);
    expect(speechEvents).toEqual(['started']);
    frame(0);
    frame(0);
    frame(0);
    frame(0);
    frame(0);
    expect(speechEvents).toEqual(['started', 'ended:600']);
    const packets = FakeSocket.latest.sent.slice(before).map(packet => JSON.parse(packet));
    expect(packets.at(-1)).toEqual({ realtimeInput: { audioStreamEnd: true } });
    expect(packets.filter(packet => packet.realtimeInput.audio)).toHaveLength(8);
    controller.stop();
  });

  it.each([true, false])('handles binary frames=%s for setup and transcripts, streams PCM, and releases the microphone', async binary => {
    FakeSocket.binaryFrames = binary;
    const { controller } = setup();
    await controller.start();
    const audio = FakeAudioContext.latest;
    expect(FakeSocket.latest.url).toContain('access_token=ephemeral-token');
    expect(FakeSocket.latest.url).toContain('BidiGenerateContentConstrained');
    expect(FakeSocket.latest.binaryType).toBe('arraybuffer');
    expect(statuses).toEqual(['Connecting to Gemini Live…', 'Gemini is listening']);
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
    expect(transcripts.at(-1)).toMatchObject({ committed: 'hello world', interim: '', corrected: null });
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
    expect(statuses).not.toContain('Gemini is listening');
    expect(FakeSocket.latest.readyState).toBe(FakeSocket.CLOSED);
    controller.stop();
  });

  it.each([
    { before: '', after: 'hello', corrected: null },
    { before: 'hello', after: 'hello world', corrected: null },
    { before: 'hello worl', after: 'hello world', corrected: null },
    { before: 'hello world', after: 'hello world', corrected: null },
    { before: ' hello  world ', after: 'hello world', corrected: null },
    { before: 'cafe\u0301', after: 'café', corrected: null },
    { before: 'I like cats today', after: 'I like dogs today', corrected: { before: 'cats', after: 'dogs' } },
    { before: 'I really like tea', after: 'I like tea', corrected: { before: 'really', after: '' } },
    { before: 'I like tea', after: 'I really like tea', corrected: { before: '', after: 'really' } },
    { before: 'Budapestre megyek holnap', after: 'Szegedre megyek holnap', corrected: { before: 'Budapestre', after: 'Szegedre' } },
    { before: '你好', after: '你好世界', corrected: null },
  ])('distinguishes growth from revisions: "$before" → "$after"', async ({ before, after, corrected }) => {
    const { controller } = setup();
    await controller.start();
    FakeSocket.latest.receive({ serverContent: { interimInputTranscription: { text: before } } });
    expect(transcripts.at(-1)?.corrected).toBeNull();
    FakeSocket.latest.receive({ serverContent: { interimInputTranscription: { text: after } } });
    expect(transcripts.at(-1)).toEqual({ committed: '', interim: after, corrected });
    controller.stop();
  });

  it('detects final revisions once, removes deleted words, and treats the next utterance as new text', async () => {
    const { controller } = setup();
    await controller.start();
    FakeSocket.latest.receive({ serverContent: { interimInputTranscription: { text: 'I really like tea' } } });
    FakeSocket.latest.receive({ serverContent: { inputTranscription: { text: 'I like tea' } } });
    expect(transcripts.at(-1)).toEqual({ committed: 'I like tea', interim: '', corrected: { before: 'really', after: '' } });
    FakeSocket.latest.receive({ serverContent: { interimInputTranscription: { text: 'and coffee' } } });
    expect(transcripts.at(-1)).toEqual({ committed: 'I like tea', interim: 'and coffee', corrected: null });
    FakeSocket.latest.receive({ serverContent: { inputTranscription: { text: 'and coffee too' } } });
    expect(transcripts.at(-1)).toEqual({ committed: 'I like tea and coffee too', interim: '', corrected: null });
    controller.stop();
  });

  it('reports removal of the whole interim without retaining deleted words', async () => {
    const { controller } = setup();
    await controller.start();
    FakeSocket.latest.receive({ serverContent: { interimInputTranscription: { text: 'false start' } } });
    FakeSocket.latest.receive({ serverContent: { interimInputTranscription: { text: '' } } });
    expect(transcripts.at(-1)).toEqual({ committed: '', interim: '', corrected: { before: 'false start', after: '' } });
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
    expect(statuses).not.toContain('Gemini is listening');
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
    expect(statuses).toContain('Browser is listening');
    FakeRecognition.instance.onresult?.({ resultIndex: 0, results: [{ isFinal: true, 0: { transcript: 'fallback works' } }] });
    expect(transcripts.at(-1)).toMatchObject({ committed: 'fallback works' });
    expect(statuses.some(status => status.includes('Google reported invalid token constraints') && status.includes('Continuing in English'))).toBe(true);
    controller.stop();
    const statusCount = statuses.length;
    FakeRecognition.instance.onend?.();
    FakeRecognition.instance.onerror?.({ error: 'network' });
    FakeRecognition.instance.onresult?.({ resultIndex: 0, results: [{ isFinal: true, 0: { transcript: 'late fallback' } }] });
    expect(FakeRecognition.instance.stop).toHaveBeenCalledOnce();
    expect(FakeRecognition.instance.start).toHaveBeenCalledOnce();
    expect(statuses).toHaveLength(statusCount);
    expect(transcripts.at(-1)?.committed).toBe('fallback works');
  });

  it('releases a microphone granted after Mute without starting Live', async () => {
    const { controller } = setup();
    let grant!: (value: MediaStream) => void;
    vi.mocked(navigator.mediaDevices.getUserMedia).mockReturnValueOnce(new Promise(resolve => { grant = resolve; }));
    const starting = controller.start();
    controller.stop();
    grant(stream);
    await starting;
    expect(track.stop).toHaveBeenCalledOnce();
    expect(fetch).not.toHaveBeenCalled();
    expect(statuses).toEqual(['Connecting to Gemini Live…']);
  });

  it('does not create audio nodes when Mute is clicked during audio-context startup', async () => {
    const { controller } = setup();
    let resumed!: () => void;
    const pendingResume = new Promise<void>(resolve => { resumed = resolve; });
    class PendingAudioContext extends FakeAudioContext {
      resume = vi.fn(() => pendingResume);
    }
    Object.defineProperty(window, 'AudioContext', { configurable: true, value: PendingAudioContext });
    const starting = controller.start();
    await vi.waitFor(() => expect(FakeAudioContext.latest.resume).toHaveBeenCalled());
    controller.stop();
    resumed();
    await starting;
    expect(track.stop).toHaveBeenCalledOnce();
    expect(FakeAudioContext.latest.close).toHaveBeenCalledOnce();
    expect(FakeAudioContext.latest.createMediaStreamSource).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });
});
