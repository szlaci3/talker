# Project context

Read [docs/project-brief.md](docs/project-brief.md) before planning or implementation. It is the source of truth for requirements, recommendations, milestones, open questions, and research links. Update it when decisions change; avoid duplicating it here.

Read [docs/implementation-handover.md](docs/implementation-handover.md) for execution order, acceptance checks, and the new-task starter prompt. The user intends GPT-6-astra with high reasoning for planning/review and GPT-6-luna with medium reasoning for implementation/bug fixes in a later task. This records the user's workflow; it does not change the active model or authorize starting implementation now.

- This is a developer-portfolio proof of concept demonstrating WebMCP through a single-thread chat whose own interface can be changed conversationally.
- Current stage: feasibility and planning only. No application has been implemented or deployed.
- Keep scope small and documentation concise. Distinguish user requirements from proposed defaults.
- Keep API credentials server-side. Share validated UI actions between manual controls, chatbot tool calls, and WebMCP. Never execute model-generated JavaScript or arbitrary HTML/CSS.
- Recheck evolving browser APIs, model availability, quotas, and hosting limits before implementation. Do not describe ordinary function calling as a verified WebMCP demonstration.

## User-provided environment instruction

You don't have a working Browser Use feature, because it's not available in Europe. When the user asks you to perform in-browser user actions, answer immediately why you can't.
