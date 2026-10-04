import { FormEvent, useCallback, useEffect, useRef, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { accessibleTextColor, COLOR_CSS_VARIABLES, COLOR_TARGETS, ColorPreferences, ColorTarget, contrastRatio, DEFAULT_COLORS, initialScale, initialTheme, parseColor, readSavedColors, Theme, UI_TOOL_DECLARATIONS, UiAction, validateUiAction } from './uiTools';
import { SpeechOutput, SpeechSnapshot } from './speechOutput';
import { SpeechInput, TranscriptCorrection } from './speechInput';
import { executeNativeUiTool, WebMCPContext, WebMCPTool } from './webmcp';

type Message = {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  status?: 'pending' | 'complete' | 'interrupted' | 'error';
};

const API = import.meta.env.VITE_API_URL || 'http://localhost:8080';
const suggestions = ['What can you help me with?', 'Explain a tricky idea simply', 'Help me plan a small project'];
const WEBMCP_FALLBACK = "WebMCP isn't available in this browser. Chat and conversational UI controls remain available.";

function preferences(theme: string, scale: number): { theme: string; fontScale: number; colors: ColorPreferences } {
  const root = document.documentElement;
  const colors = Object.fromEntries(Object.entries(COLOR_CSS_VARIABLES).map(([target, variable]) => {
    const computed = getComputedStyle(root).getPropertyValue(variable).trim();
    return [target, parseColor(computed) || DEFAULT_COLORS[target as ColorTarget]];
  })) as ColorPreferences;
  return { theme, fontScale: scale, colors };
}

function toolArguments(raw: unknown): unknown {
  if (typeof raw !== 'string') return raw;
  try { return JSON.parse(raw); } catch { return null; }
}

function completedTurns(items: Message[]): Message[] {
  const turns: Message[] = [];
  let pendingUser: Message | undefined;

  for (const message of items) {
    if (message.role === 'user') {
      // Include an interrupted user turn even when generation stopped before text arrived.
      if (pendingUser) {
        if (pendingUser.status === 'interrupted') {
          turns.push(pendingUser, { id: `${pendingUser.id}-cutoff`, role: 'assistant', content: '[Interrupted before any answer text was displayed.]' });
        } else if (!pendingUser.status) turns.push(pendingUser);
      }
      pendingUser = message;
    } else {
      if (pendingUser?.content.trim() && message.status === 'complete' && message.content.trim()) {
        turns.push(pendingUser, message);
      } else if (pendingUser?.content.trim() && message.status === 'interrupted') {
        const cutoff = message.content.trim()
          ? `[Interrupted. The answer ended at this exact visible cutoff; no later text was shown.]\n\n${message.content}`
          : '[Interrupted before any answer text was displayed.]';
        turns.push(pendingUser, { ...message, content: cutoff });
      }
      pendingUser = undefined;
    }
  }
  if (pendingUser?.content.trim()) {
    if (pendingUser.status === 'interrupted') {
      turns.push(pendingUser, { id: `${pendingUser.id}-cutoff`, role: 'assistant', content: '[Interrupted before any answer text was displayed.]' });
    } else if (!pendingUser.status) turns.push(pendingUser);
  }
  return turns;
}

export default function App() {
  const [token, setToken] = useState(sessionStorage.getItem('chat-token') || '');
  const conversationId = useRef(crypto.randomUUID());
  const [gate, setGate] = useState('');
  const [gatePending, setGatePending] = useState(false);
  const gateRequestPending = useRef(false);
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState('');
  const [dictationStatus, setDictationStatus] = useState('');
  const [dictationActive, setDictationActive] = useState(false);
  const [correction, setCorrection] = useState<TranscriptCorrection | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [webmcp, setWebmcp] = useState('Checking WebMCP availability…');
  const [theme, setTheme] = useState<Theme>(initialTheme);
  const [scale, setScale] = useState(initialScale);
  const [colorOverrides, setColorOverrides] = useState(readSavedColors);
  const [colorTarget, setColorTarget] = useState<ColorTarget>('pageBackground');
  const [colorChoice, setColorChoice] = useState('#f7f7f5');
  const [speech, setSpeech] = useState<SpeechSnapshot>({ messageId: null, phase: 'idle', service: 'idle', detail: '' });
  const speechOutput = useRef<SpeechOutput | null>(null);
  const speechInput = useRef<SpeechInput | null>(null);
  const dictationBase = useRef('');
  const correctionTimer = useRef<number | undefined>(undefined);
  const abort = useRef<AbortController | null>(null);
  const sessionCheck = useRef<Promise<void> | null>(null);
  const tail = useRef<HTMLDivElement>(null);

  if (!speechOutput.current) {
    speechOutput.current = new SpeechOutput(API, () => sessionStorage.getItem('chat-token') || '', setSpeech);
  }

  useEffect(() => {
    if (token) void speechOutput.current?.warmup();
    else {
      speechOutput.current?.stop();
      speechInput.current?.stop();
      speechInput.current = null;
      setDictationActive(false);
      setDictationStatus('');
    }
  }, [token]);
  useEffect(() => () => speechOutput.current?.dispose(), []);
  useEffect(() => () => { speechInput.current?.stop(); window.clearTimeout(correctionTimer.current); }, []);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    document.documentElement.style.setProperty('--scale', String(scale));
    for (const [target, variable] of Object.entries(COLOR_CSS_VARIABLES)) {
      const override = colorOverrides[target as ColorTarget];
      if (override) document.documentElement.style.setProperty(variable, override);
      else document.documentElement.style.removeProperty(variable);
    }
    localStorage.setItem('theme', theme);
    localStorage.setItem('scale', String(scale));
    localStorage.setItem('ui-colors', JSON.stringify(colorOverrides));
  }, [theme, scale, colorOverrides]);
  useEffect(() => {
    if (Object.keys(colorOverrides).length === 0) return;
    const current = preferences(theme, scale).colors;
    const textColors = {
      primaryText: accessibleTextColor(current.primaryText, [current.pageBackground, current.headerBackground, current.messageBackground, current.userMessageBackground]),
      mutedText: accessibleTextColor(current.mutedText, [current.pageBackground]),
      composerText: accessibleTextColor(current.composerText, [current.composerBackground]),
      accent: accessibleTextColor(current.accent, [current.pageBackground, current.headerBackground]),
    };
    if (Object.entries(textColors).some(([key, value]) => current[key as keyof typeof textColors] !== value)) {
      setColorOverrides(overrides => ({ ...overrides, ...textColors }));
    }
  }, [theme]);
  useEffect(() => { tail.current?.scrollIntoView({ behavior: 'smooth' }); }, [messages]);

  const applyUiAction = useCallback((action: UiAction) => {
    if (action.type === 'set_theme') setTheme(action.theme);
    if (action.type === 'set_font_scale') setScale(action.scale);
    if (action.type === 'reset_ui') {
      setTheme('system');
      setScale(1);
      setColorOverrides({});
    }
    if (action.type === 'set_ui_color') {
      const current = preferences(theme, scale).colors;
      const backgroundTargets = ['pageBackground', 'headerBackground', 'messageBackground', 'userMessageBackground', 'composerBackground'];
      if (backgroundTargets.includes(action.target)) {
        const updated = { ...current, [action.target]: action.color };
        const primaryText = accessibleTextColor(current.primaryText, [updated.pageBackground, updated.headerBackground, updated.messageBackground, updated.userMessageBackground]);
        const mutedText = accessibleTextColor(current.mutedText, [updated.pageBackground]);
        const composerText = accessibleTextColor(current.composerText, [updated.composerBackground]);
        const accent = accessibleTextColor(current.accent, [updated.pageBackground, updated.headerBackground]);
        setColorOverrides(overrides => ({ ...overrides, [action.target]: action.color, primaryText, mutedText, composerText, accent }));
        const adjusted = primaryText !== current.primaryText || mutedText !== current.mutedText || composerText !== current.composerText || accent !== current.accent;
        const minimumContrast = Math.min(
          ...[updated.pageBackground, updated.headerBackground, updated.messageBackground, updated.userMessageBackground].map(bg => contrastRatio(primaryText, bg)),
          contrastRatio(mutedText, updated.pageBackground),
          contrastRatio(composerText, updated.composerBackground),
          contrastRatio(accent, updated.pageBackground), contrastRatio(accent, updated.headerBackground),
        );
        return { ok: true, message: adjusted
          ? minimumContrast >= 4.5
            ? `Set ${COLOR_TARGETS[action.target]} to ${action.color} and adjusted text colors to keep at least 4.5:1 contrast.`
            : `Set ${COLOR_TARGETS[action.target]} to ${action.color}; adjusted text colors for best available contrast (${minimumContrast.toFixed(1)}:1), but these different surfaces prevent 4.5:1 everywhere.`
          : `Set ${COLOR_TARGETS[action.target]} to ${action.color}.` };
      }
      const backgrounds: Record<ColorTarget, string[]> = {
        primaryText: [current.pageBackground, current.headerBackground, current.messageBackground, current.userMessageBackground],
        mutedText: [current.pageBackground],
        composerText: [current.composerBackground],
        accent: [current.pageBackground, current.headerBackground, current.messageBackground, current.userMessageBackground],
        pageBackground: [], headerBackground: [], messageBackground: [], userMessageBackground: [], composerBackground: [],
      };
      const applied = backgrounds[action.target].length
        ? accessibleTextColor(action.color, backgrounds[action.target])
        : action.color;
      setColorOverrides(currentOverrides => ({ ...currentOverrides, [action.target]: applied }));
      const contrast = backgrounds[action.target].length ? Math.min(...backgrounds[action.target].map(bg => contrastRatio(applied, bg))) : undefined;
      return { ok: true, message: applied === action.color
        ? `Set ${COLOR_TARGETS[action.target]} to ${applied}.`
        : contrast && contrast >= 4.5
          ? `Set ${COLOR_TARGETS[action.target]} to ${applied}, adjusted from ${action.color} to meet 4.5:1 text contrast (actual ${contrast.toFixed(1)}:1).`
          : `Set ${COLOR_TARGETS[action.target]} to ${applied}, adjusted from ${action.color}; the custom backgrounds limit its best contrast to ${contrast?.toFixed(1)}:1.` };
    }
    if (action.type === 'get_ui_preferences') return { ok: true, preferences: preferences(theme, scale) };
    return { ok: true, message: 'Updated the chat appearance.' };
  }, [theme, scale]);

  const invokeUiTool = useCallback(async (name: unknown, rawInput: unknown, signal: AbortSignal) => {
    const input = toolArguments(rawInput);
    const action = validateUiAction(name, input);
    if (!action || typeof name !== 'string') return { ok: false, message: 'That UI action was invalid and was not applied.' };

    const modelContext = (document as Document & { modelContext?: WebMCPContext }).modelContext;
    if (modelContext && typeof modelContext.getTools === 'function' && typeof modelContext.executeTool === 'function') {
      let tool: WebMCPTool | undefined;
      try {
        tool = (await modelContext.getTools()).find(candidate => candidate.name === name);
      } catch {
        // Discovery can race registration; use the same validated handler when unavailable.
      }
      if (tool) {
        try {
          const rawResult = await executeNativeUiTool(modelContext, tool, input, signal);
          const parsed: unknown = typeof rawResult === 'string' ? JSON.parse(rawResult) : rawResult;
          if (parsed && typeof parsed === 'object' && 'ok' in parsed) return parsed as { ok: boolean; message?: string };
          return { ok: true, message: typeof parsed === 'string' ? parsed : JSON.stringify(parsed) };
        } catch (cause) {
          return { ok: false, message: cause instanceof Error ? `WebMCP tool invocation failed: ${cause.message}` : 'WebMCP tool invocation failed.' };
        }
      }
    }
    return applyUiAction(action);
  }, [applyUiAction]);

  useEffect(() => {
    const doc = document as Document & { modelContext?: WebMCPContext };
    if (!doc.modelContext?.registerTool) {
      setWebmcp(WEBMCP_FALLBACK);
      return;
    }
    let active = true;
    const registration = new AbortController();
    Promise.all(UI_TOOL_DECLARATIONS.map(async declaration => {
      const { name, description, parameters } = declaration;
      await doc.modelContext!.registerTool({
        name,
        description,
        inputSchema: parameters,
        annotations: { readOnlyHint: name === 'get_ui_preferences', consequentialHint: false },
        execute: (input: unknown) => {
          const action = validateUiAction(name, input);
          return action ? applyUiAction(action) : { ok: false, message: 'That UI action is invalid.' };
        },
      }, { signal: registration.signal });
    })).then(() => { if (active) setWebmcp('WebMCP tools are registered. Chat remains available.'); })
      .catch(() => { if (active) setWebmcp(WEBMCP_FALLBACK); });
    return () => { active = false; registration.abort(); };
  }, [applyUiAction]);

  useEffect(() => {
    const current = preferences(theme, scale).colors[colorTarget];
    setColorChoice(current);
  }, [theme, scale, colorTarget, colorOverrides]);

  async function enter(e: FormEvent) {
    e.preventDefault();
    if (gateRequestPending.current) return;
    gateRequestPending.current = true;
    setGatePending(true);
    setError('');
    try {
      const r = await fetch(API + '/api/session', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code: gate }),
      });
      const j = await r.json();
      if (!r.ok) throw Error(j.error || 'Could not open chat.');
      sessionStorage.setItem('chat-token', j.token);
      setToken(j.token);
    } catch (x) {
      setError((x as Error).message);
    } finally {
      gateRequestPending.current = false;
      setGatePending(false);
    }
  }

  async function checkSession() {
    if (!token || sessionCheck.current) return sessionCheck.current;
    const checkedToken = token;
    const check = (async () => {
      try {
        const r = await fetch(API + '/api/session', {
          headers: { 'Authorization': 'Bearer ' + checkedToken },
        });
        if (r.status === 401 && sessionStorage.getItem('chat-token') === checkedToken) {
          sessionStorage.removeItem('chat-token');
          setToken('');
          setError('Your session expired. Enter the code again to continue.');
        }
      } catch {
        // Keep the chat usable during a temporary connection failure.
      }
    })();
    sessionCheck.current = check;
    try { await check; } finally { if (sessionCheck.current === check) sessionCheck.current = null; }
  }

  async function send(e?: FormEvent, text = input) {
    e?.preventDefault();
    const body = text.trim();
    if (!body || abort.current || !token) return;

    stopDictation();
    setCorrection(null);
    window.clearTimeout(correctionTimer.current);

    setInput('');
    setError('');
    const assistantId = crypto.randomUUID();
    const userId = crypto.randomUUID();
    const userMessage: Message = { id: userId, role: 'user', content: body };
    const assistantMessage: Message = { id: assistantId, role: 'assistant', content: '', status: 'pending' };
    setMessages(cur => [...cur, userMessage, assistantMessage]);
    setBusy(true);

    const ctl = new AbortController();
    abort.current = ctl;
    try {
      const r = await fetch(API + '/api/chat', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': 'Bearer ' + token,
          'X-Conversation-ID': conversationId.current,
        },
        body: JSON.stringify({
          messages: [...completedTurns(messages), { role: 'user', content: body }]
            .map(({ role, content }) => ({ role, content })),
        }),
        signal: ctl.signal,
      });
        if (!r.ok) {
          const j = await r.json().catch(() => ({}));
          if (r.status === 401) {
            sessionStorage.removeItem('chat-token');
            setToken('');
            setInput(body);
          }
        throw Error(j.error || 'Request failed (' + r.status + ').');
      }
      const readEvents = async (response: Response, depth = 0): Promise<void> => {
        if (!response.ok) {
          const j = await response.json().catch(() => ({}));
          throw Error(j.error || 'Request failed (' + response.status + ').');
        }
        if (!response.body) throw Error('Streaming is unavailable.');
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        const handle = async (data: string) => {
          if (data === '[DONE]') return;
          const event = JSON.parse(data);
          if (event.error) throw Error(event.error);
          if (typeof event.delta === 'string') {
            setMessages(cur => cur.map(m => m.id === assistantId ? { ...m, content: m.content + event.delta } : m));
          }
          if (Array.isArray(event.tool_calls)) {
            if (depth >= 2) throw Error('The assistant requested too many UI changes in one response.');
            const toolResults = await Promise.all(event.tool_calls.map(async (call: { id?: unknown; name?: unknown; arguments?: unknown }) => {
              const rawResult = await invokeUiTool(call.name, call.arguments, ctl.signal);
              const resultObject = rawResult && typeof rawResult === 'object' ? rawResult as { ok?: unknown; message?: unknown } : {};
              const result = {
                ok: resultObject.ok === true,
                message: typeof resultObject.message === 'string' ? resultObject.message : JSON.stringify(rawResult),
              };
              return { callId: call.id, result };
            }));
            const continuation = await fetch(API + '/api/ui-tool-result', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token, 'X-Conversation-ID': conversationId.current },
              body: JSON.stringify({ toolResults }), signal: ctl.signal,
            });
            await readEvents(continuation, depth + 1);
          }
        };
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split('\n');
          buffer = lines.pop() || '';
          for (const line of lines) if (line.startsWith('data:')) await handle(line.slice(5).trim());
        }
        if (buffer.startsWith('data:')) await handle(buffer.slice(5).trim());
      };
      await readEvents(r);
      setMessages(cur => cur.map(m => m.id === assistantId ? { ...m, status: 'complete' } : m));
    } catch (x) {
      const canceled = (x as Error).name === 'AbortError';
      if (canceled) conversationId.current = crypto.randomUUID();
      else setError((x as Error).message);
      setMessages(cur => {
        return cur.flatMap(m => {
          if ((x as Error).message === 'Your session expired. Enter the code again.' && (m.id === userId || m.id === assistantId)) return [];
          if (m.id === userId) {
            return [{ ...m, status: canceled ? 'interrupted' as const : 'error' as const }];
          }
          if (m.id !== assistantId) return [m];
          if (canceled && !m.content.trim()) return [];
          return [{ ...m, status: canceled ? 'interrupted' as const : 'error' as const }];
        });
      });
    } finally {
      if (abort.current === ctl) {
        abort.current = null;
        setBusy(false);
      }
    }
  }

  function stopDictation() {
    const controller = speechInput.current;
    speechInput.current = null;
    controller?.stop();
    setDictationActive(false);
    setDictationStatus('');
  }

  function startDictation() {
    speechInput.current?.stop();
    speechOutput.current?.stop();
    window.clearTimeout(correctionTimer.current);
    setCorrection(null);
    dictationBase.current = input;
    setError('');
    const inputController = new SpeechInput(API, () => sessionStorage.getItem('chat-token') || '', {
      onStatus: status => { if (speechInput.current === inputController) setDictationStatus(status); },
      onTranscript: update => {
        if (speechInput.current !== inputController) return;
        const dictated = [update.committed, update.interim].filter(Boolean).join(' ').slice(0, Math.max(0, 12000 - dictationBase.current.length));
        setInput(dictationBase.current && dictated
          ? dictationBase.current + (/\s$/.test(dictationBase.current) ? '' : ' ') + dictated
          : dictationBase.current || dictated);
        if (update.corrected) {
          setCorrection(update.corrected);
          window.clearTimeout(correctionTimer.current);
          correctionTimer.current = window.setTimeout(() => setCorrection(null), 5000);
        }
      },
    });
    speechInput.current = inputController;
    setDictationActive(true);
    void inputController.start();
  }

  function interruptAndDictate() {
    if (busy) abort.current?.abort();
    speechOutput.current?.stop();
    startDictation();
  }

  const answerSpeaking = speech.phase === 'loading' || speech.phase === 'speaking-edge' || speech.phase === 'speaking-browser' || speech.phase === 'paused';
  const micLabel = dictationActive ? 'Mute' : busy || answerSpeaking ? 'Interrupt' : 'Mic';

  if (!token) {
    return <main className="gate">
      <div className="mark">✳</div>
      <h1>A quieter kind of chat.</h1>
      <p>Enter your invitation code to begin.</p>
      <form onSubmit={enter} aria-busy={gatePending}>
        <input aria-label="Invitation code" value={gate} onChange={e => setGate(e.target.value)} disabled={gatePending} autoFocus />
        <button type="submit" disabled={gatePending}>{gatePending ? 'Connecting…' : <>Continue <span>→</span></>}</button>
      </form>
      {gatePending && <p className="gate-loading" role="status">Opening chat… This may take a moment while the service starts.</p>}
      {error && <p className="error">{error}</p>}
    </main>;
  }

  return <main className="shell">
    <header>
      <a className="brand" href="/">✳ <span>Chat</span></a>
      <div className="toolbar">
        <label>Theme <select value={theme} onChange={e => applyUiAction({ type: 'set_theme', theme: e.target.value as Theme })}>
          <option value="system">System</option><option value="light">Light</option><option value="dark">Dark</option>
        </select></label>
        <label>Text <button type="button" className="small" aria-label="Decrease text size" onClick={() => applyUiAction({ type: 'set_font_scale', scale: Math.max(.85, scale - .1) })}>−</button>
          <button type="button" className="small" aria-label="Increase text size" onClick={() => applyUiAction({ type: 'set_font_scale', scale: Math.min(1.3, scale + .1) })}>+</button>
        </label>
        <details className="color-controls">
          <summary>Colors</summary>
          <div className="color-panel">
            <label>Change
              <select aria-label="Color target" value={colorTarget} onChange={e => setColorTarget(e.target.value as ColorTarget)}>
                {Object.entries(COLOR_TARGETS).map(([target, title]) => <option key={target} value={target}>{title}</option>)}
              </select>
              <input aria-label="Color value" type="color" value={colorChoice} onChange={e => {
                setColorChoice(e.target.value);
                applyUiAction({ type: 'set_ui_color', target: colorTarget, color: e.target.value });
              }} />
            </label>
            <button type="button" className="reset-colors" onClick={() => applyUiAction({ type: 'reset_ui' })}>Reset appearance</button>
          </div>
        </details>
      </div>
    </header>
    <section className="chat" aria-live="polite">
      {messages.length === 0 ? <div className="welcome">
        <div className="mark">✳</div><h1>What’s on your mind?</h1><p>A helpful assistant, ready when you are.</p>
        <div className="suggestions">{suggestions.map(s =>
          <button key={s} onClick={() => send(undefined, s)}>{s}<span>↗</span></button>
        )}</div>
      </div> : messages.map((m, index) =>
        <article className={'message ' + m.role + (m.status === 'error' ? ' stale' : '')} key={m.id}>
          <div className="avatar">{m.role === 'user' ? 'Y' : '✳'}</div>
          <div className="content">
            {m.role === 'assistant' && m.content
              ? <ReactMarkdown remarkPlugins={[remarkGfm]} skipHtml>{m.content}</ReactMarkdown>
              : m.content || (m.status === 'pending' ? <span className="typing">Thinking<span>…</span></span> : '')}
            {m.role === 'assistant' && m.status === 'complete' && m.content.trim() && <div className="speech-controls">
              <button type="button" onClick={() => speechOutput.current?.toggle(m.id, m.content)}>
                {speech.messageId === m.id && speech.phase === 'paused' ? 'Resume'
                  : speech.messageId === m.id && ['loading', 'speaking-edge', 'speaking-browser'].includes(speech.phase) ? 'Pause'
                    : 'Play'}
              </button>
              {speech.messageId === m.id && ['loading', 'speaking-edge', 'speaking-browser', 'paused'].includes(speech.phase) && <button type="button" onClick={() => speechOutput.current?.stop()}>Stop</button>}
              {speech.messageId === m.id && speech.detail && <span role="status">{speech.detail}</span>}
            </div>}
            {m.role === 'user' && m.status === 'interrupted' && messages[index + 1]?.status !== 'interrupted' && <span className="turn-status"><strong>Interrupted</strong> before a response</span>}
            {m.role === 'assistant' && m.status === 'interrupted' && <span className="turn-status"><strong>Interrupted</strong></span>}
            {m.role === 'assistant' && m.status === 'error' && <span className="turn-status"><strong>Error</strong></span>}
          </div>
        </article>
      )}
      <div ref={tail} />
    </section>
    <footer>
      <p className="notice">{webmcp}</p>
      {speech.service === 'connecting' && <p className="speech-service" role="status">Speech service is waking. Play uses browser speech until Brian is ready.</p>}
        {speech.service === 'unavailable' && <p className="speech-service" role="status">{speech.detail} <button type="button" onClick={() => void speechOutput.current?.reconnect()}>Reconnect</button></p>}
      {speech.service === 'ready' && <p className="speech-service" role="status">Brian voice is ready.</p>}
      {error && <p className="error">{error}</p>}
      <form className="composer" onSubmit={send}>
        <textarea aria-label="Message" placeholder="Message the assistant…" value={input} maxLength={12000}
          onChange={e => setInput(e.target.value)}
          onFocus={() => { void checkSession(); }}
          onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); } }} />
        <button type="button" className="mic" onClick={dictationActive ? stopDictation : interruptAndDictate} disabled={!token} aria-label={micLabel} title={dictationActive ? 'Stop speech recognition' : busy || answerSpeaking ? 'Interrupt and dictate' : 'Dictate'}>
          {micLabel}
        </button>
        <button type="submit" disabled={!input.trim() || busy}>↑</button>
      </form>
      {dictationStatus && <p className="dictation-status" role="status">{dictationStatus}</p>}
      {correction && <p className="correction" role="status"><span>Corrected:</span> <del>{correction.before || '(insertion)'}</del> → <mark>{correction.after || '(removed)'}</mark></p>}
      <p className="footnote">Enter to send · Shift + Enter for a new line</p>
    </footer>
  </main>;
}
