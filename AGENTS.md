# AGENTS.md

Biblicana is a Node.js Discord bot (discord.js 14, ESM, Node 22) in ~590 servers. **`CLAUDE.md` is
the full guide** and binds every agent. Its "Rules for agents" section is the part that matters
most; the rules below repeat it for review. When the two disagree, `CLAUDE.md` wins.

These hard rules bind agents. Kenneth's own session follows the safety ones too and may run
registration, prune or deploys when he asks (see CLAUDE.md, "Kenneth's own session").

## Hard rules (a PR that breaks one should not be approved)

- **No slash-command registration.** Nothing may run `src/deploy.js`, `pnpm run deploy` or
  `deployg` (in code, scripts, CI or instructions). A deploy replaces the whole command set, and
  `--global --rm` empties the prod bot in every server. Registration is Kenneth's step.
- **No guild prune.** Nothing may run `src/pruneGuildData.js` / `pnpm run prune`, dry run included.
- **No prod data or prod Discord application.** Prod is application `1165716269425758249` and Neon
  endpoint `ep-proud-snowflake-a4xubaxb`. `src/utils/prodGuard.js` keeps those values in code on
  purpose: a PR must not move them into `.env`, weaken the check, or set `BIBLICANA_ALLOW_PROD`.
  An admin script that writes to Discord or the database must call `refuseProdUnlessAllowed`
  before connecting.
- **No logs.** Never read or request bot logs, local or prod: they carry users' AI-chat text, and
  `DEBUG_AICHAT_RAG=1` logs full prompts. A PR must not add logging of message content.
- **No `.env`.** Never read, write or commit `.env*`, and never add secrets to code or fixtures.
- **No second bot process.** Never start the bot with the prod or the dev token. The dev bot runs
  only in ops-platform's `devbot-runner`, in Sola Lab only.
- **No MessageContent intent or developer-portal changes.**

## Checks

On Node 22: `pnpm install --frozen-lockfile`, then `pnpm verify` (lint, then the tests; it fails
if either fails). Run it before every PR. The install also sets up git hooks (lefthook,
`lefthook.yml`): `pre-push` runs `pnpm verify`; there is no `pre-commit` hook. Never skip the
hook. No data files or `.env` are needed: tests use `tests/fixtures/data`, and `*.full.test.js`
skip with a reason when the real files are absent. A skip is expected; a failure is not. Test
titles stay ASCII.

## Worth checking in review

- **`User-facing:` section** in every PR: one to three plain sentences a Discord user would notice,
  verified against the diff, or `User-facing: none`. Silas, the comms agent, may announce nothing
  else, so an inaccurate sentence becomes a public claim.
- **Fixtures stay public-domain.** The repo is public: no NASB, NKJV or AMPC text, and no text from
  modern Fathers, the commentaries or Theographic descriptions, in `tests/fixtures/data`.
- **Data files open only through `src/utils/dataFiles.js`** (read-only; a missing file errors and
  is never created).
- **Errors reach Sentry from the outer catch**, beside `logger.error`, never in a nested
  reply-failure catch (`tests/catchReporting.test.js` enforces this).
- **Paths marked _Kenneth's machine only_** in `CLAUDE.md` do not exist in a clone; their absence
  is not a bug.
