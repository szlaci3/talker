# Project context

Read [docs/project-brief.md](docs/project-brief.md) before planning or implementation. It is the source of truth for requirements, recommendations, milestones, open questions, and research links. Update it when decisions change; avoid duplicating it here.

Read [docs/implementation-handover.md](docs/implementation-handover.md) for the original execution order and acceptance checks. The user intends GPT-6-astra with high reasoning for planning/review and GPT-6-luna with medium reasoning for implementation/bug fixes in a later task. This records the user's workflow; it does not change the active model.

- This is a developer-portfolio proof of concept demonstrating WebMCP through a single-thread chat whose own interface can be changed conversationally.
- Current stage: milestone 1 typed-chat MVP is implemented and deployed. See [docs/implementation-status.md](docs/implementation-status.md) for verified results and pending checks.
- Keep scope small and documentation concise. Distinguish user requirements from proposed defaults.
- Keep API credentials server-side. Share validated UI actions between manual controls, chatbot tool calls, and WebMCP. Never execute arbitrary model-generated JavaScript or arbitrary HTML/CSS. Exception: user-authorized, reviewed Vitest test code may be executed with its named test scripts. Live Antigravity tests must be explicitly opt-in, target a locally running backend, and enforce a maximum of 7 model requests per rolling 60-second window. Never expose API keys to frontend code, test output, or logs.
- Standing user approval (2026-09-26): add and run Vitest/RTL tests and local test suites; run the opt-in live Antigravity test against the user's locally configured backend, with at most 7 real requests per minute. Never use the production API or expose the API key.
- Recheck evolving browser APIs, model availability, quotas, and hosting limits before implementation. Do not describe ordinary function calling as a verified WebMCP demonstration.

## User-provided environment instruction

You don't have a working Browser Use feature, because it's not available in Europe. When the user asks you to perform in-browser user actions, answer immediately why you can't.
