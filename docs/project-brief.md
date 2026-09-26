# Portfolio chat: project brief

Updated: 2026-09-26. Status: Talker milestone 1 is deployed; user reports successful Antigravity chat, multi-turn context, cancellation/recovery, cold-start, and 28 requests in one day without quota problems. Decision: do not implement a Gemini fallback; Antigravity is the sole production provider. Recommendations below are proposed defaults, not additional user commitments. Current checks and next steps live in [implementation-status.md](implementation-status.md); execution details live in [implementation-handover.md](implementation-handover.md).

## User requirements

- Developer-portfolio proof of concept showcasing WebMCP.
- Target standard desktop browsers; phones are out of scope. When WebMCP is unavailable, display a notice and continue with the best available fallbacks. Native WebMCP is not required in every browser; desktop browser/OS coverage is partial and not fully verified; this limitation is accepted.
- Initially one chat screen, visually familiar to ChatGPT, one conversation, no sidebars. Typed messages and answers form the first MVP.
- General-purpose assistant with suggested prompts demonstrating conversational UI changes (user accepted this recommendation).
- Users can request theme and font-size changes, plus natural-language color changes for named UI areas: page/header/message/input backgrounds, main/secondary/input text, and accents. Follow-ups such as “that red is too dark” should adjust the last color target. Do not implement arbitrary UI changes, typography styles, or generated CSS/JavaScript.
- Voice output must use `edge-tts`, following the voice experience in the user's Reciter website: Daniel during warmup, then preferably always Microsoft Brian Multilingual Online (Natural) - English (United States). Reciter's fallback mechanism has been inspected; Brian's exact service identifier remains unverified. Later voice input must show evolving transcription while the user speaks, without waiting for dictation to finish before displaying text.
- Voice mode must be hands-free after activation: detect end of turn, submit automatically, speak the answer, and continue listening. Show words as recognition produces them, allow revisions within seconds, and visually mark those corrections. When the user starts speaking during an answer, stop the assistant's speech immediately and listen; this interruption behavior is confirmed.
- Use the Antigravity managed agent as the production provider. The user reports higher daily and per-minute token quotas for it than for direct Gemini and has decided not to implement Gemini fallback.
- Host the frontend on Netlify; the user favors a Render backend for the server-side API and `edge-tts`.
- Add light entry friction against bots. The proposed code starts at 11 and increments daily beyond 99; typing the current date was another possibility. The mechanism remains open for review.

## Recommended architecture

Use React + TypeScript + Vite and simple CSS variables for appearance on Netlify. Recommend a Python `aiohttp` API on Render to host `edge-tts` and Google requests together, reusing Reciter's backend approach; a separate Node server is unnecessary. This supersedes the initial Netlify Functions recommendation following the user's explicit `edge-tts` choice. React helps coordinate streaming messages, speech state, preferences, and tool-driven updates. Vanilla TypeScript offers no WebMCP compatibility advantage.

Flow: Netlify browser chat -> Render API -> Antigravity -> streamed answer/tool request -> browser validates and executes a known UI action -> tool result returns to the model when needed. No Gemini fallback is planned. Speech: completed text segments -> Render `edge-tts` -> browser audio playback. Configure allowed frontend origins and a working session transport; CORS is not authentication. Direct cross-site calls versus a same-origin proxy remains an implementation choice to validate for streaming and cookies.

Keep the Google key in Render server environment variables, never in the browser bundle, browser storage, or a VITE-prefixed variable. Backend responsibilities: entry/session validation, request limits for chat and TTS, input/context/output bounds, provider calls, timeouts, cancellation, and useful quota errors. Initial chat history lives only in page state and clears on reload. Antigravity interaction IDs are bound to a per-page conversation ID, separate from the access token, so reload begins a new model conversation. No conversation database is used. Shared usage counters require platform enforcement or durable storage rather than restart-sensitive process memory.

Use one small action registry: `set_theme`, `set_font_scale`, `set_ui_color`, `get_ui_preferences`, and `reset_ui`. Validate enumerations, numeric bounds, color targets, and hex colors. Manual controls, Antigravity function calls, and WebMCP registration share the same handlers, updating React state and CSS variables. Persist appearance locally, keep actions reversible, and provide a reset. Adjust foreground colors to preserve readable contrast when possible, and report when conflicting custom surfaces prevent the target contrast. Do not allow arbitrary generated scripts, markup, or styles.

