export const PREFERRED_VOICE = 'en-US-BrianMultilingualNeural';
const MAX_SEGMENT_LENGTH = 420;

export type VoiceEntry = { name: string; friendlyName: string; locale: string };
export type SpeechPhase = 'idle' | 'warming' | 'loading' | 'speaking-edge' | 'speaking-browser' | 'paused' | 'ended' | 'error';
export type SpeechSnapshot = { messageId: string | null; phase: SpeechPhase; service: 'idle' | 'connecting' | 'ready' | 'unavailable'; detail: string };

export function preferredVoice(voices: VoiceEntry[]): VoiceEntry | undefined {
  return voices.find(voice => voice.name === PREFERRED_VOICE && voice.locale === 'en-US');
}

export function speechText(markdown: string): string {
  return markdown
    .replace(/```[^\n]*\n?([\s\S]*?)```/g, '$1')
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/<[^>]*>/g, ' ')
    .replace(/^\s{0,3}#{1,6}\s+/gm, '')
    .replace(/^\s*[-*+]\s+/gm, '')
    .replace(/^\s*\d+[.)]\s+/gm, '')
    .replace(/^\s*>\s?/gm, '')
    .replace(/[*_~`]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

export function speechSegments(text: string, limit = MAX_SEGMENT_LENGTH): string[] {
  const remaining = text.trim();
  if (!remaining) return [];
  const segments: string[] = [];
  let rest = remaining;
  while (rest.length > limit) {
    const window = rest.slice(0, limit + 1);
    const sentence = [...window.matchAll(/[.!?](?:["'”’)]*)\s/g)].pop();
    let end = sentence && sentence.index! > limit * .55 ? sentence.index! + sentence[0].length : window.lastIndexOf(' ');
    if (end < 1) end = limit;
    segments.push(rest.slice(0, end).trim());
    rest = rest.slice(end).trimStart();
  }
  if (rest) segments.push(rest);
  return segments;
}

type RequestResult = { blob?: Blob; error?: unknown };
type Dependencies = {
  fetcher?: typeof fetch;
  synth?: SpeechSynthesis | null;
  makeUtterance?: (text: string) => SpeechSynthesisUtterance;
  makeAudio?: () => HTMLAudioElement;
  createObjectURL?: (blob: Blob) => string;
  revokeObjectURL?: (url: string) => void;
};

export class SpeechOutput {
  private fetcher: typeof fetch;
  private synth: SpeechSynthesis | null;
  private makeUtterance: (text: string) => SpeechSynthesisUtterance;
  private makeAudio: () => HTMLAudioElement;
  private createObjectURL: (blob: Blob) => string;
  private revokeObjectURL: (url: string) => void;
  private state: SpeechSnapshot = { messageId: null, phase: 'idle', service: 'idle', detail: '' };
  private generation = 0;
  private textParts: string[] = [];
  private part = 0;
  private paused = false;
  private edgeFailed = false;
  private voiceReady = false;
  private voiceStatusPromise: Promise<void> | null = null;
  private controllers = new Set<AbortController>();
  private voiceControllers = new Set<AbortController>();
  private disposed = false;
  private audio: HTMLAudioElement | null = null;
  private edgeAudioReady = false;
  private utterance: SpeechSynthesisUtterance | null = null;
  private objectUrl: string | null = null;
  private prepared: { index: number; result: Promise<RequestResult> } | null = null;
  private engine: 'edge' | 'browser' | null = null;

  constructor(
    private api: string,
    private getToken: () => string,
    private onChange: (state: SpeechSnapshot) => void,
    dependencies: Dependencies = {},
  ) {
    this.fetcher = dependencies.fetcher || fetch;
    this.synth = dependencies.synth === undefined ? window.speechSynthesis || null : dependencies.synth;
    this.makeUtterance = dependencies.makeUtterance || (text => new SpeechSynthesisUtterance(text));
    this.makeAudio = dependencies.makeAudio || (() => new Audio());
    this.createObjectURL = dependencies.createObjectURL || (blob => URL.createObjectURL(blob));
    this.revokeObjectURL = dependencies.revokeObjectURL || (url => URL.revokeObjectURL(url));
  }

  snapshot(): SpeechSnapshot { return this.state; }

  private update(update: Partial<SpeechSnapshot>) {
    this.state = { ...this.state, ...update };
    this.onChange(this.state);
  }

  warmup() {
    if (this.disposed || this.voiceStatusPromise || this.voiceReady || !this.getToken()) return this.voiceStatusPromise;
    this.update({ service: 'connecting', detail: 'Waking the speech service. Browser speech is available while it starts.' });
    this.voiceStatusPromise = this.loadVoices().finally(() => { this.voiceStatusPromise = null; });
    return this.voiceStatusPromise;
  }

  async reconnect() {
    if (this.disposed || !this.getToken()) return;
    if (this.voiceStatusPromise) await this.voiceStatusPromise;
    this.voiceReady = false;
    this.edgeFailed = false;
    this.voiceStatusPromise = null;
    this.update({ service: 'connecting', detail: 'Checking Brian voice and audio generation. Browser speech remains available.' });
    await this.warmup();
    if (!this.voiceReady || this.disposed) return;
    const result = await this.requestAudio('This is a speech service connection test.');
    if (result.error || !result.blob) {
      this.voiceReady = false;
      this.update({ service: 'unavailable', detail: `Brian voice was found, but audio generation failed${result.error instanceof Error ? ` (${result.error.message})` : ''}. Browser speech remains available; press Reconnect to retry.` });
      return;
    }
    this.update({ service: 'ready', detail: 'Brian voice and audio generation are ready.' });
  }

  private async loadVoices() {
    for (let attempt = 0; attempt < 6 && !this.disposed; attempt++) {
      const controller = new AbortController();
      this.voiceControllers.add(controller);
      const timeout = window.setTimeout(() => controller.abort(), 12_000);
      try {
        const response = await this.fetcher(this.api + '/api/voices', {
          headers: { Authorization: 'Bearer ' + this.getToken() }, signal: controller.signal,
        });
        if (response.ok) {
          const result = await response.json() as { voices?: VoiceEntry[] };
          if (Array.isArray(result.voices) && preferredVoice(result.voices)) {
            this.voiceReady = true;
            this.update({ service: 'ready', detail: 'Brian voice is ready.' });
            return;
          }
          this.update({ service: 'unavailable', detail: 'Brian is not available from the speech service. Browser speech remains available.' });
          return;
        }
        if ([400, 401, 403, 404].includes(response.status)) {
          this.update({ service: 'unavailable', detail: 'Speech service connection failed. Browser speech remains available.' });
          return;
        }
      } catch { /* bounded retry while the hosted backend wakes */ }
      finally {
        window.clearTimeout(timeout);
        this.voiceControllers.delete(controller);
      }
      if (attempt < 5 && !this.disposed) await new Promise(resolve => window.setTimeout(resolve, 3000));
    }
    if (!this.disposed) this.update({ service: 'unavailable', detail: 'Speech service did not wake in time. Browser speech remains available; press Reconnect to retry.' });
  }

  unlock() {
    if (this.audio) return;
    const audio = this.makeAudio();
    this.audio = audio;
    audio.src = 'data:audio/wav;base64,UklGRiUAAABXQVZFZm10IBAAAAABAAEARKwAAESsAAABAAgAZGF0YQEAAACA';
    void audio.play().then(() => {
      if (audio.src.startsWith('data:')) {
        audio.pause();
        audio.removeAttribute('src');
        audio.load();
      }
    }).catch(() => {});
  }

  play(messageId: string, markdown: string) {
    this.stop(false);
    const visibleText = speechText(markdown);
    this.textParts = speechSegments(visibleText);
    if (!this.textParts.length) return;
    this.generation++;
    this.part = 0;
    this.paused = false;
    this.edgeFailed = false;
    this.prepared = null;
    this.update({ messageId, phase: 'loading', detail: 'Preparing speech…' });
    this.unlock();
    if (!this.voiceReady) void this.warmup();
    void this.playPart(this.generation);
  }

  toggle(messageId: string, markdown: string) {
    if (this.state.messageId !== messageId || this.state.phase === 'idle' || this.state.phase === 'ended' || this.state.phase === 'error') {
      this.play(messageId, markdown);
    } else if (this.state.phase === 'paused') {
      this.resume();
    } else {
      this.pause();
    }
  }

  private async playPart(generation: number) {
    if (generation !== this.generation || this.paused) return;
    if (this.part >= this.textParts.length) {
      this.update({ phase: 'ended', detail: 'Finished.' });
      this.engine = null;
      return;
    }
    if (this.voiceReady && !this.edgeFailed) {
      this.engine = 'edge';
      this.update({ phase: 'loading', detail: 'Preparing Brian audio…' });
      const result = this.prepared?.index === this.part ? await this.prepared.result : await this.requestAudio(this.textParts[this.part]);
      this.prepared = null;
      if (generation !== this.generation || this.paused) return;
      if (result.error || !result.blob) {
        this.edgeFailed = true;
        this.clearAudioSource();
        this.voiceReady = false;
        this.update({ service: 'unavailable', phase: 'speaking-browser', detail: `Brian audio failed${result.error instanceof Error ? ` (${result.error.message})` : ''}. Continuing with the available browser voice.` });
        this.playBrowserPart(generation);
        return;
      }
      this.playEdgeBlob(result.blob, generation);
      return;
    }
    this.playBrowserPart(generation);
  }

  private playEdgeBlob(blob: Blob, generation: number) {
    if (!this.audio) this.audio = this.makeAudio();
    if (this.objectUrl) this.revokeObjectURL(this.objectUrl);
    this.objectUrl = this.createObjectURL(blob);
    const audio = this.audio;
    this.edgeAudioReady = true;
    audio.onended = () => {
      if (generation !== this.generation) return;
      this.edgeAudioReady = false;
      this.part++;
      void this.playPart(generation);
    };
    audio.onerror = () => {
      if (generation !== this.generation) return;
      this.edgeFailed = true;
      this.clearAudioSource();
      this.update({ service: 'unavailable', phase: 'speaking-browser', detail: 'Brian audio could not play. Continuing with the available browser voice.' });
      this.playBrowserPart(generation);
    };
    audio.src = this.objectUrl;
    this.update({ phase: 'speaking-edge', detail: 'Speaking with Brian.' });
    void audio.play().catch(() => {
      if (generation !== this.generation) return;
      this.edgeFailed = true;
      this.clearAudioSource();
      this.update({ service: 'unavailable', phase: 'speaking-browser', detail: 'Audio could not start. Continuing with the available browser voice.' });
      this.playBrowserPart(generation);
    });
    if (this.part + 1 < this.textParts.length && !this.prepared) {
      const nextPart = this.part + 1;
      this.prepared = { index: nextPart, result: this.requestAudio(this.textParts[nextPart]) };
    }
  }

  private playBrowserPart(generation: number) {
    if (generation !== this.generation || this.paused) return;
    if (!this.synth) {
      this.update({ phase: 'error', detail: 'Speech is unavailable in this browser. Connect again later.' });
      return;
    }
    const utterance = this.makeUtterance(this.textParts[this.part]);
    const voices = this.synth.getVoices();
    const daniel = voices.find(voice => /daniel/i.test(voice.name) && /^en[-_]GB$/i.test(voice.lang)) || voices.find(voice => /daniel/i.test(voice.name));
    if (daniel) utterance.voice = daniel;
    utterance.lang = daniel?.lang || 'en-GB';
    utterance.onend = () => {
      if (generation !== this.generation) return;
      this.part++;
      void this.playPart(generation);
    };
    utterance.onerror = event => {
      if (generation !== this.generation) return;
      this.update({ phase: 'error', detail: `Browser speech failed (${event.error || 'unknown error'}). Press Play to retry.` });
    };
    this.utterance = utterance;
    this.edgeAudioReady = false;
    this.engine = 'browser';
    const browserName = daniel?.name || 'browser default (Daniel unavailable)';
    const extra = this.voiceReady ? 'Brian will take over at the next sentence.' : 'Brian is waking; this sentence will use browser speech.';
    const failure = this.state.service === 'unavailable' ? `${this.state.detail} ` : '';
    this.update({ phase: 'speaking-browser', detail: `${failure}Using ${browserName}. ${extra}` });
    this.synth.speak(utterance);
  }

  private async requestAudio(text: string): Promise<RequestResult> {
    for (let attempt = 0; attempt < 2; attempt++) {
      const controller = new AbortController();
      this.controllers.add(controller);
      const timeout = window.setTimeout(() => controller.abort(), 30_000);
      try {
        const response = await this.fetcher(this.api + '/api/speech', {
          method: 'POST', signal: controller.signal,
          headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + this.getToken() },
          body: JSON.stringify({ text, voice: PREFERRED_VOICE, rate: 1 }),
        });
        if (response.status === 502 && attempt === 0) continue;
        if (!response.ok) {
          let reason = '';
          try {
            const body = await response.json() as { error?: unknown };
            if (typeof body.error === 'string') reason = `: ${body.error.slice(0, 180)}`;
          } catch { /* the response may be plain text or empty */ }
          return { error: new Error(`HTTP ${response.status}${reason}`) };
        }
        return { blob: await response.blob() };
      } catch (error) {
        if (controller.signal.aborted && this.state.phase === 'paused') return { error };
        if (attempt === 1) return { error };
      } finally {
        window.clearTimeout(timeout);
        this.controllers.delete(controller);
      }
    }
    return { error: new Error('Speech service did not respond.') };
  }

  private clearAudioSource() {
    this.controllers.forEach(controller => controller.abort());
    this.controllers.clear();
    this.prepared = null;
    if (this.audio) {
      this.audio.onended = this.audio.onerror = null;
      this.audio.pause();
      this.audio.removeAttribute('src');
      this.audio.load();
    }
    this.edgeAudioReady = false;
    if (this.objectUrl) this.revokeObjectURL(this.objectUrl);
    this.objectUrl = null;
  }

  pause() {
    if (!this.state.messageId || ['idle', 'ended', 'error', 'paused'].includes(this.state.phase)) return;
    this.paused = true;
    if (this.engine === 'edge') this.audio?.pause();
    if (this.engine === 'browser') this.synth?.pause();
    if (this.state.phase === 'loading') {
      this.controllers.forEach(controller => controller.abort());
      this.prepared = null;
      this.engine = null;
    }
    this.update({ phase: 'paused', detail: 'Paused.' });
  }

  resume() {
    if (!this.paused) return;
    this.paused = false;
    if (this.engine === 'edge' && this.edgeAudioReady && this.audio?.src) {
      void this.audio.play().then(() => this.update({ phase: 'speaking-edge', detail: 'Speaking with Brian.' })).catch(() => {
        this.engine = null;
        void this.playPart(this.generation);
      });
      return;
    }
    if (this.engine === 'browser' && this.utterance) {
      this.synth?.resume();
      this.update({ phase: 'speaking-browser', detail: 'Resumed browser speech.' });
      return;
    }
    void this.playPart(this.generation);
  }

  stop(publish = true) {
    this.generation++;
    this.paused = false;
    this.controllers.forEach(controller => controller.abort());
    this.controllers.clear();
    this.prepared = null;
    this.synth?.cancel();
    this.synth?.resume();
    this.clearAudioSource();
    this.utterance = null;
    this.engine = null;
    if (publish) this.update({ messageId: null, phase: 'idle', detail: '' });
  }

  dispose() {
    this.disposed = true;
    this.stop(false);
    this.voiceControllers.forEach(controller => controller.abort());
    this.voiceControllers.clear();
  }
}
