# Antigravity on Netlify

Implemented 2026-10-17. Activation and hosted verification remain owner steps. Dialog's existing migration stays independent; Brian remains on Render.

The user confirmed on 2026-10-18 that Antigravity has not been activated; deployed typed chat still uses Render.

## Activation

1. Deploy this revision. Verify Netlify lists `live-access`, `antigravity-worker` (**background**) and `chat-cleanup` (**hourly scheduled**), alongside `session`. The existing two rate-limit rules must remain valid in post-processing logs.
2. Keep the existing Netlify `GOOGLE_API_KEY`, `SESSION_SECRET`, `INVITATION_CODE` and `VITE_ACCESS_API_URL=same-origin`. No new secret is required. Optional `ANTIGRAVITY_AGENT` defaults to `antigravity-preview-09-2026`; optional `ANTIGRAVITY_MODEL` must match any intentional Render override. Optional `MAX_DAILY_REQUESTS` defaults to `250`; copy any intentionally different Render cap.
3. Set the **non-secret production build variable `VITE_CHAT_API_URL=same-origin`** and redeploy. Until this activation, Antigravity still uses Render. Keep `VITE_API_URL` pointing to Render for Brian.
4. Verify the production checks below. Then set **`CHAT_ENABLED=false` on Render** and restart/redeploy that service to retire its old `/api/chat` and `/api/ui-tool-result` routes. This closes the separate legacy chat allowance; Brian and session validation remain available. Do not disable Render chat before confirming the new path works.

This uses Netlify's built-in Functions and Blobs, with no external database or paid provider added. Background Functions are documented for **credit-based Free/Personal/Pro and Enterprise**; a legacy plan without background support cannot run this path unchanged. Confirm availability before activation; no paid upgrade is authorized. Blobs, polling, workers and scheduled cleanup consume the existing Netlify allowance. No claim of unlimited free usage or zero cold-start latency is made.

## Flow and behavior

- Browser `POST /api/chat` or `/api/ui-tool-result` → authenticated Netlify handler → bounded queued job and usage reservations in Blobs → signed, short-lived invocation of `/.netlify/functions/antigravity-worker`.
- The worker preserves the existing Google Interactions **foreground SSE** request, Antigravity agent/model defaults, system instructions and five validated UI tools. No provider/model fallback or Google background execution is introduced.
- Browser `POST /api/chat-stream` receives incremental SSE text and complete validated tool calls. Each read connection rotates after approximately 20 seconds and resumes from its character offset. Google generation continues in the same background worker, so response rotation creates no new model request. The temporary delivery buffer is sampled every 750 ms; provider text writes are coalesced after the first visible delta. This can add modest delivery latency compared with a direct relay.
- Worker deadline is 180 seconds including queue delay, preserving the previous maximum rather than cutting responses off at the 60-second synchronous Function limit. The existing 10-second connection and 90-second idle limits are also enforced. A timer aborts the upstream request even if the browser closes; a one-second cancellation monitor also works while Google is silent.
- Interrupt sends authenticated `/api/chat-cancel`, aborts browser reads immediately, retains the exact visible partial answer and clears the provider continuation. Tombstones cover cancellation arriving before initial creation; failed/canceled turns rebuild context from visible completed/interrupted messages. Closing the upstream HTTP request does not prove an already-started Google managed-agent task stopped internally.
- Appearance results are bound to the authenticated session, page conversation and parent request. Results must match server-recorded pending calls. Continuations preserve both the interaction and remote environment IDs. The server allows at most four calls in a response and two continuation rounds. Manual/WebMCP tools still use the existing validated browser handlers.
- Existing Python-only local operation and Render rollback remain available. Local tests can run the Netlify handlers through an opt-in HTTP adapter instead.

## State and safeguards

The Blobs store `talker-antigravity-v1` uses **strong reads and atomic conditional writes** (`onlyIfNew` / `onlyIfMatch`). It holds per-page provider pointers/pending calls, job ownership, transient answer delivery buffers and usage counters. No shared-memory lock or warm-instance state is required. A worker claims each job once; duplicate deliveries cannot start another model request. Starting a job or updating state fails closed if storage is unavailable.

Authentication uses the already migrated signed bearer. Conversation and request IDs are validated UUIDs; storage keys bind both to a hash of that bearer. The browser cannot supply Google interaction/environment IDs or forge a worker ticket. Worker signatures use the existing server-only session secret with a separate signing domain. No API key, invitation secret or worker ticket is returned in chat events.

