---
name: Branch state for reviews
description: One branch since 2026-09-25: main is ESM, pnpm, Node 22, and is what prod runs; refactor is retired
type: project
---

**Rewritten 2026-10-01.** The old version of this note described a CommonJS `main` deployed to prod and an ESM `refactor` branch. That is obsolete and backwards: `main` was fast-forwarded to `refactor` on 2026-09-25, prod moved to `main` on 2026-09-29, and `refactor` is retired.

Today there is one working branch, `main`: ESM (`"type": "module"`), pnpm (pinned via `packageManager`), Node 22, protected (changes arrive only as merged PRs). CommonJS (`require`, `module.exports`) in `src/` is a bug, not a branch difference. `/dictionary`, `/crossref`, `/topicalindex` and `/commentary` read local SQLite through `src/utils/studyHelper.js`; RapidAPI remains for `/audio`, `/bookinfo`, `/originaltext`, `/parallel`, `/semantics` and `/topic`.

**Why:** a reviewer following the old note would have excused CommonJS as "the main branch convention".

**How to apply:** review against `main` and the repo's `CLAUDE.md` / `AGENTS.md`. Data files open only through `src/utils/dataFiles.js`; footers only through `src/utils/theme.js`.
