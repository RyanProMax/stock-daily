---
name: maintain-stock-daily
description: Maintain the Stock Daily repository, including Hono and React SSR on Cloudflare Pages, D1 report storage, local Codex daily or weekly pipelines, data contracts, tests, and deployment. Use for changes, diagnosis, backfills, scheduling, or architecture questions in this repository.
---

# Maintain Stock Daily

Keep Cloudflare as the SSR and storage layer. Keep collection and Agent analysis on the local Mac.

## Route work

1. Read [references/architecture.md](references/architecture.md) for code ownership or SSR/data changes.
2. Read [references/automation.md](references/automation.md) for daily, weekly, backfill, or launchd work.
3. Preserve D1 payload backward compatibility unless a migration explicitly replaces it.
4. Run `npm test` for code changes. For UI changes, also verify production at 390 px and desktop widths.
5. Deploy with `npm run deploy`; run the matching `daily:verify` or `weekly:verify` after content writes.

Do not move application runtime scripts into this Skill. Reference the tested `scripts/` entry points so launchd, npm, tests, and operators share one implementation.
