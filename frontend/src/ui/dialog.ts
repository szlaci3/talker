import { SpeechInput } from './speechInput';

export type DialogTurn = { userId: string; assistantId: string; input: string; output: string; status: 'pending' | 'complete' | 'interrupted' | 'error' };
type History = Array<{ role: 'user' | 'assistant'; content: string }>;
export type DialogCallbacks = {
  onStatus: (status: string) => void;
  onTurn: (turn: DialogTurn) => void;
  onError: (error: Error) => void;
  invokeTool: (name: unknown, args: unknown, signal: AbortSignal) => Promise<unknown>;
};

// Schedule PCM chunks consecutively; stopping removes every queued source.
export class DialogAudio {
  private context: AudioContext | null = null;
  private sources = new Set<AudioBufferSourceNode>();
  private nextTime = 0;

  async unlock(): Promise<void> {
    this.context = new window.AudioContext();
    await this.context.resume();
  }

  append(data: string, mimeType: string): void {
    const context = this.context;
    if (!context) return;
    if (!/^audio\/pcm(?:;|$)/.test(mimeType)) throw new Error('Dialog returned an unsupported audio format.');
    const rate = Number(/rate=(\d+)/.exec(mimeType)?.[1] || 24000);
    if (rate < 8000 || rate > 48000 || data.length > 2_000_000) throw new Error('Dialog returned invalid audio.');
    const binary = atob(data);
    if (!binary.length || binary.length % 2) throw new Error('Dialog returned invalid PCM audio.');
    const bytes = Uint8Array.from(binary, c => c.charCodeAt(0));
    const pcm = new DataView(bytes.buffer);
    const buffer = context.createBuffer(1, bytes.length / 2, rate);
    const samples = buffer.getChannelData(0);
    for (let i = 0; i < samples.length; i++) samples[i] = pcm.getInt16(i * 2, true) / 32768;
    if (this.nextTime - context.currentTime > 30) throw new Error('Dialog audio playback fell too far behind. Please restart Dialog.');
    const source = context.createBufferSource();
    source.buffer = buffer;
    source.connect(context.destination);
    source.onended = () => { this.sources.delete(source); source.disconnect(); };
    this.sources.add(source);
    const start = Math.max(context.currentTime + .015, this.nextTime);
    source.start(start);
    this.nextTime = start + buffer.duration;
  }

  stop(): void {
    for (const source of this.sources) { source.stop(); source.disconnect(); }
    this.sources.clear();
    this.nextTime = 0;
  }

  dispose(): void {
    this.stop();
    void this.context?.close();
    this.context = null;
  }
}

export class Dialog {
  private input: SpeechInput;
  private audio = new DialogAudio();
  private active = false;
  private turn: DialogTurn | null = null;
  private toolAbort = new AbortController();
  private canceledTools = new Set<string>();
  private toolCalls = 0;
  private responding = false;

  constructor(api: string, getToken: () => string, private callbacks: DialogCallbacks, history: History) {
    this.input = new SpeechInput(api, getToken, {
      onTranscript: () => {},
      onStatus: status => { if (this.active) callbacks.onStatus(status.replace('Gemini is listening', 'Dialog is listening')); },
    }, {
      onReady: resumed => {
        if (!resumed && history.length) this.input.sendMessage({ clientContent: {
          turns: history.slice(-24).map(m => ({ role: m.role === 'assistant' ? 'model' : 'user', parts: [{ text: m.content.slice(0, 12000) }] })),
          turnComplete: false,
        } });
      },
      onMessage: message => this.receive(message),
      onError: error => this.fail(error),
    });
  }

  async start(): Promise<void> {
    this.active = true;
    try {
      await this.audio.unlock();
      if (!this.active) { this.audio.dispose(); return; }
      await this.input.start();
    } catch (error) { if (this.active) this.fail(error instanceof Error ? error : new Error('Dialog could not start.')); }
  }

  stop(): void {
    this.active = false;
    this.toolAbort.abort();
    this.input.stop();
    this.audio.dispose();
    this.finish('interrupted');
  }

  private fail(error: Error): void {
    if (!this.active) return;
    this.finish('error');
    this.stop();
    this.callbacks.onError(error);
  }

  private ensureTurn(): DialogTurn {
    return this.turn ||= { userId: crypto.randomUUID(), assistantId: crypto.randomUUID(), input: '', output: '', status: 'pending' };
  }

  private finish(status: DialogTurn['status']): void {
    if (this.turn) {
      this.turn.status = status;
      this.callbacks.onTurn({ ...this.turn });
      this.turn = null;
    }
    this.toolCalls = 0;
    this.responding = false;
  }

  private receive(message: Record<string, any>): void {
    if (!this.active) return;
    for (const id of message.toolCallCancellation?.ids || []) this.canceledTools.add(id);
    const calls = message.toolCall?.functionCalls;
    if (Array.isArray(calls)) {
      if ((this.toolCalls += calls.length) > 4) throw new Error('Dialog requested too many UI actions in one turn.');
      for (const call of calls) void this.invoke(call);
    }
    const content = message.serverContent;
    if (!content) return;
    if (content.interrupted) {
      this.audio.stop();
      if (this.responding) this.finish('interrupted');
      this.callbacks.onStatus('Dialog is listening');
    }
    const input = content.inputTranscription?.text;
    if (typeof input === 'string' && input) {
      if (this.responding) { this.audio.stop(); this.finish('interrupted'); }
      this.ensureTurn().input = (this.ensureTurn().input + input).slice(0, 12000);
    }
    const output = content.outputTranscription?.text;
    if (typeof output === 'string' && output) {
      this.responding = true;
      this.ensureTurn().output = (this.ensureTurn().output + output).slice(0, 12000);
    }
    for (const part of content.modelTurn?.parts || []) {
      if (part.inlineData?.data) {
        this.responding = true;
        this.ensureTurn();
        this.audio.append(part.inlineData.data, part.inlineData.mimeType || 'audio/pcm;rate=24000');
        this.callbacks.onStatus('Dialog is speaking');
      }
    }
    if (this.turn) this.callbacks.onTurn({ ...this.turn });
    if (content.turnComplete && !content.interrupted) {
      this.finish('complete');
      this.callbacks.onStatus('Dialog is listening');
    }
  }

  private async invoke(call: { id?: unknown; name?: unknown; args?: unknown }): Promise<void> {
    if (typeof call.id !== 'string' || typeof call.name !== 'string') return;
    try {
      // Yield once so cancellations in the same event are observed first.
      await Promise.resolve();
      if (!this.active || this.canceledTools.has(call.id)) return;
      const result = await this.callbacks.invokeTool(call.name, call.args || {}, this.toolAbort.signal);
      if (this.active && !this.canceledTools.has(call.id)) this.input.sendMessage({ toolResponse: {
        functionResponses: [{ id: call.id, name: call.name, response: result }],
      } });
    } catch (error) { if (this.active) this.fail(error instanceof Error ? error : new Error('Dialog UI action failed.')); }
  }
}
