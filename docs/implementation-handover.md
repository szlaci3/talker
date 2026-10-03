# Implementation handover

Prepared 2026-09-25. Read [project-brief.md](project-brief.md) for product requirements and research; this file defines execution. There is no application code, Git setup, live integration test, or deployment established by this planning task. Do not infer infrastructure from the planning documents.

## Workflow and scope

The user intends GPT-6-astra/high for planning and later review, and GPT-6-luna/medium for implementation and bug fixes in a new task. Work in small, completed milestones with explicit checks; avoid requiring the executor to reconstruct architectural decisions. Start implementation only when requested. Do not create the new task or deploy now.

Workspace: `C:\Users\szala\Combine\Talker`. Reference project, read-only for this work: `C:\Users\szala\Planets\Reciter`. AGENTS.md contains the user's Browser Use limitation; do not promise interactive browser verification using an unavailable tool.

Recommended stack: React/TypeScript/Vite frontend on Netlify; Python/aiohttp backend on Render for Antigravity and edge-tts. Do not implement a Gemini fallback. Antigravity uses its managed remote environment; disable agent tools for this chat-only app. A single conversation and general assistant. The chat/WebMCP portfolio target remains desktop, while voice input must also support mobile. No account system, conversation sidebar, attachments, or database-backed chat history. Do not import Reciter's document library or learning features.

## Starting defaults and unresolved dependencies

Use these as provisional defaults when implementation is authorized; record deviations instead of reopening every decision:

| Area | Starting point | What remains to verify |
| --- | --- | --- |
| Browser validation | Desktop Edge and Chrome first; feature-detect everywhere | Broader desktop OS/browser coverage is not promised |
| Chat history | In-memory, one session; reload clears conversation | User has not requested persistence |
| UI settings | System theme initially; theme and font scale may persist locally | Reset always available |
| Model provider | Antigravity managed agent; no Gemini fallback | User reports higher daily and per-minute token quotas on their Antigravity API access; deployed use has been verified. Do not set the agent ID as `GOOGLE_MODEL` |
| Speech | edge-tts with the exact requested Brian voice; browser Daniel during warmup | Enumerate live voices and synthesize a generic sample; verify identifier, never guess it |
| Input language v1 | English and Hungarian, English selected by default | Verify native recognition availability for both locales on target desktop browsers and mobile |
| Audio setup | Headphones or speakers; mobile built-in microphone is a supported setup | Stop answer generation/playback before starting recognition; verify on available desktop and mobile devices |
| Entry gate | Configured random invitation code, validated server-side | User's original daily-number/date idea remains an alternative; settle before public release |
| Voice input v1 | User clicks Mic, dictates into the composer (appending to existing text), and clicks Send; recording spans pauses | Corrections highlighted `#ffdd00` for five seconds; same control becomes Interrupt during generation/playback and then starts microphone input |
| Voice v2 (deferred) | Four seconds of silence auto-submits; “Send now” submits early | Countdown only in final two seconds; incremental answer speech also deferred |

No secrets belong in documentation, prompts, tests, logs, or frontend configuration. Without credentials, develop and test through an explicitly labeled mock adapter, then report the live integration as unverified. Do not claim mocked responses complete the real chat milestone. Do not install a paid transcription provider or purchase hosting without authorization.

## Suggested boundaries

Keep modules small without creating a generic framework:

- `frontend/`: chat UI, API client, typed UI actions, WebMCP adapter, and voice controller. Keep transcript handling separate from audio playback.
- `backend/`: aiohttp routes, Antigravity adapter, edge-tts adapter, session/gate validation, and usage enforcement.
- `docs/`: brief, this plan, and a short implementation status file created when coding starts.

Suggested routes: public `GET /healthz`; `POST /api/session` for the entry code; authenticated `POST /api/chat`, `GET /api/voices`, and `POST /api/speech`. Keep text/audio limits explicit. Use direct HTTPS API calls with an exact origin allowlist and a short-lived bearer session kept in memory as a simple starting point; if choosing cookies/proxying instead, verify browser and streaming behavior. The visitor session is not the Google key or a copy of Reciter's permanent cloud key. Enforce access and usage limits server-side; CORS alone provides neither.

Define the chat stream before wiring UI: discriminated events for text deltas, completed tool requests, completion, and errors. Associate each request and tool call with identifiers. Never execute partially streamed tool arguments. UI tool results return through a bounded continuation request preserving provider-required metadata; reject unknown actions/invalid inputs, limit tool-loop length, and avoid executing a call twice. Treat client history/results as untrusted; server instructions and tool definitions remain server-controlled.

## Milestones

### 1. Typed chat MVP

Create the minimal app and Python service, local startup instructions, example environment variable names, and build/deployment configuration. Implement typed chat, streamed responses, Stop, useful errors, the entry gate, and server request bounds. Keep provider code replaceable. For public release, enforce durable/platform usage limits; restartable process counters alone do not establish a global daily cap. No need for voice to finish this milestone.

Acceptance: two related messages preserve context; Stop halts visible output and ignores late data; network/quota errors allow recovery; empty or oversized input is rejected; provider secrets never reach the frontend build; unauthorized API calls fail. A real Google smoke test is required to mark live chat verified. Include a frontend production build and meaningful backend checks.

### 2. UI tools and WebMCP

Implement `set_theme`, `set_font_scale`, `set_ui_color`, `get_ui_preferences`, and `reset_ui` with shared validated handlers. Color changes cover named page/header/message/input backgrounds, main/secondary/input text, and accents; natural-language colors map to validated hex values. Adjust text colors to preserve contrast where possible. Manual controls, Antigravity function calls, and WebMCP registration use the same handlers. Return UI tool results to Antigravity before it completes the answer. Never execute generated JS/CSS. Detect and register the imperative WebMCP tools with cleanup; when unavailable or registration fails, show a nonblocking availability notice while chat and provider-side appearance tools remain usable. Avoid claiming native support from property existence alone.

