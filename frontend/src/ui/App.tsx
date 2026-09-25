import { FormEvent, useEffect, useRef, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
type Message = { role: 'user'|'assistant'; content: string };
const API = import.meta.env.VITE_API_URL || 'http://localhost:8080';
const suggestions = ['What can you help me with?', 'Explain a tricky idea simply', 'Help me plan a small project'];
function completedTurns(items: Message[]): Message[] {
  const turns: Message[] = [];
  for (let i = 0; i + 1 < items.length; i += 2) {
    const user = items[i], assistant = items[i + 1];
    if (user.role === 'user' && assistant.role === 'assistant' && user.content.trim() && assistant.content.trim()) turns.push(user, assistant);
  }
  return turns;
}
export default function App() {
  const [token,setToken]=useState(sessionStorage.getItem('chat-token')||'');
  const [conversationId]=useState(()=>crypto.randomUUID());
  const [gate,setGate]=useState(''); const [messages,setMessages]=useState<Message[]>([]);
  const [input,setInput]=useState(''); const [busy,setBusy]=useState(false); const [error,setError]=useState('');
  const [webmcp,setWebmcp]=useState('Checking WebMCP availability…'); const [theme,setTheme]=useState(localStorage.getItem('theme')||'system');
  const [scale,setScale]=useState(Number(localStorage.getItem('scale')||1));
  const abort=useRef<AbortController|null>(null); const tail=useRef<HTMLDivElement>(null);
  useEffect(()=>{document.documentElement.dataset.theme=theme;document.documentElement.style.setProperty('--scale',String(scale));localStorage.setItem('theme',theme);localStorage.setItem('scale',String(scale));},[theme,scale]);
  useEffect(()=>{tail.current?.scrollIntoView({behavior:'smooth'});},[messages]);
  useEffect(()=>{setWebmcp("WebMCP isn't integrated in this MVP. Chat remains available.");},[]);
  async function enter(e:FormEvent){e.preventDefault();setError('');try{const r=await fetch(`${API}/api/session`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({code:gate})});const j=await r.json();if(!r.ok)throw Error(j.error||'Could not open chat.');sessionStorage.setItem('chat-token',j.token);setToken(j.token);}catch(x){setError((x as Error).message);}}
  async function send(e?:FormEvent, text=input){e?.preventDefault();const body=text.trim();if(!body||busy||!token)return;setInput('');setError('');const next=[...messages,{role:'user' as const,content:body},{role:'assistant' as const,content:''}];setMessages(next);setBusy(true);const ctl=new AbortController();abort.current=ctl;
    try{const r=await fetch(`${API}/api/chat`,{method:'POST',headers:{'Content-Type':'application/json','Authorization':`Bearer ${token}`,'X-Conversation-ID':conversationId},body:JSON.stringify({messages:[...completedTurns(messages),{role:'user',content:body}]}),signal:ctl.signal});if(!r.ok){const j=await r.json().catch(()=>({}));if(r.status===401){sessionStorage.removeItem('chat-token');setToken('');}throw Error(j.error||`Request failed (${r.status}).`);}if(!r.body)throw Error('Streaming is unavailable.');const reader=r.body.getReader(),decoder=new TextDecoder();let buffer='';while(true){const {done,value}=await reader.read();if(done)break;buffer+=decoder.decode(value,{stream:true});const lines=buffer.split('\n');buffer=lines.pop()||'';for(const line of lines){if(!line.startsWith('data:'))continue;const data=line.slice(5).trim();if(data==='[DONE]')break;try{const event=JSON.parse(data);if(event.error)throw Error(event.error);if(event.delta)setMessages(cur=>cur.map((m,i)=>i===cur.length-1?{...m,content:m.content+event.delta}:m));}catch(err){if(err instanceof Error&&err.message!=='Unexpected end of JSON input')throw err;}}}}
    catch(x){if((x as Error).name==='AbortError'){setMessages(cur=>cur[cur.length-1]?.role==='assistant'&&!cur[cur.length-1].content?cur.slice(0,-1):cur);}else{setError((x as Error).message);setMessages(cur=>cur[cur.length-1]?.content?cur:cur.slice(0,-1));}}finally{setBusy(false);abort.current=null;}}
  if(!token)return <main className="gate"><div className="mark">✳</div><h1>A quieter kind of chat.</h1><p>Enter your invitation code to begin.</p><form onSubmit={enter}><input aria-label="Invitation code" value={gate} onChange={e=>setGate(e.target.value)} autoFocus/><button>Continue <span>→</span></button></form>{error&&<p className="error">{error}</p>}</main>;
  return <main className="shell"><header><a className="brand" href="/">✳ <span>Chat</span></a><div className="toolbar"><label>Theme <select value={theme} onChange={e=>setTheme(e.target.value)}><option value="system">System</option><option value="light">Light</option><option value="dark">Dark</option></select></label><label>Text <button className="small" onClick={()=>setScale(Math.max(.85,scale-.1))}>−</button><button className="small" onClick={()=>setScale(Math.min(1.3,scale+.1))}>+</button></label></div></header>
  <section className="chat" aria-live="polite">{messages.length===0?<div className="welcome"><div className="mark">✳</div><h1>What’s on your mind?</h1><p>A helpful assistant, ready when you are.</p><div className="suggestions">{suggestions.map(s=><button key={s} onClick={()=>send(undefined,s)}>{s}<span>↗</span></button>)}</div></div>:messages.map((m,i)=><article className={`message ${m.role}`} key={i}><div className="avatar">{m.role==='user'?'Y':'✳'}</div><div className="content">{m.role==='assistant'&&m.content?<ReactMarkdown remarkPlugins={[remarkGfm]} skipHtml>{m.content}</ReactMarkdown>:m.content|| (busy&&i===messages.length-1?<span className="typing">Thinking<span>…</span></span>:'')}</div></article>)}<div ref={tail}/></section>
  <footer><p className="notice">{webmcp}</p>{error&&<p className="error">{error}</p>}<form className="composer" onSubmit={send}><textarea aria-label="Message" placeholder="Message the assistant…" value={input} maxLength={12000} onChange={e=>setInput(e.target.value)} onKeyDown={e=>{if(e.key==='Enter'&&!e.shiftKey){e.preventDefault();send();}}}/>{busy?<button type="button" className="stop" onClick={()=>abort.current?.abort()}>Stop</button>:<button type="submit" disabled={!input.trim()}>↑</button>}</form><p className="footnote">Enter to send · Shift + Enter for a new line</p></footer></main>;
}
