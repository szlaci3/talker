# Dialog without Render cold starts

Implemented and user-verified in production 2026-10-17. The user confirmed successful Netlify authentication/token requests and a complete Dialog conversation in a fresh private window with no Render requests. The Render-independent path is verified; numerical before/after timing remains unmeasured. Activation is explicit so deployments preserve existing login until Netlify secrets are ready. The After column below describes the activated migration.

## Audit and request paths

| Trigger | Before | After |
| --- | --- | --- |
| Initial page, no stored session | Static Netlify assets; no backend request | Unchanged |
| Initial page with stored session / successful login | Render `/api/voices` warmup, with retries | No automatic Render request |
| Invitation submission | Render `POST /api/session` | Netlify `POST /api/session` |
| Composer focus | Render `GET /api/session` | Netlify `GET /api/session/check` |
| Dialog start / renewal | Render `POST /api/dialog-token`, then direct Google WebSocket | Netlify token route, same direct Google WebSocket |
| Dictation / Live recognition start / renewal | Render `POST /api/live-token`, then direct Google WebSocket | Netlify token route, same direct Google WebSocket |
| Typed chat / Live answers and appearance continuations | Render `/api/chat`, `/api/ui-tool-result` | Unchanged; requested only on use |
| Play / Live answer speech / explicit Reconnect | Render `/api/voices`, `/api/speech` | Unchanged; Brian warmup begins on playback or explicit Reconnect |

Authentication and token issuance have no fetch, health check, or proxy to Render. The Gemini model, Aoede voice, microphone transport, audio playback, transcripts, appearance tools, interruptions and reconnection logic are preserved. Dialog answer **Play** still synthesizes Brian/browser speech and can wake Render; original Gemini recording replay remains deferred.

## Deployment configuration

Set these in Netlify's environment settings using the existing production values through the owner's secret-management workflow. On Free, the default all-scopes setting includes Functions; if scoped variables are available on your plan, restrict secrets to **Functions**. Do not put secret values in TOML, `VITE_*`, logs, or source control. Vite exposes only `VITE_*` variables; these unprefixed secrets are read only by server-side code.

| Variable | Setting |
| --- | --- |
| `GOOGLE_API_KEY` | Existing Google project key; keep billing disabled |
| `INVITATION_CODE` | Existing invitation code, at least 12 characters |
| `SESSION_SECRET` | **Exactly the existing Render signing secret**, at least 32 characters; otherwise Netlify login works but Render rejects chat/speech |
| `DIALOG_FREE_TIER_CONFIRMED` | `true` only while the existing no-billing confirmation remains valid; `false` disables Dialog |
| `DIALOG_MODEL` | Optional; unchanged default `gemini-2.5-flash-native-audio-preview-12-2025` |

Frontend **build** environment:

- Keep `VITE_API_URL` pointing to the existing Render origin for Antigravity/Brian.
- After the server-side secrets are configured, set **`VITE_ACCESS_API_URL=same-origin`** in Netlify's build environment and rebuild. The built app then calls its own origin for access and Gemini tokens. Until this explicit activation, an unset value retains the existing Render access routes, so the automatic Git push cannot break login while secrets are missing. A URL value overrides access routing for staged/local testing; never point it to Render when verifying this migration.
- Netlify base remains `frontend`, publish remains `dist`; `frontend/netlify.toml` explicitly sets the functions directory to `netlify/functions`. Functions live outside published static assets. Keep Node 22.12+ for native ESM/JSON imports (local checks used Node 24).

Redeploy Netlify after configuring runtime secrets and build settings. Check that `session` and `live-access` deploy and that **both rate-limit rules appear as valid in the deploy post-processing log**. Netlify warns invalid rules do not fail deployment. No new paid infrastructure, database, scheduled keepalive, or external service is introduced. Keep the current Free plan; functions still consume its included compute/request allowance and can encounter their own startup latency or platform limits.

Render keeps its existing credentials, origins, chat/speech limits and deployment settings. The sole Python route addition is a `/api/session/check` alias for local parity. Existing authenticated session and Gemini token routes remain available for local Python-only development and rollback; none is public/unauthenticated. Deploy the alias with normal Render code updates if local clients use that revision; production Netlify access does not depend on that deploy.

## Sessions and safeguards

The audit found sessions were already stateless: base64url of an expiry plus HMAC-SHA256, verified using `SESSION_SECRET`. Netlify now signs/verifies the same eight-hour credential independently. Keeping the existing bearer in per-tab `sessionStorage` avoids a cookie proxy or changing Render's cross-origin streaming/speech transport. This is a deliberate compatibility choice; the credential remains JavaScript-readable and inherits the existing XSS exposure. Permanent Google keys, invitation codes and signing secrets never reach the browser. No session is stored in a serverless instance, and no Render call is required to restore/check one.

Token routes authenticate before calling Google, ignore client configuration overrides, issue a single-use token with 60 seconds to start and a 30-minute expiry, and lock the existing model/configuration with `bidiGenerateContentSetup` and `fieldMask`. Dialog locks voice, both transcripts, instructions and tools; resumption handles remain client-configurable. Provider errors never echo provider bodies or credentials. Changing Google's billing settings cannot be detected/enforced by the confirmation flag; no billable fallback is added.