Acceptance: “make the text bigger”, “switch to dark mode”, “make the input background red”, and “that red is too dark” change the intended UI; text remains readable or the app reports a contrast limitation; invalid calls cannot corrupt settings; reset works; unavailable WebMCP leaves chat usable. Verify native registration AND invocation in a supported environment before calling the WebMCP demonstration complete. If that environment is unavailable, record the gap and continue independent work.

### 3. Reciter-style speech output

Read Reciter's `edge-speech.js`, `speech.js`, `app.js`, `server.py`, and deployment notes before porting behavior. Reuse patterns, adapting passage recovery to assistant messages. Resolve Brian from the live catalogue and verify synthesis. Prefer Brian from the first segment when ready; otherwise use browser Daniel when available. Prefetch one segment, preserve unread boundaries during switching, and keep play/pause/stop coherent. Do not silently pick the first remote voice if Brian is absent.

Acceptance: cold backend does not block the static UI; fallback explains which voice is in use; switch occurs only for matching unread text; no omitted/duplicated words during a normal handoff; Stop cancels pending audio and prevents late playback; synthesis errors have bounded retries. Check an actual Brian sample and fallback playback separately from mocks. Backend wakeup also delays new Google replies; Daniel cannot speak an answer that has not arrived.

### 4. Voice input v1 and explicit turn control

First verify recognition and partial results on target desktop browsers and an available mobile device, using both headphones and speakers where practical. If native recognition cannot deliver them, show a clear unsupported-browser fallback; isolate recognition behind an adapter so a streaming alternative can be evaluated separately. Keep recognition running until Send even if the browser ends an individual recognition session after a pause; restart it while the same dictated draft remains open. Microphone permission, actual browser support, and service interruptions must have clear recoverable states; do not describe them as solved by edge-tts. Stop answer generation/playback before starting recognition to avoid capturing the assistant's voice.

Use explicit states such as off, listening, generating, speaking, and error. Maintain a monotonically increasing turn/generation identifier so stale recognition, model, and audio events cannot affect a newer turn. Voice input starts only after the user clicks Mic or Interrupt.

- Show current partial words immediately. Append dictated text after any existing composer draft, then apply recognition revisions in place; avoid appending the entire transcript on every event.
- Highlight corrected spans with `#ffdd00` for five seconds, leaving unchanged words steady. Handle insertions/deletions. Visual feedback must not delay transcript display.
- Keep recognition active through pauses of any length; do not auto-submit on silence. The user clicks Send to commit the latest transcript once. Freeze submitted text and ignore late recognition callbacks.
- Use one dynamic control: “Mic” when voice input can start; “Interrupt” while generation or answer playback is active. While recording, show “Listening” as status and leave Send as the explicit end-and-submit action. Interrupt cancels generation and pending speech preparation, or stops current playback, then starts microphone input. Keep any partial generated answer visibly marked as interrupted.
- Retain the existing speech-output behavior: the user clicks Play after the complete answer is available. V2 may add silence-based submission and incremental speech that plays early answer chunks while later text arrives; neither belongs in v1.
- Keep submitted turn text stable. Late events from a committed turn must not silently rewrite an answered message or send it again.
- Exiting voice mode releases microphone resources and cancels pending turn timers. Typed chat remains usable.

Acceptance: clicking Mic starts live transcription; words revise in place; corrected spans receive `#ffdd00` highlight for five seconds; recognition remains active through long pauses; only Send submits the draft; late events cannot alter submitted text. Interrupt cancels generation or playback and starts microphone input. Assistant speech output remains manual Play. Verify supported desktop and mobile setups, including headphones and speakers where available. Include meaningful state/race tests and a real microphone check. If interactive checks cannot be run, supply exact user verification steps and mark them pending.

### 5. Release and review

Prepare Netlify and Render configuration with environment-variable names, origin/session setup, health checks, usage bounds, and a short desktop smoke checklist. Public deployment happens when authorized. Test the actual split-host setup, including streaming and a cold Render start; local success does not verify cross-origin behavior. Leave native WebMCP support and voice limitations explicit.

Review with GPT-6-astra/high should focus on secret handling, access/usage enforcement, correct tool execution, cancellation races, transcript duplication, echo/interrupt behavior, and honest native-WebMCP claims. Fix verified defects with the implementation model; avoid redesigning working parts without a requirement or concrete failure.

## Progress handoff

When coding begins, maintain `docs/implementation-status.md` with only: current milestone, actual files/commands, checks passed, live checks pending, known defects, and the next concrete step. Update the brief when requirements change rather than keeping conflicting copies. For bugs, capture the reproduction, expected/observed behavior, fix, and relevant verification.

Starter message for the new implementation task:

> Implement the typed-chat MVP in C:\Users\szala\Combine\Talker. Read AGENTS.md, docs/project-brief.md, and docs/implementation-handover.md first, plus docs/implementation-status.md if it exists. Use the documented React/TypeScript frontend and Python/aiohttp backend direction, with Netlify/Render deployment configuration. Reciter at C:\Users\szala\Planets\Reciter is a read-only reference. Complete milestone 1 and its available checks, recording missing credentials or live verification honestly. Preserve the later WebMCP and hands-free voice requirements in the architecture without implementing those later milestones yet. Update the implementation status and report the result. Do not deploy publicly in this task.
