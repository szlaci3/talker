export type TranscriptUpdate = { committed: string; interim: string; corrected: string };
export type SpeechInputCallbacks = {
  onTranscript: (update: TranscriptUpdate) => void;
  onStatus: (status: string) => void;
};

type SpeechRecognitionResult = { isFinal: boolean; 0: { transcript: string } };
type SpeechRecognitionEventLike = { resultIndex: number; results: ArrayLike<SpeechRecognitionResult> };
type SpeechRecognitionLike = {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  onresult: ((event: SpeechRecognitionEventLike) => void) | null;
  onerror: ((event: { error?: string }) => void) | null;
  onend: (() => void) | null;
  start: () => void;
  stop: () => void;
};
type SpeechRecognitionWindow = Window & { SpeechRecognition?: new () => SpeechRecognitionLike; webkitSpeechRecognition?: new () => SpeechRecognitionLike };

const LIVE_MODEL = 'models/gemini-3.5-transcribe-live';
const LIVE_SOCKET = 'wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContentConstrained';
const TARGET_RATE = 16000;

function base64Pcm(bytes: Uint8Array): string {
  let binary = '';
  const stride = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += stride) {
    binary += String.fromCharCode(...bytes.subarray(offset, Math.min(offset + stride, bytes.length)));
  }
  return btoa(binary);
}

export class SpeechInput {
  private active = false;
  private generation = 0;
  private socket: WebSocket | null = null;
  private stream: MediaStream | null = null;
  private context: AudioContext | null = null;
  private processor: ScriptProcessorNode | null = null;
  private source: MediaStreamAudioSourceNode | null = null;
  private silent: GainNode | null = null;
  private recognition: SpeechRecognitionLike | null = null;
  private committed = '';
  private interim = '';
  private resumeHandle = '';
  private queuedAudio: string[] = [];
  private reconnects = 0;
  private liveReady = false;

  constructor(private api: string, private getToken: () => string, private callbacks: SpeechInputCallbacks) {}

  async start(): Promise<void> {
    if (this.active) return;
    this.active = true;
    const current = ++this.generation;
    this.committed = '';
    this.interim = '';
    this.resumeHandle = '';
    this.reconnects = 0;
    this.liveReady = false;
    this.callbacks.onStatus('Connecting to Gemini Live…');
    try {
      if (!navigator.mediaDevices?.getUserMedia || typeof WebSocket === 'undefined') throw new Error('Live audio is unavailable in this browser.');
      this.stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
      if (!this.isCurrent(current)) return;
      const AudioContextClass = window.AudioContext;
      this.context = new AudioContextClass();
      await this.context.resume();
      this.source = this.context.createMediaStreamSource(this.stream);
      this.processor = this.context.createScriptProcessor(2048, 1, 1);
      this.silent = this.context.createGain();
      this.silent.gain.value = 0;
      this.processor.onaudioprocess = event => this.capture(event.inputBuffer.getChannelData(0), this.context?.sampleRate || 48000);
      this.source.connect(this.processor);
      this.processor.connect(this.silent);
      this.silent.connect(this.context.destination);
      await this.connect(current);
    } catch (error) {
      this.fallback(error, current);
    }
  }

  stop(): void {
    this.active = false;
    this.generation++;
    this.socket?.close(1000, 'Dictation ended');
    this.socket = null;
    this.liveReady = false;
    this.recognition?.stop();
    this.recognition = null;
    this.processor?.disconnect();
    this.source?.disconnect();
    this.silent?.disconnect();
    this.processor = null;
    this.source = null;
    this.silent = null;
    this.stream?.getTracks().forEach(track => track.stop());
    this.stream = null;
    void this.context?.close();
    this.context = null;
    this.queuedAudio = [];
  }

  private isCurrent(id: number): boolean { return this.active && id === this.generation; }

