import { waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { preferredVoice, PREFERRED_VOICE, SpeechOutput, speechSegments, speechText } from './speechOutput';

const brian = { name: PREFERRED_VOICE, locale: 'en-US', friendlyName: 'Microsoft BrianMultilingual Online (Natural) - English (United States)' };

describe('speech output', () => {
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
    const synth = { getVoices: () => [], speak: vi.fn(), pause: vi.fn(), resume: vi.fn(), cancel: vi.fn() } as unknown as SpeechSynthesis;
    const output = new SpeechOutput('/api', () => 'session-token', vi.fn(), {
      fetcher, synth, makeAudio: () => audio,
      makeUtterance: text => ({ text, onend: null, onerror: null } as unknown as SpeechSynthesisUtterance),
    });
    await output.warmup();
    output.play('answer-failed', 'A short answer.');
    await waitFor(() => expect(output.snapshot().service).toBe('unavailable'));
    expect(output.snapshot().detail).toContain('HTTP 502: Speech synthesis failed.');
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
    const source = 'The opening sentence. ' + 'word '.repeat(115) + 'The final sentence.';
    const expectedText = speechText(source);
    output.play('answer-1', source);
    expect(activeUtterance?.text).toBe(speechSegments(expectedText)[0]);

    finishCatalogue(new Response(JSON.stringify({ voices: [brian] }), { status: 200 }));
    await waitFor(() => expect(output.snapshot().service).toBe('ready'));
    activeUtterance?.onend?.({} as SpeechSynthesisEvent);
    await waitFor(() => expect(requests.some(request => request.url.endsWith('/api/speech'))).toBe(true));
    await waitFor(() => expect(audio.play).toHaveBeenCalled());
    const request = requests.find(item => item.url.endsWith('/api/speech'));
    const sent = JSON.parse(request?.init?.body as string) as { text: string; voice: string };
    expect(sent.text).toBe(speechSegments(expectedText)[1]);
    expect(sent.voice).toBe(PREFERRED_VOICE);
    output.stop();
  });

  it('prefetches one next segment and plays all remote segments once in order', async () => {
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
    const output = new SpeechOutput('/api', () => 'session-token', vi.fn(), {
      fetcher, synth: null, makeAudio: () => audio,
      createObjectURL: (() => { let index = 0; return () => `blob:${++index}`; })(),
      revokeObjectURL: vi.fn(),
    });
    await output.warmup();
    const text = 'word '.repeat(205).trim();
    const expectedSegments = speechSegments(text);
    output.play('answer-3', text);

    await waitFor(() => expect(requests.filter(item => item.url.endsWith('/api/speech'))).toHaveLength(2));
    for (let index = 0; index < expectedSegments.length; index++) {
      const onended = audio.onended as unknown as (() => void);
      onended();
      if (index < expectedSegments.length - 1) {
        await waitFor(() => expect(requests.filter(item => item.url.endsWith('/api/speech')))
          .toHaveLength(Math.min(expectedSegments.length, index + 3)));
      }
    }
    await waitFor(() => expect(output.snapshot().phase).toBe('ended'));

    const spoken = requests.filter(item => item.url.endsWith('/api/speech')).map(item =>
      JSON.parse(item.init?.body as string).text as string);
    expect(spoken).toEqual(expectedSegments);
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
