# Talker chat MVP

Typed, single-thread chat proof of concept. Chat history is in-memory and clears on page reload; the backend scopes Antigravity context to the current page conversation. Start locally with the explicit `mock` provider first; its replies are labeled and do not verify Google access. The live provider keeps its key in the backend only.

## Local setup

1. In `frontend/`, run `npm install`, then `npm run dev`.
2. In `backend/`, create and activate a virtual environment, install `requirements.txt`, and copy `.env.example` to `.env`. The server loads that file on startup for local development.
3. In `backend/.env`, set `INVITATION_CODE` to at least 12 characters and `SESSION_SECRET` to a random value of at least 32 characters. Keep `CHAT_PROVIDER=mock` for local UI work. To try your preferred managed agent, set `CHAT_PROVIDER=antigravity` (this is the provider switch, not `GOOGLE_MODEL`), add your API key as `GOOGLE_API_KEY`, and leave `ANTIGRAVITY_AGENT=antigravity-preview-09-2026`. To try the direct Gemini fallback, set `CHAT_PROVIDER=gemini` and confirm the `GOOGLE_MODEL` name and quota in your Google project. Restart the API after editing `.env`.
4. Run the API with `python server.py`; open the Vite URL and enter the invitation code.

For a deployed backend, configure these values in the hosting provider environment settings; a local `.env` file is not deployed.

Set `VITE_API_URL` before building the frontend when the API is hosted somewhere other than `http://localhost:8080`. Configure the API's `ALLOWED_ORIGINS` to the exact frontend origin(s).

## Hosting

`frontend/netlify.toml` configures the static frontend and `render.yaml` describes the Python API. Set secrets in the hosting dashboards, set the deployed Netlify origin in `ALLOWED_ORIGINS`, and set `VITE_API_URL` to the Render API URL at frontend build time. No service has been deployed or live-tested.

The current entry-attempt and chat caps live in process memory. They reset on service restarts and are not public quota enforcement; add durable/platform limits before sharing publicly. This milestone does not implement WebMCP, model-driven UI actions, voice, or conversation persistence.
