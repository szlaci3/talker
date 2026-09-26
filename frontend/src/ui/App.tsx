import { FormEvent, useCallback, useEffect, useRef, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { accessibleTextColor, COLOR_CSS_VARIABLES, COLOR_TARGETS, ColorPreferences, ColorTarget, contrastRatio, DEFAULT_COLORS, initialScale, initialTheme, parseColor, readSavedColors, Theme, UI_TOOL_DECLARATIONS, UiAction, validateUiAction } from './uiTools';
import { SpeechOutput, SpeechSnapshot } from './speechOutput';

type Message = {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  status?: 'pending' | 'complete' | 'interrupted' | 'canceled';
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
      // A newer user turn supersedes an unanswered turn left by a cancellation.
      pendingUser = message;
    } else {
      if (pendingUser && message.status === 'complete' && pendingUser.content.trim() && message.content.trim()) {
        turns.push(pendingUser, message);
      }
      pendingUser = undefined;
    }
  }
  return turns;
}

export default function App() {
  const [token, setToken] = useState(sessionStorage.getItem('chat-token') || '');
  const conversationId = useRef(crypto.randomUUID());
  const [gate, setGate] = useState('');
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState('');
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
  const abort = useRef<AbortController | null>(null);
  const tail = useRef<HTMLDivElement>(null);

  if (!speechOutput.current) {
    speechOutput.current = new SpeechOutput(API, () => sessionStorage.getItem('chat-token') || '', setSpeech);
  }

  useEffect(() => {
    if (token) void speechOutput.current?.warmup();
    else speechOutput.current?.stop();
  }, [token]);
  useEffect(() => () => speechOutput.current?.dispose(), []);

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

  useEffect(() => {
    const doc = document as Document & { modelContext?: { registerTool: (tool: Record<string, unknown>, options?: { signal?: AbortSignal }) => Promise<void> } };
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
          return JSON.stringify(action ? applyUiAction(action) : { ok: false, message: 'That UI action is invalid.' });
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
    }
  }

  async function send(e?: FormEvent, text = input) {
    e?.preventDefault();
    const body = text.trim();
    if (!body || abort.current || !token) return;

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
            const toolResults = event.tool_calls.map((call: { id?: unknown; name?: unknown; arguments?: unknown }) => {
              const action = validateUiAction(call.name, toolArguments(call.arguments));
              const rawResult = action ? applyUiAction(action) : { ok: false, message: 'That UI action was invalid and was not applied.' };
              const resultObject = rawResult && typeof rawResult === 'object' ? rawResult as { ok?: unknown; message?: unknown } : {};
              const result = {
                ok: resultObject.ok === true,
                message: typeof resultObject.message === 'string' ? resultObject.message : JSON.stringify(rawResult),
              };
              return { callId: call.id, result };
            });
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
        const hasPartialAnswer = cur.some(m => m.id === assistantId && m.content.trim());
        return cur.flatMap(m => {
          if (m.id === userId && canceled) {
            return [{ ...m, status: hasPartialAnswer ? 'interrupted' as const : 'canceled' as const }];
          }
          if (m.id !== assistantId) return [m];
          return m.content.trim() ? [{ ...m, status: 'interrupted' as const }] : [];
        });
      });
    } finally {
      if (abort.current === ctl) {
        abort.current = null;
        setBusy(false);
      }
    }
  }

  if (!token) {
    return <main className="gate">
      <div className="mark">✳</div>
      <h1>A quieter kind of chat.</h1>
      <p>Enter your invitation code to begin.</p>
      <form onSubmit={enter}>
        <input aria-label="Invitation code" value={gate} onChange={e => setGate(e.target.value)} autoFocus />
        <button>Continue <span>→</span></button>
      </form>
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
      </div> : messages.map(m =>
        <article className={'message ' + m.role + (m.status === 'canceled' || m.status === 'interrupted' ? ' stale' : '')} key={m.id}>
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
            {m.status === 'canceled' && <span className="turn-status">Canceled before a response</span>}
            {m.role === 'assistant' && m.status === 'interrupted' && <span className="turn-status">Stopped</span>}
          </div>
        </article>
      )}
      <div ref={tail} />
    </section>
    <footer>
      <p className="notice">{webmcp}</p>
      {speech.service === 'connecting' && <p className="speech-service" role="status">Speech service is waking. Play uses browser speech until Brian is ready.</p>}
      {speech.service === 'unavailable' && <p className="speech-service" role="status">{speech.detail} <button type="button" onClick={() => void speechOutput.current?.warmup()}>Reconnect</button></p>}
      {speech.service === 'ready' && <p className="speech-service" role="status">Brian voice is ready.</p>}
      {error && <p className="error">{error}</p>}
      <form className="composer" onSubmit={send}>
        <textarea aria-label="Message" placeholder="Message the assistant…" value={input} maxLength={12000}
          onChange={e => setInput(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); } }} />
        {busy
          ? <button type="button" className="stop" onClick={() => abort.current?.abort()}>Stop</button>
          : <button type="submit" disabled={!input.trim()}>↑</button>}
      </form>
      <p className="footnote">Enter to send · Shift + Enter for a new line</p>
    </footer>
  </main>;
}