  private async connect(id: number): Promise<void> {
    const response = await fetch(this.api + '/api/live-token', {
      method: 'POST', headers: { Authorization: 'Bearer ' + this.getToken() },
    });
    if (!response.ok) {
      const failure = await response.json().catch(() => ({})) as { error?: unknown };
      throw new Error(typeof failure.error === 'string' ? failure.error : 'Could not obtain a secure Live session.');
    }
    const { token } = await response.json() as { token?: string };
    if (!token || !this.isCurrent(id)) throw new Error('Live session token was unavailable.');
    await new Promise<void>((resolve, reject) => {
      const socket = new WebSocket(`${LIVE_SOCKET}?access_token=${encodeURIComponent(token)}`);
      // Gemini can send JSON in binary frames. Decode synchronously to preserve order.
      socket.binaryType = 'arraybuffer';
      this.socket = socket;
      let ready = false;
      let failed = false;
      const isCurrentSocket = () => this.isCurrent(id) && this.socket === socket && !failed;
      const fail = (error: Error) => {
        if (!isCurrentSocket()) return;
        failed = true;
        clearTimeout(setupTimer);
        if (ready) this.fallback(error, id);
        else reject(error);
      };
      const setupTimer = window.setTimeout(() => {
        if (!ready) fail(new Error('Gemini Live setup timed out.'));
      }, 12000);
      socket.onopen = () => { if (isCurrentSocket()) socket.send(JSON.stringify({ setup: {
        model: LIVE_MODEL,
        generationConfig: { responseModalities: ['TEXT'] },
        inputAudioTranscription: { languageCodes: [] },
        sessionResumption: this.resumeHandle ? { handle: this.resumeHandle } : {},
      } })); };
      socket.onmessage = event => {
        if (!isCurrentSocket()) return;
        let message: Record<string, any>;
        try {
          const text = event.data instanceof ArrayBuffer ? new TextDecoder().decode(event.data) : event.data;
          message = JSON.parse(text);
          if (!message || typeof message !== 'object' || Array.isArray(message)) throw new Error();
        } catch {
          fail(new Error('Gemini Live returned an unreadable message.'));
          return;
        }
        if (message.error) {
          fail(new Error(message.error.message || 'Gemini Live rejected the session.'));
          return;
        }
        if (message.setupComplete && !ready) {
          ready = true;
          this.liveReady = true;
          clearTimeout(setupTimer);
          this.reconnects = 0;
          for (const audio of this.queuedAudio.splice(0)) socket.send(audio);
          this.callbacks.onStatus('Listening');
          resolve();
        }
        const resume = message.sessionResumptionUpdate;
        if (resume?.newHandle) this.resumeHandle = resume.newHandle;
        const content = message.serverContent;
        if (!content) return;
        const partial = content.interimInputTranscription?.text;
        const final = content.inputTranscription?.text;
        if (typeof partial === 'string') {
          const previous = this.interim;
          this.interim = partial;
          this.publish(previous && partial !== previous ? partial : '');
        }
        if (typeof final === 'string' && final) {
          const correction = this.interim && this.interim.trim() !== final.trim() ? final : '';
          this.committed = [this.committed, final].filter(Boolean).join(' ');
          this.interim = '';
          this.publish(correction);
        }
      };
      socket.onerror = () => fail(new Error('Gemini Live connection failed.'));
      socket.onclose = () => {
        clearTimeout(setupTimer);
        if (!isCurrentSocket()) return;
        if (!ready) {
          this.socket = null;
          reject(new Error('Gemini Live closed before session setup completed.'));
          return;
        }
        this.socket = null;
        this.liveReady = false;
        if (this.resumeHandle && this.reconnects < 2) {
          this.reconnects++;
          window.setTimeout(() => { if (this.isCurrent(id)) void this.connect(id).catch(error => this.fallback(error, id)); }, 350);
        } else this.fallback(new Error('Gemini Live session ended.'), id);
      };
    });
  }

  private capture(input: Float32Array, sourceRate: number): void {
    if (!this.active) return;
    const ratio = sourceRate / TARGET_RATE;
    const length = Math.floor(input.length / ratio);
    if (!length) return;
    const pcm = new Int16Array(length);
    for (let i = 0; i < length; i++) {
      const start = Math.floor(i * ratio);
      const end = Math.min(input.length, Math.floor((i + 1) * ratio));
      let total = 0;
      for (let j = start; j < end; j++) total += input[j];
      const sample = total / Math.max(1, end - start);
      pcm[i] = Math.max(-1, Math.min(1, sample)) * (sample < 0 ? 32768 : 32767);
    }
    const encoded = JSON.stringify({ realtimeInput: { audio: { mimeType: 'audio/pcm;rate=16000', data: base64Pcm(new Uint8Array(pcm.buffer)) } } });
    if (this.liveReady && this.socket?.readyState === WebSocket.OPEN) this.socket.send(encoded);
    else {
      this.queuedAudio.push(encoded);
      if (this.queuedAudio.length > 500) this.fallback(new Error('Live session setup took too long.'), this.generation);
    }
  }

  private publish(corrected: string): void {
    this.callbacks.onTranscript({ committed: this.committed, interim: this.interim, corrected });
  }

  private fallback(error: unknown, id: number): void {
    if (!this.isCurrent(id)) return;
    const socket = this.socket;
    this.socket = null;
    socket?.close();
    this.liveReady = false;
    this.queuedAudio = [];
    this.processor?.disconnect();
    this.source?.disconnect();
    this.silent?.disconnect();
    this.stream?.getTracks().forEach(track => track.stop());
    this.processor = null;
    this.source = null;
    this.silent = null;
    this.stream = null;
    void this.context?.close();
    this.context = null;
    this.callbacks.onStatus(`Gemini Live stopped (${(error as Error).message}). Continuing in English.`);
    this.startBrowserFallback(id);
  }

  private startBrowserFallback(id: number): void {
    const BrowserRecognition = (window as SpeechRecognitionWindow).SpeechRecognition || (window as SpeechRecognitionWindow).webkitSpeechRecognition;
    if (!BrowserRecognition) {
      this.callbacks.onStatus('Gemini Live is unavailable, and this browser does not support English speech recognition. You can keep typing.');
      return;
    }
    try {
      const recognition = new BrowserRecognition();
      this.recognition = recognition;
      recognition.continuous = true;
      recognition.interimResults = true;
      recognition.lang = 'en-US';
      recognition.onresult = event => {
        if (!this.isCurrent(id)) return;
        let finals = '';
        let interim = '';
        for (let i = event.resultIndex; i < event.results.length; i++) {
          const text = event.results[i][0].transcript;
          if (event.results[i].isFinal) finals += text;
          else interim += text;
        }
        if (finals) this.committed = [this.committed, finals.trim()].filter(Boolean).join(' ');
        this.interim = interim;
        this.publish('');
      };
      recognition.onerror = event => {
        this.callbacks.onStatus(`English browser recognition error${event.error ? `: ${event.error}` : ''}.`);
        if (['not-allowed', 'service-not-allowed', 'audio-capture'].includes(event.error || '')) {
          this.recognition = null;
          recognition.stop();
        }
      };
      recognition.onend = () => { if (this.isCurrent(id) && this.recognition === recognition) { try { recognition.start(); } catch { /* Browser may already be restarting. */ } } };
      recognition.start();
    } catch {
      this.callbacks.onStatus('English browser recognition could not start. You can keep typing.');
    }
  }
}
