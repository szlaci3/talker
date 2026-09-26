# Talker chat MVP

Typed, single-thread chat proof of concept. Chat history is in-memory and clears on page reload; the backend scopes Antigravity context to the current page conversation. Start locally with the explicit `mock` provider first; its replies are labeled and do not verify Google access. The live provider keeps its key in the backend only.

## Local setup

1. In `frontend/`, run `npm install`, then `npm run dev`.
2. In `backend/`, create and activate a virtual environment, install `requirements.txt`, and copy `.env.example` to `.env`. The server loads that file on startup for local development.
3. In `backend/.env`, set `INVITATION_CODE` to at least 12 characters and `SESSION_SECRET` to a random value of at least 32 characters. Keep `CHAT_PROVIDER=mock` for local UI work. To try your preferred managed agent, set `CHAT_PROVIDER=antigravity` (this is the provider switch, not `GOOGLE_MODEL`), add your API key as `GOOGLE_API_KEY`, and leave `ANTIGRAVITY_AGENT=antigravity-preview-09-2026`. Restart the API after editing `.env`.
4. Run the API with `python server.py`; open the Vite URL and enter the invitation code.

For a deployed backend, configure these values in the hosting provider environment settings; a local `.env` file is not deployed.

Set `VITE_API_URL` before building the frontend when the API is hosted somewhere other than `http://localhost:8080`. Configure the API's `ALLOWED_ORIGINS` to the exact frontend origin(s).

## Tests

Run `npm test` in `frontend/` for deterministic Vitest/React Testing Library UI tests. These tests use controlled response streams and make no model API calls.

For one real Antigravity smoke test, start the local backend with `CHAT_PROVIDER=antigravity` and a valid `GOOGLE_API_KEY` in `backend/.env`, then run `npm run test:live` in `frontend/` with these environment variables set in the same shell:

- `TALKER_ENABLE_ANTIGRAVITY_LIVE=1`
- `TALKER_LIVE_INVITATION_CODE` set to the local invitation code
- `VITE_API_URL=http://127.0.0.1:8080`

The live test refuses non-local API URLs, checks health/provider configuration, and asks Antigravity to change the input background, then refine it with a natural-language follow-up. Each change returns a tool result to Antigravity using a second model request. A shared local rate limiter caps Antigravity requests at 7 per rolling 60 seconds. The Google API key stays in the backend environment and is never read by the frontend test. Live calls count against the configured account's usage.

## Conversational appearance

The assistant can change the theme, text size, or one named chat color (page/header/message/input backgrounds, main/secondary/input text, and accent) from natural-language requests. Color values are validated hex colors; text colors are adjusted for contrast. Changes persist in this browser and can be reset from the Colors control. The assistant cannot generate or execute CSS/JavaScript. The browser registers these same actions with WebMCP when that API is available; otherwise the page shows an availability notice and chat remains usable. Native WebMCP invocation still needs verification in a supported browser/agent.

## Speech output

Completed assistant answers have Play, Pause/Resume, and Stop controls. The frontend warms the authenticated speech service in the background and uses Microsoft Brian (`en-US-BrianMultilingualNeural`) when available. While Render starts or if synthesis fails, playback uses browser Daniel when available, otherwise the browser's default voice. One upcoming segment is prefetched; voice changes happen at a segment boundary. Speech text is sent from the backend to Microsoft's Edge TTS service. Speech output is implemented locally and needs a deployed browser playback check. The live catalogue and a generic sample were verified locally; no browser playback claim is made yet.

## Hosting

`frontend/netlify.toml` configures the static frontend and `render.yaml` describes the Python API. Set secrets in the hosting dashboards, set the deployed Netlify origin in `ALLOWED_ORIGINS`, and set `VITE_API_URL` to the Render API URL at frontend build time. Netlify and Render are deployed; the user reports production chat and cancellation recovery working.

The current entry-attempt, chat caps, speech cache, and speech request caps live in process memory and reset on service restarts. They are not durable quota enforcement. Typed chat, bounded conversational appearance controls, and local speech output are implemented; hands-free speech input and conversation persistence are not.
