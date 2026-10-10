import { afterEach, describe, expect, it, vi } from 'vitest';
import { Dialog, DialogAudio, DialogTurn } from './dialog';

const transport = vi.hoisted(() => ({ latest: null as any }));
vi.mock('./speechInput', () => ({ SpeechInput: class {
  sent: unknown[] = [];
  stopped = false;
  constructor(_api: string, _token: unknown, public callbacks: any, public native: any) { transport.latest = this; }
  async start() { this.native.onReady(false); }
  stop() { this.stopped = true; }
  sendMessage(value: unknown) { this.sent.push(value); }
} }));

class Audio {
  static latest: Audio;
  currentTime = 1;
  destination = {};
  sources: any[] = [];
  buffers: Float32Array[] = [];
  constructor() { Audio.latest = this; }
  resume = vi.fn(async () => {});
  close = vi.fn(async () => {});
  createBuffer(_channels: number, length: number, rate: number) {
    const samples = new Float32Array(length);
    this.buffers.push(samples);
    return { duration: length / rate, getChannelData: () => samples };
  }
  createBufferSource() {
    const source = { buffer: null, connect: vi.fn(), disconnect: vi.fn(), start: vi.fn(), stop: vi.fn(), onended: null };
    this.sources.push(source);
    return source;
  }
}

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

function setup() {
  vi.stubGlobal('AudioContext', Audio);
  const turns: DialogTurn[] = [];
  const onError = vi.fn();
  const invokeTool = vi.fn(async () => ({ ok: true }));
  const onStatus = vi.fn();
  const dialog = new Dialog('', () => 'session-token', { onTurn: turn => turns.push(turn), onStatus, onError, invokeTool }, [{ role: 'user', content: 'Earlier question' }, { role: 'assistant', content: 'Earlier answer' }]);
  return { dialog, turns, onError, invokeTool, onStatus };
}

describe('native Dialog', () => {
  it('seeds history once, combines transcript deltas, plays every audio part, and handles interruption', async () => {
    const { dialog, turns } = setup();
    await dialog.start();
    const input = transport.latest;
    expect(input.sent[0]).toMatchObject({ clientContent: { turns: [{ role: 'user' }, { role: 'model' }], turnComplete: false } });
    input.native.onReady(true);
    expect(input.sent).toHaveLength(1);
    input.native.onMessage({ serverContent: { inputTranscription: { text: 'Hello' } } });
    input.native.onMessage({ serverContent: { inputTranscription: { text: ' there' }, outputTranscription: { text: 'Hi' }, modelTurn: { parts: [{ inlineData: { data: 'AIAAQA==', mimeType: 'audio/pcm;rate=24000' } }, { inlineData: { data: 'AIAAQA==', mimeType: 'audio/pcm;rate=24000' } }] } } });
    expect(turns.at(-1)).toMatchObject({ input: 'Hello there', output: 'Hi', status: 'pending' });
    expect(Audio.latest.sources).toHaveLength(2);
    input.native.onMessage({ serverContent: { interrupted: true } });
    expect(turns.at(-1)?.status).toBe('interrupted');
    expect(Audio.latest.sources.every(s => s.stop.mock.calls.length === 1)).toBe(true);
    input.native.onMessage({ serverContent: { inputTranscription: { text: 'Next' }, outputTranscription: { text: 'Okay' }, turnComplete: true } });
    expect(turns.at(-1)).toMatchObject({ input: 'Next', output: 'Okay', status: 'complete' });
    expect(turns.at(-1)?.userId).not.toBe(turns[0].userId);
    dialog.stop();
    const count = turns.length;
    input.native.onMessage({ serverContent: { inputTranscription: { text: 'stale' } } });
    expect(turns).toHaveLength(count);
    expect(input.stopped).toBe(true);
    expect(Audio.latest.close).toHaveBeenCalled();
  });

  it('uses shared tools and ignores canceled or late tool results', async () => {
    const { dialog, invokeTool } = setup();
    await dialog.start();
    const input = transport.latest;
    input.native.onMessage({ toolCall: { functionCalls: [{ id: '1', name: 'set_theme', args: { theme: 'dark' } }] } });
    await vi.waitFor(() => expect(input.sent.at(-1)).toMatchObject({ toolResponse: { functionResponses: [{ id: '1', response: { ok: true } }] } }));
    expect(invokeTool).toHaveBeenCalledWith('set_theme', { theme: 'dark' }, expect.any(AbortSignal));
    input.native.onMessage({ toolCallCancellation: { ids: ['2'] }, toolCall: { functionCalls: [{ id: '2', name: 'reset_ui' }] } });
    await Promise.resolve();
    expect(invokeTool).toHaveBeenCalledTimes(1);
    let resolve!: (value: { ok: boolean }) => void;
    invokeTool.mockReturnValueOnce(new Promise(r => { resolve = r; }));
    input.native.onMessage({ toolCall: { functionCalls: [{ id: '3', name: 'reset_ui' }] } });
    await Promise.resolve();
    dialog.stop();
    resolve({ ok: true });
    await Promise.resolve();
    expect(input.sent).toHaveLength(2);
  });

  it('stops capture and marks partial answers on provider failure', async () => {
    const { dialog, turns, onError } = setup();
    await dialog.start();
    transport.latest.native.onMessage({ serverContent: { inputTranscription: { text: 'Question' }, outputTranscription: { text: 'Partial' } } });
    transport.latest.native.onError(new Error('Quota exhausted'));
    expect(turns.at(-1)?.status).toBe('error');
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ message: 'Quota exhausted' }));
    expect(transport.latest.stopped).toBe(true);
  });

  it('decodes signed little-endian PCM and schedules chunks without overlap', async () => {
    vi.stubGlobal('AudioContext', Audio);
    const player = new DialogAudio();
    await player.unlock();
    player.append('AIAAQA==', 'audio/pcm;rate=24000');
    player.append('AIAAQA==', 'audio/pcm;rate=24000');
    expect([...Audio.latest.buffers[0]]).toEqual([-1, .5]);
    const starts = Audio.latest.sources.map(s => s.start.mock.calls[0][0]);
    expect(starts[1] - starts[0]).toBeCloseTo(2 / 24000);
    expect(() => player.append('AA==', 'audio/pcm;rate=24000')).toThrow('invalid PCM');
    player.dispose();
  });
});
