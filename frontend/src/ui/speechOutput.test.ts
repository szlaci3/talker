import { waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { preferredVoice, PREFERRED_VOICE, SpeechOutput, speechSegments, speechText } from './speechOutput';

const brian = { name: PREFERRED_VOICE, locale: 'en-US', friendlyName: 'Microsoft BrianMultilingual Online (Natural) - English (United States)' };

describe('speech output', () => {
  it('keeps the browser fetch receiver for catalogue and synthesis requests', async () => {
    const receivers: unknown[] = [];
    const urls: string[] = [];
    vi.stubGlobal('fetch', async function (this: unknown, input: RequestInfo | URL) {
      receivers.push(this);
      urls.push(String(input));
      return String(input).endsWith('/api/voices')
        ? new Response(JSON.stringify({ voices: [brian] }), { status: 200 })
        : new Response(new Blob(['mp3']), { status: 200 });
    });
    const audio = { src: '', play: vi.fn(async () => {}), pause: vi.fn(), removeAttribute: vi.fn(), load: vi.fn() } as unknown as HTMLAudioElement;
    const output = new SpeechOutput('https://api.test', () => 'session-token', vi.fn(), { synth: null, makeAudio: () => audio });
    try {
      await output.reconnect();
      expect(urls).toEqual(['https://api.test/api/voices', 'https://api.test/api/speech']);
      expect(receivers).toHaveLength(2);
      for (const receiver of receivers) expect(receiver).toBe(globalThis);
      expect(output.snapshot().service).toBe('ready');
    } finally {
      output.dispose();
      vi.unstubAllGlobals();
    }
  });

  it('speaks readable Markdown text and preserves every segment boundary', () => {
    const source = '# History\n\nThe **war** began.\n\n- First consequence\n- [More details](https://example.test)';
    expect(speechText(source)).toBe('History The war began. First consequence More details');

    const text = 'The first sentence. ' + 'word '.repeat(115) + 'The last sentence.';
    const segments = speechSegments(text);
    expect(segments.length).toBeGreaterThan(1);
    expect(segments.join(' ')).toBe(text);
  });

  it('selects the exact Brian service voice and never substitutes another cloud voice', () => {
    expect(preferredVoice([{ ...brian, locale: 'en-GB' }])).toBeUndefined();
    expect(preferredVoice([{ ...brian, name: 'en-US-AndrewMultilingualNeural' }])).toBeUndefined();
    expect(preferredVoice([brian])).toEqual(brian);
  });

  it('reconnect checks both the catalogue and actual audio generation', async () => {
    const requests: Array<{ url: string; body?: string }> = [];
    const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      requests.push({ url, body: init?.body as string | undefined });
      if (url.endsWith('/api/voices')) return new Response(JSON.stringify({ voices: [brian] }), { status: 200 });
      return new Response(new Blob(['mp3']), { status: 200 });
    }) as typeof fetch;
    const audio = { src: '', play: vi.fn(async () => {}), pause: vi.fn(), removeAttribute: vi.fn(), load: vi.fn() } as unknown as HTMLAudioElement;
    const output = new SpeechOutput('/api', () => 'session-token', vi.fn(), { fetcher, synth: null, makeAudio: () => audio });

    await output.warmup();
    expect(output.snapshot().service).toBe('ready');
    await output.reconnect();

    expect(requests.filter(request => request.url.endsWith('/api/voices'))).toHaveLength(2);
    const probe = requests.find(request => request.url.endsWith('/api/speech'));
    expect(JSON.parse(probe?.body || '{}').text).toBe('This is a speech service connection test.');
    expect(output.snapshot().service).toBe('ready');
    output.dispose();
  });

  it('shows an HTTP synthesis failure and marks Brian unavailable', async () => {
    const fetcher = (async (input: RequestInfo | URL) => String(input).endsWith('/api/voices')
      ? new Response(JSON.stringify({ voices: [brian] }), { status: 200 })
      : new Response(JSON.stringify({ error: 'Speech synthesis failed.' }), { status: 502 })) as typeof fetch;
    const audio = { src: '', play: vi.fn(async () => {}), pause: vi.fn(), removeAttribute: vi.fn(), load: vi.fn() } as unknown as HTMLAudioElement;
    let activeUtterance: SpeechSynthesisUtterance | undefined;
    const speak = vi.fn((utterance: SpeechSynthesisUtterance) => { activeUtterance = utterance; });
    const synth = { getVoices: () => [], speak, pause: vi.fn(), resume: vi.fn(), cancel: vi.fn() } as unknown as SpeechSynthesis;
    const output = new SpeechOutput('/api', () => 'session-token', vi.fn(), {
      fetcher, synth, makeAudio: () => audio,
      makeUtterance: text => ({ text, onend: null, onerror: null } as unknown as SpeechSynthesisUtterance),
    });
    await output.warmup();
    output.play('answer-failed', 'word '.repeat(340));
    activeUtterance?.onend?.({} as SpeechSynthesisEvent);
    await waitFor(() => expect(speak).toHaveBeenCalledTimes(2));
    activeUtterance?.onend?.({} as SpeechSynthesisEvent);
    await waitFor(() => expect(speak).toHaveBeenCalledTimes(3));
    activeUtterance?.onend?.({} as SpeechSynthesisEvent);
    await waitFor(() => expect(output.snapshot().service).toBe('unavailable'));
    expect(output.snapshot().detail).toContain('HTTP 502: Speech synthesis failed.');
    output.dispose();
  });

  it('reports the HTTP error from the Brian catalogue endpoint', async () => {
    const fetcher = (async () => new Response(JSON.stringify({ error: 'Speech backend is unavailable.' }), { status: 404 })) as typeof fetch;
    const output = new SpeechOutput('/api', () => 'session-token', vi.fn(), { fetcher, synth: null });

    await output.warmup();

    expect(output.snapshot().service).toBe('unavailable');
    expect(output.snapshot().detail).toContain('HTTP 404: Speech backend is unavailable.');
    expect(output.snapshot().detail).toContain('Check the speech backend deployment and API URL.');
    output.dispose();
  });

  it('starts with Daniel during service warm-up, then switches at the exact unread segment', async () => {
    let finishCatalogue!: (response: Response) => void;
    let activeUtterance: SpeechSynthesisUtterance | undefined;
    const synth = {
      getVoices: () => [{ name: 'Microsoft Daniel Online', lang: 'en-GB' }],
      speak: vi.fn((utterance: SpeechSynthesisUtterance) => { activeUtterance = utterance; }),
      pause: vi.fn(), resume: vi.fn(), cancel: vi.fn(),
    } as unknown as SpeechSynthesis;
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    const fetcher = ((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      requests.push({ url, init });
      if (url.endsWith('/api/voices')) return new Promise<Response>(resolve => { finishCatalogue = resolve; });
      return Promise.resolve(new Response(new Blob(['mp3']), { status: 200 }));
    }) as typeof fetch;
    const audio = {
      src: '', onended: null, onerror: null,
      play: vi.fn(async () => {}), pause: vi.fn(), removeAttribute: vi.fn(), load: vi.fn(),
    } as unknown as HTMLAudioElement;
    const output = new SpeechOutput('https://api.test', () => 'session-token', vi.fn(), {
      fetcher, synth, makeAudio: () => audio,
      makeUtterance: text => ({ text, onend: null, onerror: null } as unknown as SpeechSynthesisUtterance),
      createObjectURL: () => 'blob:spoken', revokeObjectURL: vi.fn(),
    });
    const source = 'The opening sentence. ' + 'word '.repeat(340) + 'The final sentence.';
    const expectedText = speechText(source);
    output.play('answer-1', source);
    expect(activeUtterance?.text).toBe(speechSegments(expectedText)[0]);

    finishCatalogue(new Response(JSON.stringify({ voices: [brian] }), { status: 200 }));
    await waitFor(() => expect(output.snapshot().service).toBe('ready'));
    await waitFor(() => expect(requests.filter(request => request.url.endsWith('/api/speech'))).toHaveLength(1));
    const parts = speechSegments(expectedText);
    expect(parts.length).toBeGreaterThan(3);
    for (let index = 0; index < 3; index++) {
      activeUtterance?.onend?.({} as SpeechSynthesisEvent);
      if (index < 2) await waitFor(() => expect(activeUtterance?.text).toBe(parts[index + 1]));
    }
    await waitFor(() => expect(audio.play).toHaveBeenCalled());
    const request = requests.find(item => item.url.endsWith('/api/speech'));
    const sent = JSON.parse(request?.init?.body as string) as { text: string; voice: string };
    expect(sent.text).toBe(parts[3]);
    expect(sent.voice).toBe(PREFERRED_VOICE);
    output.stop();
  });

  it('waits silently at segment four when Brian audio is late instead of speaking it in the browser voice', async () => {
    let activeUtterance: SpeechSynthesisUtterance | undefined;
    let finishBrian!: (response: Response) => void;
    const synth = {
      getVoices: () => [{ name: 'Microsoft Daniel Online', lang: 'en-GB' }],
      speak: vi.fn((utterance: SpeechSynthesisUtterance) => { activeUtterance = utterance; }),
      pause: vi.fn(), resume: vi.fn(), cancel: vi.fn(),
    } as unknown as SpeechSynthesis;
    const audio = {
      src: '', onended: null, onerror: null,
      play: vi.fn(async () => {}), pause: vi.fn(), removeAttribute: vi.fn(), load: vi.fn(),
    } as unknown as HTMLAudioElement;
    const fetcher = ((input: RequestInfo | URL) => String(input).endsWith('/api/voices')
      ? Promise.resolve(new Response(JSON.stringify({ voices: [brian] }), { status: 200 }))
      : new Promise<Response>(resolve => { finishBrian = resolve; })) as typeof fetch;
    const output = new SpeechOutput('/api', () => 'session-token', vi.fn(), {
      fetcher, synth, makeAudio: () => audio,
      makeUtterance: text => ({ text, onend: null, onerror: null } as unknown as SpeechSynthesisUtterance),
      createObjectURL: () => 'blob:late-handoff', revokeObjectURL: vi.fn(),
    });
    const parts = speechSegments('word '.repeat(340).trim());
    output.play('late-handoff', parts.join(' '));
    await waitFor(() => expect(output.snapshot().service).toBe('ready'));
    await waitFor(() => expect(finishBrian).toBeTypeOf('function'));

    for (let index = 0; index < 3; index++) {
      activeUtterance?.onend?.({} as SpeechSynthesisEvent);
      if (index < 2) await waitFor(() => expect(activeUtterance?.text).toBe(parts[index + 1]));
    }
    await waitFor(() => expect(output.snapshot().phase).toBe('loading'));
    expect(synth.speak).toHaveBeenCalledTimes(3);
    expect(audio.play).toHaveBeenCalledTimes(1); // initial browser playback unlock only

    finishBrian(new Response(new Blob(['mp3']), { status: 200 }));
    await waitFor(() => expect(audio.play).toHaveBeenCalledTimes(1));
    expect(synth.speak).toHaveBeenCalledTimes(3);
    output.stop();
  });

  it('prefetches Brian segment four during browser speech', async () => {
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      requests.push({ url, init });
      if (url.endsWith('/api/voices')) return new Response(JSON.stringify({ voices: [brian] }), { status: 200 });
      return new Response(new Blob(['mp3']), { status: 200 });
    }) as typeof fetch;
    const audio = {
      src: '', onended: null, onerror: null,
      play: vi.fn(async () => {}), pause: vi.fn(), removeAttribute: vi.fn(), load: vi.fn(),
    } as unknown as HTMLAudioElement;
    const spokenUtterances: SpeechSynthesisUtterance[] = [];
    const synth = {
      getVoices: () => [], speak: vi.fn((utterance: SpeechSynthesisUtterance) => { spokenUtterances.push(utterance); }),
      pause: vi.fn(), resume: vi.fn(), cancel: vi.fn(),
    } as unknown as SpeechSynthesis;
    const output = new SpeechOutput('/api', () => 'session-token', vi.fn(), {
      fetcher, synth, makeAudio: () => audio,
      makeUtterance: text => ({ text, onend: null, onerror: null } as unknown as SpeechSynthesisUtterance),
      createObjectURL: (() => { let index = 0; return () => `blob:${++index}`; })(),
      revokeObjectURL: vi.fn(),
    });
    await output.warmup();
    const text = 'word '.repeat(340).trim();
    const expectedSegments = speechSegments(text);
    output.play('answer-3', text);

    for (let index = 0; index < 3; index++) {
      const utterance = spokenUtterances.at(-1);
      utterance?.onend?.({} as SpeechSynthesisEvent);
    }
    await waitFor(() => expect(audio.play).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(requests.filter(item => item.url.endsWith('/api/speech'))).toHaveLength(2));
    const spoken = requests.filter(item => item.url.endsWith('/api/speech')).map(item =>
      JSON.parse(item.init?.body as string).text as string);
    expect(spoken).toEqual(expectedSegments.slice(3, 5));
    expect(audio.play).toHaveBeenCalledTimes(2); // unlock plus segment four
    output.stop();
  });

  it('stopping invalidates late browser speech callbacks', () => {
    let activeUtterance: SpeechSynthesisUtterance | undefined;
    const synth = {
      getVoices: () => [], speak: vi.fn((utterance: SpeechSynthesisUtterance) => { activeUtterance = utterance; }),
      pause: vi.fn(), resume: vi.fn(), cancel: vi.fn(),
    } as unknown as SpeechSynthesis;
    const output = new SpeechOutput('/api', () => '', vi.fn(), {
      synth,
      makeAudio: () => ({ src: '', play: async () => {}, pause: vi.fn(), removeAttribute: vi.fn(), load: vi.fn() } as unknown as HTMLAudioElement),
      makeUtterance: text => ({ text, onend: null, onerror: null } as unknown as SpeechSynthesisUtterance),
    });
    output.play('answer-2', 'One sentence. Another sentence.');
    const staleCallback = activeUtterance?.onend;
    output.stop();
    if (activeUtterance && staleCallback) staleCallback.call(activeUtterance, {} as SpeechSynthesisEvent);
    expect(synth.speak).toHaveBeenCalledTimes(1);
    expect(output.snapshot().messageId).toBeNull();
  });
});
