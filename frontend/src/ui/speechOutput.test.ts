import { waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
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
    output.play('answer-failed', 'word '.repeat(340));
    await waitFor(() => expect(output.snapshot().service).toBe('ready'));
    for (let index = 0; index < 3; index++) {
      activeUtterance?.onend?.({} as SpeechSynthesisEvent);
      if (index < 2) await waitFor(() => expect(activeUtterance?.text).toBe(speechSegments('word '.repeat(340))[index + 1]));
    }
    await waitFor(() => expect(output.snapshot().service).toBe('unavailable'));
    expect(output.snapshot().detail).toContain('HTTP 502: Speech synthesis failed.');
    expect(speak).toHaveBeenCalledTimes(4);
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
    activeUtterance?.onend?.({} as SpeechSynthesisEvent);
    await waitFor(() => expect(output.snapshot().phase).toBe('speaking-edge'));
    const request = requests.find(item => item.url.endsWith('/api/speech'));
    const sent = JSON.parse(request?.init?.body as string) as { text: string; voice: string };
    expect(sent.text).toBe(parts[1]);
    expect(synth.speak).toHaveBeenCalledTimes(1);
    expect(sent.voice).toBe(PREFERRED_VOICE);
    output.stop();
  });

  it('starts with Brian on segment one when the service is ready before playback', async () => {
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      requests.push({ url, init });
      return url.endsWith('/api/voices')
        ? new Response(JSON.stringify({ voices: [brian] }), { status: 200 })
        : new Response(new Blob(['mp3']), { status: 200 });
    }) as typeof fetch;
    const audio = {
      src: '', onended: null, onerror: null,
      play: vi.fn(async () => {}), pause: vi.fn(), removeAttribute: vi.fn(), load: vi.fn(),
    } as unknown as HTMLAudioElement;
    const synth = { getVoices: () => [], speak: vi.fn(), pause: vi.fn(), resume: vi.fn(), cancel: vi.fn() } as unknown as SpeechSynthesis;
    const output = new SpeechOutput('/api', () => 'session-token', vi.fn(), {
      fetcher, synth, makeAudio: () => audio,
      createObjectURL: () => 'blob:first-segment', revokeObjectURL: vi.fn(),
    });
    await output.warmup();
    const parts = speechSegments('The answer starts here. ' + 'word '.repeat(340));

    output.play('ready-before-play', parts.join(' '));
    await waitFor(() => expect(audio.play).toHaveBeenCalledTimes(2));

    const speechRequests = requests.filter(request => request.url.endsWith('/api/speech'));
    expect(JSON.parse(speechRequests[0].init?.body as string).text).toBe(parts[0]);
    expect(synth.speak).not.toHaveBeenCalled();
    expect(output.snapshot().phase).toBe('speaking-edge');
    output.stop();
  });

  it('waits silently at segment two when Brian audio is late instead of speaking it in the browser voice', async () => {
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

    activeUtterance?.onend?.({} as SpeechSynthesisEvent);
    await waitFor(() => expect(output.snapshot().phase).toBe('loading'));
    expect(synth.speak).toHaveBeenCalledTimes(1);
    expect(audio.play).toHaveBeenCalledTimes(1); // initial browser playback unlock only

    finishBrian(new Response(new Blob(['mp3']), { status: 200 }));
    await waitFor(() => expect(audio.play).toHaveBeenCalledTimes(2));
    expect(synth.speak).toHaveBeenCalledTimes(1);
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

describe('one automatic reconnect per playback', () => {
  const outputs: SpeechOutput[] = [];
  const catalogue = () => new Response(JSON.stringify({ voices: [brian] }));
  const mp3 = () => new Response(new Blob(['mp3']));
  const failure = (status = 503) => new Response(JSON.stringify({ error: 'Speech unavailable.' }), { status });
  const text = Array.from({ length: 400 }, (_, index) => `word${index}`).join(' ');
  const parts = speechSegments(text);
  const probe = 'This is a speech service connection test.';

  function deferred<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>(done => { resolve = done; });
    return { promise, resolve };
  }

  function setup(fetcher: typeof fetch, blockAudio = false) {
    const spoken: SpeechSynthesisUtterance[] = [];
    const synth = {
      getVoices: () => [], speak: vi.fn((utterance: SpeechSynthesisUtterance) => spoken.push(utterance)),
      pause: vi.fn(), resume: vi.fn(), cancel: vi.fn(),
    } as unknown as SpeechSynthesis;
    const played: string[] = [];
    const audio = {
      src: '', onended: null, onerror: null,
      play: vi.fn(async () => {
        if (audio.src.startsWith('blob:')) {
          if (blockAudio) throw new DOMException('Playback blocked.', 'NotAllowedError');
          played.push(audio.src);
        }
      }),
      pause: vi.fn(), removeAttribute: vi.fn(), load: vi.fn(),
    } as unknown as HTMLAudioElement;
    const output = new SpeechOutput('https://api.test', () => 'test-session', vi.fn(), {
      fetcher, synth, makeAudio: () => audio,
      makeUtterance: text => ({ text, onend: null, onerror: null } as unknown as SpeechSynthesisUtterance),
      createObjectURL: () => 'blob:brian', revokeObjectURL: vi.fn(),
    });
    outputs.push(output);
    return { output, spoken, played, finishBrowser: () => spoken.at(-1)?.onend?.({} as SpeechSynthesisEvent) };
  }

  afterEach(() => {
    outputs.splice(0).forEach(output => output.dispose());
    vi.useRealTimers();
  });

  it('recovers stale Brian once, shares manual clicks, and hands off at the prepared unread segment', async () => {
    let catalogues = 0;
    let healthy = false;
    const recovery = deferred<Response>();
    const requested: string[] = [];
    const { output, spoken, played, finishBrowser } = setup(async (url, init) => {
      if (String(url).endsWith('/api/voices')) return ++catalogues === 1 ? catalogue() : recovery.promise;
      const requestedText = JSON.parse(init?.body as string).text;
      requested.push(requestedText);
      return healthy ? mp3() : failure(502);
    });
    await output.warmup();
    output.play('stale', text);
    await waitFor(() => expect(catalogues).toBe(2));
    expect(spoken.map(utterance => utterance.text)).toEqual([parts[0]]);
    expect(played).toEqual([]);
    const firstClick = output.reconnect();
    expect(output.reconnect()).toBe(firstClick);
    healthy = true;
    recovery.resolve(catalogue());
    await firstClick;
    expect(catalogues).toBe(2);
    expect(requested.filter(value => value === probe)).toHaveLength(1);
    expect(requested).toContain(parts[1]);
    expect(played).toEqual([]);
    finishBrowser();
    await waitFor(() => expect(played).toHaveLength(1));
    expect(spoken.map(utterance => utterance.text)).toEqual(parts.slice(0, 1));
    expect(output.snapshot().phase).toBe('speaking-edge');
  });

  it('stops automatic retries after failed recovery, allows manual retry, and resets on a new Play', async () => {
    let catalogues = 0;
    const { output, finishBrowser } = setup(async url => {
      if (String(url).endsWith('/api/voices')) { catalogues++; return catalogue(); }
      return failure();
    });
    await output.warmup();
    output.play('first', text);
    await waitFor(() => expect(output.snapshot().detail).toContain('audio generation failed'));
    expect(catalogues).toBe(2);
    output.pause();
    output.resume();
    finishBrowser();
    finishBrowser();
    expect(catalogues).toBe(2);
    await output.reconnect();
    expect(catalogues).toBe(3);
    finishBrowser();
    expect(catalogues).toBe(3);
    output.play('second', text);
    await waitFor(() => expect(output.snapshot().service).toBe('ready'));
    for (let index = 0; index < 3; index++) finishBrowser();
    await waitFor(() => expect(output.snapshot().detail).toContain('audio generation failed'));
    expect(catalogues).toBe(5); // a new regular connection, then one automatic Reconnect
  });

  it('defers recovery while paused and permits exactly two complete catalogue cycles', async () => {
    vi.useFakeTimers();
    let catalogues = 0;
    const { output } = setup(async () => { catalogues++; return failure(); });
    output.play('cold', text);
    output.pause();
    await vi.advanceTimersByTimeAsync(15_001);
    expect(catalogues).toBe(6);
    expect(output.snapshot().phase).toBe('paused');
    output.resume();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(catalogues).toBe(12);
    expect(output.snapshot().service).toBe('unavailable');
    output.pause();
    output.resume();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(catalogues).toBe(12);
  });

  it.each([401, 403, 404, 429])('does not automatically reconnect on HTTP %s', async status => {
    let catalogues = 0;
    const { output } = setup(async url => {
      if (String(url).endsWith('/api/voices')) { catalogues++; return catalogue(); }
      return failure(status);
    });
    await output.warmup();
    output.play('unauthorized', text);
    await waitFor(() => expect(output.snapshot().service).toBe('unavailable'));
    expect(output.snapshot().detail).toContain(`HTTP ${status}`);
    expect(catalogues).toBe(1);
  });

  it('does not reconnect when browser audio permission is blocked', async () => {
    let catalogues = 0;
    const { output } = setup(async url => {
      if (String(url).endsWith('/api/voices')) { catalogues++; return catalogue(); }
      return mp3();
    }, true);
    await output.warmup();
    output.play('blocked-audio', text);
    await waitFor(() => expect(output.snapshot().phase).toBe('speaking-browser'));
    expect(catalogues).toBe(1);
  });

  it('counts a manual Reconnect during warmup and does not automatically retry a later failure', async () => {
    const firstCatalogue = deferred<Response>();
    let catalogues = 0;
    const { output, finishBrowser } = setup(async (url, init) => {
      if (String(url).endsWith('/api/voices')) return ++catalogues === 1 ? firstCatalogue.promise : catalogue();
      return JSON.parse(init?.body as string).text === probe ? mp3() : failure();
    });
    output.play('manual-first', text);
    const manual = output.reconnect();
    firstCatalogue.resolve(catalogue());
    await manual;
    for (let index = 0; index < 3; index++) finishBrowser();
    await waitFor(() => expect(output.snapshot().service).toBe('unavailable'));
    output.pause();
    output.resume();
    finishBrowser();
    expect(catalogues).toBe(2);
  });

  it('does not retry a late probe response or change status after playback finishes', async () => {
    const pendingProbe = deferred<Response>();
    let probes = 0;
    const { output, finishBrowser, played } = setup(async (url, init) => {
      if (String(url).endsWith('/api/voices')) return catalogue();
      if (JSON.parse(init?.body as string).text === probe) { probes++; return pendingProbe.promise; }
      return failure();
    });
    await output.warmup();
    output.play('short-answer', 'A short answer.');
    await waitFor(() => expect(probes).toBe(1));
    const recovery = output.reconnect();
    finishBrowser();
    const before = output.snapshot();
    expect(before.phase).toBe('ended');
    pendingProbe.resolve(failure(502));
    await recovery;
    expect(probes).toBe(1);
    expect(output.snapshot()).toEqual(before);
    expect(played).toEqual([]);
  });

  it.each(['stop', 'finish', 'replace'])('ignores late recovery after %s', async action => {
    const recovery = deferred<Response>();
    let catalogues = 0;
    let probes = 0;
    const { output, played, finishBrowser } = setup(async (url, init) => {
      if (String(url).endsWith('/api/voices')) return ++catalogues === 2 ? recovery.promise : catalogue();
      if (JSON.parse(init?.body as string).text === probe) probes++;
      return failure();
    });
    await output.warmup();
    output.play('old', 'A short answer.');
    await waitFor(() => expect(catalogues).toBe(2));
    const oldRecovery = output.reconnect();
    if (action === 'stop') output.stop();
    if (action === 'finish') finishBrowser();
    if (action === 'replace') {
      output.play('new', 'A different answer.');
      await output.warmup();
    }
    const before = output.snapshot();
    recovery.resolve(catalogue());
    await oldRecovery;
    expect(output.snapshot()).toEqual(before);
    expect(played).toEqual([]);
    expect(probes).toBe(0);
  });
});