## WebMCP feasibility

WebMCP is an evolving browser proposal, usable as progressive enhancement. It exposes structured tools on the live page; it does not supply the LLM or automatically connect a cloud model to the visitor's tab. The current draft uses `document.modelContext`, with tool registration, discovery, and execution APIs; older examples use `navigator.modelContext`. Verify the target browser implementation rather than blindly copying either version. See the [Chrome guide](https://developer.chrome.com/docs/ai/webmcp) and [current draft](https://webmachinelearning.github.io/webmcp/).

Expose the shared actions through a small WebMCP adapter. On a compatible implementation, the in-page agent can use supported discovery/execution APIs; otherwise invoke the same registry directly. The user explicitly accepts fallbacks: show a nonblocking availability notice and keep the application working as well as possible. Do not label ordinary function calling as native WebMCP. Chrome lists an origin trial; eligibility and current versions remain unverified. A portfolio claim of native WebMCP still requires demonstrated registration and invocation in a supported browser/agent. HTTPS, origin isolation, and permissions policy need verification; universal native browser support is no longer a requirement.

## Google model choice

Google currently documents `antigravity-preview-09-2026`, defaulting to `gemini-3.8-flash`, with free- and paid-tier API access. It is a managed agent with a remote sandbox and potentially long autonomous workflows. This is distinct from a direct model call and from an IDE subscription. See [Antigravity API](https://ai.google.dev/gemini-api/docs/antigravity-agent).

The user's quota comparison is account-specific and user-reported. Direct Gemini fallback is explicitly out of scope. The user reports 28 requests in one day without quota errors; this does not establish the provider's full daily limit. The Antigravity API uses the Interactions endpoint and agent ID `antigravity-preview-09-2026`; it is not a Gemini model ID for `GOOGLE_MODEL`. The agent currently defaults to Gemini 3.8 Flash under its managed harness, with a separate supported-model setting. The app overrides default agent tools with only its validated appearance functions; it does not enable code execution, browsing, or filesystem tools. Each turn remains in backend-managed interaction state. See the [managed agents quickstart](https://ai.google.dev/gemini-api/docs/managed-agents-quickstart) and [streaming guide](https://ai.google.dev/gemini-api/docs/streaming).

Actual model access and free quotas must be checked in the user's Google AI Studio project. Quotas are shared per project, not multiplied per visitor or API key; published limits do not guarantee capacity. Provide an explicit exhausted-quota state and bounded retries. See [rate limits](https://ai.google.dev/gemini-api/docs/rate-limits).

## Voice feasibility

Output decision: use server-side `edge-tts`, a Python client for Edge's online speech service. It does not require visitors to run Edge or Windows. The browser plays returned audio. This replaces the earlier browser-synthesis-first proposal. See the [edge-tts project](https://github.com/rany2/edge-tts).

Reference inspected on 2026-09-25: `C:\Users\szala\Planets\Reciter`. Relevant files: `edge-speech.js` (warmup, prefetch, playback, cancellation), `speech.js` (segmentation), `app.js` (voice selection), `server.py` (`aiohttp` API), `render.yaml`, and `DEPLOY-RENDER.md`. Its requirements pin `edge-tts==7.2.8` and `aiohttp==3.14.3`. The deployment note reports prior successful Netlify/Render use; this task performed code review only, not a live deployment or listening test. Reciter was not modified.

Voice policy: prefer Microsoft Brian Multilingual Online (Natural) - English (United States) immediately when available; Daniel is a temporary warmup/fallback voice, not a compulsory first utterance. Reciter selects browser-provided Daniel (British English, preferred pitch 1.4); it is not an `edge-tts` voice identifier and is not available on every device. Reciter's current remote default is `en-GB-SoniaNeural`; this project's requested remote voice is Brian. Verify Brian against the live service catalogue and synthesis before selecting an identifier; do not invent one or silently substitute a similarly named voice. If Daniel is absent, offer another browser voice with an accurate status.

Reuse Reciter's behavior: bounded readiness retries while Daniel continues; prefetch one upcoming segment; switch only at an unread segment boundary when matching audio is ready; retain segmentation across the handoff; cancel stale requests/audio on Stop. Its connection checks allow six 12-second attempts with five 3-second delays, and speech requests retry a 502 once. Adapt passage-level recovery to assistant messages. Retain play/pause/resume and browser playback-permission handling; mobile-specific work is out of scope. Prefer Brian for every segment once ready. Reciter buffers complete MP3 segments rather than streaming audio bytes to playback; LLM text streaming is separate. Treat upstream failures explicitly; `edge-tts` does not provide speech recognition.

Input: prototype `SpeechRecognition` with interim results. Render provisional text immediately when received and replace it as recognition revises it. This provides live transcription, not guaranteed instantaneous or immutable word-by-word output. Browser/service support varies; microphone permission is required and audio may be processed remotely. Evaluate a streaming transcription service fallback for target desktop browsers lacking recognition; provider and cost remain undecided. See [interim results](https://developer.mozilla.org/en-US/docs/Web/API/SpeechRecognition/interimResults) and [recognition support](https://developer.mozilla.org/en-US/docs/Web/API/SpeechRecognition).

Hands-free interaction is a confirmed requirement, superseding the earlier explicit-Send recommendation. After the user activates voice mode, detect the end of their turn, commit the latest transcript once, automatically send it, read the response, and resume listening. Allow thinking pauses and recognition revisions before committing; do not send each partial result or treat one finalized recognition fragment as a complete user turn. When the user starts speaking, stop current playback immediately and discard queued speech so the old answer cannot resume over them. Keep recognition available during playback and prevent the assistant's audio from triggering false user turns. Silence timing and late corrections after submission remain implementation choices; typed input stays available.

Correction visuals are required. Proposed treatment: distinguish provisional text subtly, briefly highlight only words replaced/inserted by a correction, then fade to normal; represent removed words without leaving stale text in the submitted transcript. Preserve unaffected text and avoid animating the entire message on each recognition event. Respect reduced-motion preferences with a static emphasis. The visual treatment is a recommendation, not yet user-selected; measure revision latency rather than promising a fixed recognition delay.

## Hosting and entry friction

Current hosting direction: Netlify static frontend plus Render Python API for Antigravity/Gemini and `edge-tts`. Render's free web services sleep after 15 idle minutes and typically take about one minute to restart. Early readiness requests can overlap startup with entry-code typing, but cannot guarantee Brian is ready immediately. A paid instance avoids idle spindown; no paid plan has been authorized or purchased. See [Render free services](https://render.com/docs/free). Keep the frontend usable during startup and distinguish backend readiness from successful TTS synthesis. Daniel can read existing text while Render sleeps; new model-generated answers also wait for Render if the same backend serves both APIs.

A date or predictable daily counter is light friction, not meaningful bot resistance. Recommend a short random invitation code shared alongside the link, validated server-side, exchanged for an expiring signed session cookie, with limits on both entry attempts and chat requests. Add a global daily usage cap. Exact code format/rotation is undecided. If the daily counter is retained, define its start date and timezone explicitly; never rely on a frontend-only check to protect the Google quota.

## Delivery sequence and acceptance

1. Text MVP: responsive single-thread chat, typed input, real streamed Google answers, loading/error/stop behavior, protected key, bounded usage, and chosen entry gate before public sharing.
2. Portfolio demonstration: conversational theme/font and bounded natural-language color changes, notice and best-effort behavior when WebMCP is unavailable, and verified native tool registration/invocation where supported.
3. Voice output: Reciter-like play/stop and warmup experience using `edge-tts`, preferring verified Brian; verify Daniel's fallback availability and safe switching.
4. Hands-free voice: live partial transcription with correction effects, automatic end-of-turn submission and spoken answers, continued listening, duplicate-send/echo prevention, and a transcription fallback for target desktop browsers lacking native recognition.

Verify each milestone against its behavior before expanding scope. Do not claim voice or native WebMCP support based on documentation alone.

## Open decisions

- Desktop browser/OS coverage is partial, not fully verified, and accepted; phones are excluded and WebMCP fallback with a notice is accepted.
- Brian's exact service identifier and synthesis availability; acceptable alternate browser voice when Daniel is absent.
- Voice languages; transcript persistence; silence timing and treatment of late transcript corrections after a turn is sent. Immediate interruption on user speech is confirmed.
- Exact entry-code mechanism.

Next step: manually verify the milestone 2 color request, follow-up adjustment, contrast handling, and reset after deploy. Native WebMCP invocation still needs a supported browser/agent; see [implementation-status.md](implementation-status.md).