Netlify Free supports two rules; this change uses exactly two:

- Invitation route: 8 requests per IP/domain per 180 seconds, plus the original 8-per-600-second instance-local guardrail. Trusted IP comes from Netlify context, not a caller forwarding header. Request parsing is bounded to 2 KiB and requires a JSON object/string code. Wrong codes use constant-time comparison.
- Dialog/Dictation token routes and session checks share 30 requests per IP/domain per 180 seconds. There is no three-request-per-minute transcription cap.

Platform counters cover separate function instances, but Netlify documents up to ten seconds of enforcement lag. These are abuse controls, **not strict durable global quotas**. The original 600-second invitation counter still resets per instance; Render chat/daily/speech counters remain process-local. Google enforces its project quotas; keep its billing disabled. No existing durable quota was removed.

## Verification and manual acceptance

Production result (user-reported 2026-10-17): manual feature tests passed. Invitation, Dialog-token and Dictation-token requests used the expected Netlify URLs successfully. Fresh-private-window authentication and a complete Dialog conversation made no requests to Render. Deployed rate-limit enforcement, prolonged renewal and numerical latency were not separately reported; the checklist below remains available for repeat verification.

Automated coverage includes gate rejection, session expiration/tampering, origin/method/body bounds, invitation throttling, constrained token payloads, missing configuration, provider errors without secret echoes, Python session compatibility and authenticated Render endpoints. An App integration test uses the real Dialog, SpeechInput and SpeechOutput controllers with simulated audio/WebSocket responses, makes every Render request fail, and checks login, microphone packets, scheduled output audio, both transcripts, interruption, stop/restart and Dictation with **zero Render requests**. This does not verify real microphones or Google/Netlify services.

Owner verification after configuration/deployment (Browser Use is unavailable in this environment):

1. Leave Render idle long enough to sleep. Avoid its health URL, dashboard wake actions, typed chat, Play and Reconnect. In browser DevTools enable Preserve log and filter Network by the Render hostname; optionally block requests to that hostname to prove independence.
2. Open Talker in a fresh tab. Time from navigation to the first usable Dialog audio response; separately record invitation submit-to-chat and Dialog click-to-listening. Enter the invitation, start Dialog, speak, hear the reply, and check both live transcripts. The Render filter must remain empty.
3. Interrupt Gemini by speaking, check queued speech stops, then stop/restart Dialog. Check a requested appearance change. Repeat with Dictation, preserving an existing draft, and test renewal after ten minutes where practical.
4. Unblock Render. Send a typed question and check Antigravity streaming/cancellation/tools; Play an answer and check Brian plus browser fallback while Render wakes. Also verify Live's existing Antigravity/Brian turns.
5. In a logged-out tab, token requests must return 401; wrong invitation codes must fail. Confirm deployed rate-limit rules in logs and check a bounded invalid-code burst. Do not share authorization headers or ephemeral tokens from DevTools.

Timing record: the **before** cold-start delay is the user's reported 30–60 seconds, not a measurement from this task. A real **after** navigation-to-usable-Dialog measurement is pending; there is no honest numerical speedup to report yet. The automated blocked-Render test verifies removal of the dependency, not production latency. Repeat three cold visits before/after using the same browser/device and report the median, excluding time spent deciding what to type/say.

Rollback: set `VITE_ACCESS_API_URL` to the existing Render URL and rebuild Netlify to use Python access/token endpoints again (restores the cold-start dependency). To restore automatic Brian warmup as well, revert the migration commit through a normal reviewed Git change; do not reset history. Existing Render sessions and provider configuration remain usable.

## Family scope and official references

This is Talker's deployment-specific migration. Vanilla is untouched and has no separate hosted deployment. The small App routing/lazy-warmup edits and Python alias are a documented descendant core exception: future Vanilla adoption may conflict around App initialization and the route list; preserve these deployment choices during the reviewed merge. Netlify tools duplicate the existing Python declarations with an automated parity check, rather than introducing shared packages or changing repository topology.

Rechecked 2026-10-17: [Netlify Functions configuration](https://docs.netlify.com/build/functions/configuration/), [rate limiting and Free-plan rule limits](https://docs.netlify.com/manage/security/secure-access-to-sites/rate-limiting/), [function environment variables](https://docs.netlify.com/build/functions/environment-variables/), [Free plan credit limits](https://docs.netlify.com/manage/accounts-and-billing/billing/billing-for-credit-based-plans/credit-based-pricing-plans/), [Google ephemeral tokens](https://ai.google.dev/gemini-api/docs/live-api/ephemeral-tokens), [Google v1beta discovery wire schema](https://generativelanguage.googleapis.com/$discovery/rest?version=v1beta), [Google model deprecations](https://ai.google.dev/gemini-api/docs/deprecations/). The guide's SDK `liveConnectConstraints` shape differs from the discovery REST schema; retain the existing verified REST fields. Do not change the working preview model as part of this migration. Google currently lists its shutdown on November 17, 2026; replacement remains a separate decision.