Preserved limits: request body 48,000 bytes, up to 24 messages, 12,000 characters per input message, 30 model requests per session per rolling hour, and the configured daily chat cap (250 by default). New explicit output/event/tool-argument bounds prevent unbounded delivery buffers. Quota reservations count failed starts and tool continuations conservatively. Read rotations and cancellation do not create model requests. Session/hour and daily counters now survive serverless restarts and update atomically; the old Render counter is separate until its chat routes are retired.

The existing 30-per-180-second IP/domain platform rule also covers the new public chat/read/cancel routes; invitation submissions retain their separate rule. Platform enforcement is delayed and is not the source of strict model usage caps. The worker endpoint returns Netlify's normal asynchronous 202, but internally rejects unsigned/expired invocation tickets before reading jobs or calling Google. It has no separate public model-creation API.

Transient job buffers expire logically after 15 minutes (or the session margin, if sooner); queued prompt/history payloads are removed when claimed. Conversation pointers and usage expire with the eight-hour session plus a ten-minute in-flight margin. Daily counter keys expire after eight days. Hourly cleanup removes up to 500 expired entries per run; physical deletion can lag eligibility and backlog. There is no user-visible persisted chat history; a page reload still starts a new conversation. Google retains its own managed-agent interaction state as before.

## Verification

Passed locally:

- `npm test`: 96 deterministic frontend tests, including Netlify read-window renewal, tool continuation, remote Interrupt, exact visible cutoff, error recovery, and unchanged Dialog/Dictation/Live behavior.
- `npm run test:functions`: 27 function/state/worker tests, covering separate instances, CAS limits under contention, session/page binding, forged worker tickets, duplicate invocation, cancellation races/provider silence, enforced deadline, tool validation/replay, storage/provider failures without secret echoes, UTF-8/SSE chunk boundaries and buffer cleanup.
- `npm run test:live:netlify` with explicit `TALKER_ENABLE_ANTIGRAVITY_LIVE=1`: real Google Antigravity via a locally running HTTP adapter, with two conversational color changes and two tool continuations (four model requests). The local server reads `backend/.env`, excludes permanent credentials from the frontend test process and enforces the shared seven-model-requests-per-rolling-minute budget before provider calls. All requests target the local adapter; no deployed Talker API was used. This validates real Google compatibility, not hosted Netlify Blobs or background execution.
- Python mocked backend suite: eight tests, including Brian/session compatibility and retirement of old chat routes.
- Production frontend build, diff whitespace checks, and Netlify's official `zip-it-and-ship-it` function packaging: four bundles; extracted configuration identifies the worker as background, cleanup as hourly scheduled, all seven `live-access` paths and the two existing rate-limit rules. Bundling did not publish anything.

The dependency audit reports one pre-existing high-severity `source-map-js@1.2.1` development dependency issue; the prior lockfile has the same affected version. The new SDK introduced no reported advisory. No unrelated dependency upgrade was included.

Owner production checks after activation (Browser Use unavailable to the agent):

1. In a fresh private window, authenticate, ask a typed question and follow up. `/api/chat`, `/api/chat-stream` and any `/api/ui-tool-result` must use the Netlify hostname. There must be no Render request while using typed chat without Play.
2. Request an appearance change, then refine it; verify the action, answer and multi-turn context. Interrupt a streamed answer and ask another question; retain only the visible partial and recover cleanly.
3. If a response takes over 20 seconds, confirm read requests rotate without duplicated/missing text. Test a page refresh starts fresh context. Verify missing sessions and forged worker requests cannot create provider jobs; check the two rate rules in deploy logs.
4. Recheck Dialog and Dictation. Live still uses Render for Brian speech, so it is not completely Render-independent. Typed chat Play also contacts Render by design.
5. After retiring Render chat, verify Antigravity still works through Netlify and Brian still works through Render. Record observed cold-start timing; no hosted performance claim is made from local tests.

Rollback: re-enable `CHAT_ENABLED=true` on Render, remove `VITE_CHAT_API_URL`, and redeploy Netlify. Keep `VITE_ACCESS_API_URL=same-origin` so verified Dialog/Dictation stay independent. Existing Netlify jobs finish or hit their deadline; temporary state expires through cleanup. No remote/tag/history changes or Vanilla promotion are involved.

This is a documented Talker deployment-specific core exception: App's API selection/event transport and the Python retirement flag may need reconciliation on future Vanilla adoption. The worker, state adapter and deployment docs are additive; Vanilla is untouched.

Official references checked 2026-10-17: [Background Functions and plan availability](https://docs.netlify.com/build/functions/background-functions/), [function limits](https://docs.netlify.com/build/functions/configuration/), [Blobs conditional writes/consistency](https://docs.netlify.com/build/data-and-storage/netlify-blobs/), [Google Antigravity](https://ai.google.dev/gemini-api/docs/antigravity-agent).
