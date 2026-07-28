# Design

- Hono runs as a Cloudflare Pages Advanced Mode worker and reads D1 through the Pages binding.
- React renders the complete HTML document on the server; React Aria owns theme, language, date selection, and copy interactions after hydration.
- D1 remains the only production content source. Local Codex writes validated daily and weekly JSON through deterministic scripts.
- Daily payloads add a structured market overview and optional English translation block. Legacy payloads remain readable.
- `weekly_reports` stores one compact JSON payload per Sunday.
- Runtime scripts remain under `scripts/`; `.agents/skill/maintain-stock-daily` provides concise routing context and references them.
