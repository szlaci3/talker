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
| ASR architecture v1 | Gemini 3.5 Transcribe Live handles the full dictation with automatic language detection and streaming transcript updates | Renew/resume the Live session at its duration limit while preserving the draft |
| ASR fallback v1 | Browser speech recognition in English is used only if Live fails or cannot resume | Frontend handles user-visible provider errors; no server-side three-call cap. Portfolio assumes one user at a time |
| ASR cost v1 | Must remain free of charge; do not enable paid usage or paid fallback | Confirm model is available on a no-billing Free Tier project; handle quota exhaustion without charges and preserve the draft |
| Audio setup | Headphones or speakers; mobile built-in microphone is a supported setup | Stop answer generation/playback before starting recognition; verify on available desktop and mobile devices |
| Entry gate | Configured random invitation code, validated server-side | User's original daily-number/date idea remains an alternative; settle before public release |
| Dictation | User clicks Mic, dictates into the composer (appending to existing text), and clicks Send; recording spans pauses | Corrections highlighted `#ffdd00` for five seconds; Mic/Mute remains input-only and does not interrupt answers |
| Live audio | User clicks Live for a persistent voice conversation; transcript stays visible and utterances auto-send after four seconds of silence | Countdown only in final two seconds; complete answers play automatically; speech interrupts generation/playback with the confirmed history behavior; incremental answer speech deferred |

No secrets belong in documentation, prompts, tests, logs, or frontend configuration. Without credentials, develop and test through an explicitly labeled mock adapter, then report the live integration as unverified. Do not claim mocked responses complete the real chat milestone. Do not install a paid transcription provider or purchase hosting without authorization.

## Suggested boundaries

Keep modules small without creating a generic framework:

- `frontend/`: chat UI, API client, typed UI actions, WebMCP adapter, and voice controller. Keep transcript handling separate from audio playback.
- `backend/`: aiohttp routes, Antigravity adapter, edge-tts adapter, session/gate validation, and usage enforcement.
- `docs/`: brief, this plan, and a short implementation status file created when coding starts.

Suggested routes: public `GET /healthz`; `POST /api/session` for the entry code; authenticated `POST /api/chat`, `GET /api/voices`, `POST /api/speech`, and `POST /api/live-token`. Live token provisioning must constrain a single-use ephemeral credential to `gemini-3.5-transcribe-live` and the transcription model/configuration. The browser can then connect directly over WebSocket with the ephemeral token; session resumption is requested in the Live setup. Never return the permanent Google API key. Keep text/audio limits explicit. Use direct HTTPS API calls with an exact origin allowlist and a short-lived bearer session kept in memory as a simple starting point; if choosing cookies/proxying instead, verify browser and streaming behavior. The visitor session is not the Google key or a copy of Reciter's permanent cloud key. Enforce access and usage limits server-side; CORS alone provides neither.

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

### 4. Dictation and Live audio

Use Gemini 3.5 Transcribe Live for the full dictation, not regular Transcribe plus browser recognition. Live provides interim/final transcripts and automatic language detection. Respect its 10-minute session limit by renewing/resuming Live without losing or duplicating transcript text. Use browser SpeechRecognition configured for English only when Live fails or cannot resume; show a clear error/fallback state. The portfolio assumes one user at a time; frontend handles quota, connection, and concurrency errors gracefully, and no server-side three-call-per-minute cap is requested. Use the existing server-side Google API key/project and keep it out of browser code; confirm the project remains on a no-billing tier. Do not add a detected-language/refresh-to-switch message. Continue listening through pauses until Mute or Send, preserve the composer draft across recognizer restarts, and stop answer playback/generation before microphone capture. Verify on target desktop and mobile with headphones and speakers where practical.

Keep dictation and Live as separate modes. Dictation is input-only: Mic/Mute appends speech to the composer, and Send submits it. Live starts a persistent voice conversation, displays the transcript in real time, and submits an utterance after four seconds of silence. Show “Send now” when there is text, and display a countdown only during the final two seconds. Recognition revisions do not restart the timer. Keep Live active across turns until ended or the user clicks elsewhere in the interface; stop Live on that click, then allow the clicked action to proceed.

Use explicit states such as off, listening, generating, speaking, and error. Maintain a monotonically increasing turn/generation identifier so stale recognition, model, and audio events cannot affect a newer turn. Starting Live cancels assistant generation/playback before microphone capture.

- Show current partial words immediately. Append dictated text after any existing composer draft, then apply recognition revisions in place; avoid appending the entire transcript on every event.
- Highlight corrected spans with `#ffdd00` for five seconds, leaving unchanged words steady. Handle insertions/deletions. Visual feedback must not delay transcript display.
- Dictation remains active through pauses until Mute or Send. Mute stops capture without submitting or clearing the draft. A subsequent Mic appends to preserved text. Freeze submitted text and ignore late recognition callbacks.
- In Live, speaking during generation cancels it and keeps visible partial text marked Interrupted. Speaking during playback stops only playback and keeps the complete answer. In both cases the new utterance is the next turn. An explicit Interrupt control may also cancel generation or playback without changing these history rules.
- Wait until the complete answer is available, then play it automatically while Live remains active. Incremental answer speech remains deferred.
- Keep submitted turn text stable. Late events from a committed turn must not silently rewrite an answered message or send it again.
- Exiting voice mode releases microphone resources and cancels pending turn timers. Typed chat remains usable.

Acceptance: Gemini Live handles dictation with automatic language detection; interim words appear in the composer and corrections are highlighted for five seconds. Dictation Mute stops capture without clearing or submitting the draft; only Send submits it. Live keeps the recognizer active across turns, sends after four seconds of silence, exposes early Send, and plays the completed answer. Voice interruption keeps the appropriate partial or complete answer and sends the new utterance as the next turn. Live session renewal preserves the transcript. On Live failure, browser English recognition is the fallback and no billable usage is triggered. Verify supported desktop and mobile setups, including headphones and speakers where available. Include meaningful state/race tests and a real microphone check. If interactive checks cannot be run, supply exact user verification steps and mark them pending.

### 5. Release and review

Prepare Netlify and Render configuration with environment-variable names, origin/session setup, health checks, usage bounds, and a short desktop smoke checklist. Public deployment happens when authorized. Test the actual split-host setup, including streaming and a cold Render start; local success does not verify cross-origin behavior. Leave native WebMCP support and voice limitations explicit.

Review with GPT-6-astra/high should focus on secret handling, access/usage enforcement, correct tool execution, cancellation races, transcript duplication, echo/interrupt behavior, and honest native-WebMCP claims. Fix verified defects with the implementation model; avoid redesigning working parts without a requirement or concrete failure.

## Progress handoff

When coding begins, maintain `docs/implementation-status.md` with only: current milestone, actual files/commands, checks passed, live checks pending, known defects, and the next concrete step. Update the brief when requirements change rather than keeping conflicting copies. For bugs, capture the reproduction, expected/observed behavior, fix, and relevant verification.

Starter message for the new implementation task:

> Implement the typed-chat MVP in C:\Users\szala\Combine\Talker. Read AGENTS.md, docs/project-brief.md, and docs/implementation-handover.md first, plus docs/implementation-status.md if it exists. Use the documented React/TypeScript frontend and Python/aiohttp backend direction, with Netlify/Render deployment configuration. Reciter at C:\Users\szala\Planets\Reciter is a read-only reference. Complete milestone 1 and its available checks, recording missing credentials or live verification honestly. Preserve the later WebMCP and hands-free voice requirements in the architecture without implementing those later milestones yet. Update the implementation status and report the result. Do not deploy publicly in this task.
