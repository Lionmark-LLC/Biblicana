# CLAUDE.md

Guidance for Claude Code sessions working in this repository.

## What this is

**Biblicana** — a Node.js Discord bot for scripture lookups, commentary, cross-references, Bible dictionary, prophecies of Jesus, random verses, and more. Deployed in **~592 Discord servers** (2026-09-25, from the top.gg post at cutover; was 457 in April, 527 in July, 543 in August, 572 on 2026-09-06 — it grows, so re-check `/stats` rather than trusting this number). Live instance runs on DigitalOcean droplet `biblicana-bot-prod-2` (since 2026-09-25) under PM2, currently **v1.6.1 on the `main` branch** (moved from `refactor` on 2026-09-29, same commit).

Repo owner: the `Lionmark-LLC` GitHub org (`Lionmark-LLC/Biblicana`, public) since 2026-09-25; it moved from `BlueBerean/Biblicana`, and the old URLs still redirect for web and git. `BlueBerean` remains the bot's brand GitHub account. Kenneth/`Nazareneism` is also a contributor.

## Rules for agents (read first)

Binding on every Claude session in this repo, and written for ops-platform's builder agent (Stephen: Claude Code in a container, no prod access, output is pull requests). A builder's job ends at a PR against `main`, with a `User-facing:` section (see "Pull requests"); Kenneth reviews and merges it, and Peter deploys after Kenneth approves by email. Nothing below is a judgement call.

- **Never register slash commands.** No `pnpm run deploy`, `deployg`, `node src/deploy.js` in any form. `deploy.js --global --rm` empties the command list of the prod bot in every server. Registration is Kenneth's step.
- **Never run the guild prune** (`src/pruneGuildData.js`, `pnpm run prune`), dry run included: it logs in with a bot token and reads every guild row.
- **Never touch prod data or the prod Discord application.** Prod is application `1165716269425758249` (Biblicana#7650) and Neon endpoint `ep-proud-snowflake-a4xubaxb` (branch `main`). `src/utils/prodGuard.js` refuses both scripts above when `.env` points there; never set `BIBLICANA_ALLOW_PROD`, which only Kenneth uses. No SQL against Neon, no Redis on the droplet, no Discord API calls with a prod credential.
- **Never run a second process with the prod token, or with the dev token.** A bot running in two places answers every event twice. The prod bot runs only on the droplet; the dev bot runs only in ops-platform's `devbot-runner` (see "Testing changes"). Never start one yourself (`node src/index.js`, `pnpm start`).
- **Never read logs**, local or prod, and never ask for them to be pasted. Prod logs carry AI-chat excerpts from real users, and `DEBUG_AICHAT_RAG=1` logs full prompts with message history. Diagnose from code, tests and Sentry's scrubbed issues instead.
- **Never toggle the MessageContent intent** or change any setting in the Discord developer portal. MessageContent is a privileged intent that took about two months of review to get (approved 2026-06-18); passive detection and AI chat depend on it, and switching it off can mean a fresh review.
- **Never read `.env*`, never `ssh`/`scp`, never deploy the website** (`wrangler`, `vercel`). `.claude/settings.json` denies these; treat the denies as a statement of intent, not the only barrier.
- **Postgres config is `PGHOST`/`PGUSER`/`PGPASSWORD`/`PGDATABASE`** (`src/config.js`), not `DATABASE_URL`. Don't install Neon's agent skills (`npx neon init`, `npx skills add neondatabase/...`): they assume `DATABASE_URL` and run `neon env pull`, which rewrites `.env`.
- **Verify with the test suite:** `pnpm install --frozen-lockfile`, `pnpm test`, `pnpm run lint`, on Node 22. It needs no data files: tests read the committed fixtures in `tests/fixtures/data`, and the few that need a whole real file (`*.full.test.js`) skip with a reason. A skip is expected in a container; a failure is not. Test titles stay ASCII. A change the suite cannot exercise says so in the PR, with the manual test-bot steps for Kenneth to run.

## Tech stack

- **Runtime**: **Node.js 22, prod and dev** (prod since the 2026-09-25 migration: v22.23.3 from the NodeSource apt repo; dev v22.23.3 via nvm). `engines` `>=22 <23` in `package.json` is the tracked pin; `.nvmrc` is excluded per machine via `.git/info/exclude`, so set it to 22 locally. `@sentry/node` 11 declares `>=20.19 || >=22.12`: Node 18 is no longer an option anywhere.
- **Discord library**: discord.js 14.26.3 (see the `pnpm-lock.yaml`; `package.json` says `^14.26.3`). Commands take `SlashCommandBuilder` and the other builders from `discord.js`; `@discordjs/builders` is only a transitive dependency (removed as a direct one 2026-09-29, when nothing imported it).
- **State**: ioredis 5.x (local Redis on the same host as the bot) + pg 8.x (Neon serverless Postgres)
- **Bible data**: SQLite — all gitignored.
  - `bible.db` (~131 MB, verse text + interlinear), `strongs.db` (~2.7 MB, Hebrew/Greek lexicon). Both present on prod.
  - Seven additional local SQLite DBs (~566 MB total): `lxx.sqlite` (6.3 MB, Brenton's English Septuagint 1851, 28,690 verses keyed by MASORETIC coordinates — see `src/buildLxx.js` for why the alignment is non-trivial), `extrabiblical_data.sqlite` (100 MB, 334 authors — 285 patristic plus 49 medieval/modern, see the era-labelling note below — 61k entries), `clean_commentary.db` (428 MB, 6 modern commentators incl. Gill/Clarke/Henry/JFB/Keil/Tyndale, 88k verse + 4.5k chapter-intro entries), `person_places.db` (6.3 MB, biblical figures/places w/ coordinates), `dictionary.sqlite` (5 MB, Easton's + Smith's, 8.4k entries), `cross-references.sqlite` (11 MB, Treasury of Scripture Knowledge, 340k refs), `categories.sqlite` (11 MB, 7.4k topical categories, 406k refs). **All present on prod** since the 2026-06-30 v1.5.0 migration.
  - `bsb_footnotes.sqlite` (392 KB, the BSB's 4,817 translator footnotes, keyed like `bible.db`) — **optional**, unlike the rest: absent, `bsbFootnotesWrapper` logs one warning and returns `[]`. Built by `src/buildBsbFootnotes.js` from Kenneth's local `data/new_data/database.db`, which is the only source; `bible.db`'s BSB column has the footnotes stripped.
  - `difficulties.sqlite` (1 MB, **optional** like the footnotes) — two public-domain works on alleged contradictions: **Haley**, *An Examination of the Alleged Discrepancies of the Bible* (1874), ~500 verse-keyed cases, and **Torrey**, *Difficulties and Alleged Errors and Contradictions in the Bible* (1907), 24 essays chunked at paragraph boundaries. Built by `src/buildDifficulties.js` from the archive.org OCR in `~/Development/reference/christian/archive-org/` (`examination/examinationof00hale_*`, `difficulties/difficultiesalle0000torr_*`) — that folder is the ONLY source, so keep it. Read the importer's header before touching it: the OCR has Roman-numeral chapters, damaged book names, and side-by-side quoted columns read straight across, and each has a specific fix. The build refuses to finish unless seven sentinel entries resolve with the right pages.
- **AI model**: `gpt-5.6-luna` (since v1.5.1). GPT-5 family, so the API surface differs from 4o: `max_completion_tokens` not `max_tokens`, `temperature` accepts only the default, and `max_completion_tokens` INCLUDES hidden reasoning tokens — `reasoning_effort: 'none'` is pinned everywhere for that reason. Chat Completions takes flat `reasoning_effort`; the Responses API nests it as `reasoning.effort`.
- **Package manager**: **pnpm 10 everywhere**, pinned by `"packageManager": "pnpm@10.34.5"` in `package.json` (2026-09-29, the version prod's corepack runs), from the tracked `pnpm-lock.yaml` (`pnpm install --frozen-lockfile`). Corepack obeys the pin, and so does a standalone pnpm 10, which fetches and switches to that version by itself, so every machine resolves the lockfile with the same pnpm. Bump it deliberately, and to prod's version: a pin prod lacks makes corepack download pnpm in the middle of a deploy. Prod used npm with an untracked, stale (v1.4.0) `package-lock.json` until the 2026-09-25 migration, so what ran in prod was never exactly what was tested; that is over.
- **Process manager (prod)**: PM2 v5 (`pm2 list`, `pm2 logs index`, `pm2 restart index`)
- **External APIs**: OpenAI only for AI features — `/find`, the `/web` intent check, `/web` search itself, and AI chat. **Tavily was removed in v1.5.1**; `/web` now uses OpenAI's built-in `web_search` tool restricted to a domain allowlist in `src/utils/webSearch.js` (shared with AI chat's `search_web` tool). RapidAPI still used by `/audio`, `/bookinfo`, `/originaltext`, `/parallel`, `/semantics`, `/topic`; `/dictionary`, `/crossref`, `/topicalindex`, `/commentary` are local SQLite.
- **Observability**: **Sentry** (`@sentry/node` + `@sentry/profiling-node` 11, project `lionmark/biblicana`, Team plan) for errors, tracing and profiling, plus a **Sentry Cron Monitor heartbeat** (`biblicana-gateway`). Initialised by `src/instrument.js`, which must be preloaded with `node --import` — that is what `pnpm start` does. See "Sentry and the heartbeat" below.

## Repository layout

```
src/
  instrument.js           # Sentry init, preloaded via `node --import` BEFORE index.js (see
                          #   "Sentry and the heartbeat"); started without it, Sentry is off
  index.js                # Bot entry; wires up Discord client, loads commands/events/buttons
  config.js               # Centralized Postgres config object
  commands/               # Slash commands — one file per command (34: 33 global
                          #   + /testwelcome, which carries `devOnly: true` and is excluded
                          #   from the global registry by deploy.js)
  components/buttons/     # Button interaction handlers
  components/selects/     # Select-menu handlers (string/channel/role pickers), matched by
                          #   customId at interaction time — NOT registered with Discord,
                          #   so a new one ships on a restart alone (no deploy/deployg)
  database/
    redisPGHandler.js     # Combined Redis + Postgres wrapper (both always-available)
    schemas/              # Postgres schema definitions (guild, user)
  events/                 # Discord gateway event handlers (ready, interactionCreate)
  utils/
    bibleHelper.js        # bibleWrapper + strongsWrapper singletons + getBookId / numbersToBook
    studyHelper.js        # Wrappers for the 6 new SQLite sources: fathersWrapper,
                          #   personsWrapper, placesWrapper, dictionaryWrapper, crossRefWrapper,
                          #   categoriesWrapper, commentaryWrapper. Also hosts book-name
                          #   conversion helpers (toTSKSourceBook, toCommentaryBookCodes, etc.)
    logger.js             # Custom logger (prefers console-based output with labels)
    filter.js             # Text filtering / sanitization
    splitString.js        # String chunking for Discord's embed description limit
    axiosInterceptors.js  # HTTP request/response interceptors
    sentryConfig.js       # Sentry options as a pure function of env (SENTRYDSN etc.)
    sentryScrub.js        # beforeSend / beforeBreadcrumb / beforeSendSpan privacy hooks
    errorReporting.js     # reportError(): one-line capture with area/handler/guild tags
    heartbeat.js          # Cron Monitor check-ins, gated on every shard being Ready
  deploy.js               # One-shot script to register slash commands with Discord

data/                     # All files gitignored
  books.json              # Book-name aliases
  bible.db, strongs.db    # Core Bible + lexicon SQLite DBs
  prophecies.json, VOTD.json  # Static datasets
  lxx.sqlite                  # Brenton's English Septuagint (1851), keyed by
                              #   MASORETIC coords; built by src/buildLxx.js
  extrabiblical_data.sqlite   # Church Fathers commentary
  clean_commentary.db         # 6 modern commentators
  person_places.db            # Biblical figures + locations
  dictionary.sqlite           # Easton's + Smith's
  cross-references.sqlite     # TSK cross-references
  categories.sqlite           # Topical index
```

**Commands added by the ESM rewrite** (once `refactor`-only, on `main` since 2026-09-25): `/fathers` (Early Church Fathers on a verse), `/persons` (biblical figure bio), `/places` (location + coordinates), `/profile` (Tyndale encyclopedic articles on people/groups/topics).

## Conventions used in this codebase

### Command file structure

Each slash command is one file in `src/commands/`. The codebase is ESM throughout (`"type": "module"` in `package.json`): `export default { ... }` and `import { ... } from '...'`, never `require`/`module.exports`. The CommonJS tree was the pre-2026-09-25 `main` and is gone from every live branch.

```js
export default {
  data: new SlashCommandBuilder().setName(...).setDescription(...),
  async execute(interaction, database) { ... }
};
```

The second arg to `execute` is the `redisPGHandler` instance, giving commands access to Redis + Postgres (used by commands that persist user preferences like `/setversion` or read them like `/bible`).

### Logging pattern

Log lines are prefixed with a bracketed label identifying the source:
```
[Database] Connected to Redis
[Bible Command] Book lookup for "john"
[Find Command] OpenAI raw response: ...
```
This pattern is load-bearing for grep-based log analysis on prod (e.g., `pm2 logs index --raw | grep '\[RandomVerse Command\]'`). When adding new logging, follow the `[<Area> <Command>]` bracket format.

### Environment variables

All env var names are UPPERCASE, **no underscores**. Examples: `DISCORDTOKEN`, `CLIENTID`, `GUILDID`, `PGHOST`, `OPENAIKEY`. The one exception (`TAVILY_API_KEY`) disappeared with Tavily in v1.5.1, so the convention is now uniform. When adding new vars, match it unless the var follows an external convention.

`TOPGGTOKEN` is **optional** and prod-only: it posts the guild count to top.gg, which does NOT read that number from Discord — a bot that never posts shows no server count at all, which is why Biblicana's listing was blank while it sat in 500+ servers. Absent token is a normal state (the test bot has no listing), so `startTopggPoster` returns null and logs once at debug rather than warning every 30 minutes. Token comes from `top.gg/bot/<BOT_ID>/webhooks`, and top.gg wants it **bare** in the `Authorization` header — a `Bearer` prefix is rejected, and the only symptom is a listing that silently never updates.

`BIBLICANADATADIR` is **test-only**: it moves where `src/utils/dataFiles.js` looks for the SQLite files (default `data/`), and `tests/helpers/fixtureData.js` sets it to the fixtures. Never set it in a real `.env`: prod would open the 1 MB fixtures and answer from a few hundred verses.

The Sentry vars, all optional (read in `src/utils/sentryConfig.js`):

| Var | Default | Notes |
|---|---|---|
| `SENTRYDSN` | unset = Sentry off | **No underscore.** `SENTRY_DSN` is Sentry's documented name and was typed on the first setup; the bot warns at startup if it finds that instead. The SDK also reads `SENTRY_DSN` by itself when init is called without a DSN — keeping ours different means the scrubbed path is the only way Sentry turns on. |
| `SENTRYENVIRONMENT` | from `NODE_ENV` | `production` when `NODE_ENV=production`, else `development`. **Prod must resolve to `production`** or the heartbeat never starts (next section). |
| `SENTRYTRACESRATE` | `1` | Share of commands / AI chats traced. 100% because measured volume is tiny: 5-22 slash commands and 7-40 buttons a day across ~570 servers (prod logs, week to 2026-09-24), ~30k spans a month against 5M included. An earlier default of 0.1 was a guess that would have left prod with one or two traces a day. |
| `SENTRYPROFILERATE` | `1` | Rolled once per process: an on/off switch. Profiling is billed per hour from the Sentry pay-as-you-go budget ($20 cap). |
| `LOGLEVEL` | from `NODE_ENV` | `trace`/`debug`/`info`/`warn`/`error`/`silent`. Default `info` in production, `debug` elsewhere. Exists because `NODE_ENV=production` (needed by Sentry and the heartbeat) would otherwise drop debug-only trails such as the AI role-gate suppression line. Not a Sentry var, listed here because it came with them. |

### Sentry and the heartbeat

**Why `instrument.js` is separate.** Tracing hooks `pg`, `ioredis` and the HTTP client as they load. Under ESM every static import in `index.js` resolves before a line of it runs, so `Sentry.init()` there is too late. `node --import ./src/instrument.js src/index.js` runs it first. **PM2 on prod uses it via `ecosystem.config.cjs`** — started any other way the bot runs with Sentry off, and `index.js` warns if `SENTRYDSN` is set.

**Privacy.** AI chat carries user text across ~570 servers, and `sendDefaultPii: false` knows nothing about Discord. The biggest leak was not an event we build: Sentry's Console integration attaches recent `console.*` calls as breadcrumbs, and `loglevel` writes through console, so every error would have carried recent log lines. `sentryScrub.js` drops console breadcrumbs, redacts text and name keys (`content`, `message`, `prompt`, `username`, `headers`, …) at any depth, and strips outbound query strings. **Discord also puts credentials in URL PATHS** — `/interactions/<id>/<token>/callback` and `/webhooks/<app_id>/<token>/…` — and the first live trace carried them in every HTTP span's name and `url.full`; `redactUrl` removes them, pattern-matched across every string attribute rather than a key list (the key list is what missed `url.path`). An interaction token is good for 15 minutes; a channel webhook's never expires. User and guild IDs are kept. Verified end to end on 2026-09-24: five planted secrets, none stored by Sentry; the same test with the hooks off leaked all five. "Prevent Storing of IP Addresses" is on for the project — Sentry otherwise derives `user.geo` from the sending IP server-side, which no hook can prevent.

**Sentry 11 streams spans** (`traceLifecycle: 'stream'`) and silently ignores `beforeSendTransaction`. Span scrubbing is `beforeSendSpan`, against `{ name, attributes }`. Setting `beforeSendTransaction` looks like protection and does nothing; `tests/sentry.test.js` asserts it is unset.

**Coverage.** Since 2026-09-25 every command, button, select menu and event handler reports from its own catch blocks (93 sites), not only the shared dispatcher: most of them catch, apologise and never rethrow, so the dispatcher never saw those errors. Each interaction runs inside `withReportingScope` (`interactionCreate`), a Sentry scope tagged with guild/area/handler that follows every await and is isolated per interaction, so a `reportError(err, { area, handler })` inside a command inherits the guild. Three placement rules, enforced by `tests/catchReporting.test.js` (a scan, so the 94th catch can't slip through): report in the **outer** catch; never in a catch **nested** inside another (that's "couldn't send the apology", a consequence — reporting it files every failure twice); and put the call **beside the `logger.error`**, not at the top of the catch, so guards like `if (!isExpiredInteractionError(err))` keep expired-menu noise (10008/10062/50027) out of Sentry. Catches that rethrow are exempt. `tests/errorReporting.test.js` runs the real SDK against a recording transport, including a failing `/stats` end to end.

**Still not reported: 33 catches in `src/utils/` and `src/database/`** — `redisPGHandler` (7), `aiConfig` and `passiveConfig` (5 each), `dailyVerseScheduler` (3), renderers and helpers. Deliberately not blanket-edited: the 2026-07-19 Neon outage logged 171,238 errors in a day, and a report per failed query would exhaust the monthly Sentry quota in hours, during the very incident it should show. That layer needs rate-limited reporting (first failure per interval, count the rest) first. Likewise **inline collectors** (pagers, `/commentary`'s switcher — the customIds `interactionCreate` deliberately ignores) run outside any root span, so their Discord calls surface as orphan traces named `POST discord.com` / `PATCH discord.com` rather than under the command that created them.

**The heartbeat** checks in every 5 minutes; two misses in a row open an issue (monitor config is sent as an upsert with each check-in, so it lives in code, and edits made in the Sentry UI are overwritten). Two rules, both silent-failure traps:

- **Production only.** A heartbeat treats silence as the alarm, so a dev bot stopped for the night would page. Consequence: if prod resolves to `development`, the monitor is never created and can never alert — indistinguishable from healthy.
- **"Healthy" means every shard is Ready, not `client.isReady()`.** discord.js 14 sets the manager's status to Ready once and never resets it; a dropped socket moves only `shard.status`. `isReady() && ws.status === Ready` stays true through the exact failure this exists to catch. `tests/heartbeat.test.js` builds that state.

Chosen over Healthchecks.io for one account and one dashboard. The trade is shared fate: during a Sentry outage there are no heartbeat alerts. The plan includes one cron monitor; each further one is $0.78/month.

### Slash command deployment

**Nobody registers commands globally from dev.** `deployg` / `--global` is Kenneth's alone, run on the droplet with `BIBLICANA_ALLOW_PROD=1`. Dev registration is guild-scoped to Sola Lab, the dev bot's only server. Never run `src/deploy.js` with the `--global` flag for development. The `deploy` npm script registers commands to a single guild (instant); `deployg` registers globally (up to an hour propagation across all ~570 servers). The test bot has its own `CLIENTID` and is deployed to a test guild only.

**Prod guard (`src/utils/prodGuard.js`, 2026-09-29).** `src/deploy.js` and `src/pruneGuildData.js` exit 2 before touching Discord or the database when the environment points at prod: `CLIENTID` is the prod application (`1165716269425758249`), `DISCORDTOKEN` decodes to it (a token's first segment is the base64 of the bot's ID, and the prune logs in with the token alone, never reading `CLIENTID`), or `PGHOST` is the prod Neon endpoint `ep-proud-snowflake-a4xubaxb` (the plain, `-pooler` and per-compute hosts all match). `BIBLICANA_ALLOW_PROD=1`, exactly `1`, overrides it, and the script then says it is acting on production. The prod values are constants in code on purpose: nothing in `.env` can redefine what counts as prod. The variable's underscores break the naming convention above because ops-platform named it. `tests/prodGuard.test.js` spawns both real scripts with a prod-shaped env and asserts the refusal comes before any network step. A new admin script that writes to Discord or the database must call `refuseProdUnlessAllowed` before it connects.

**`deploy.js` uploads all or nothing.** A deploy is a `PUT` that replaces the whole set, so a command that fails to load isn't left as it was: leaving it out deletes it from every server. `src/utils/loadCommands.js` reports failures (throws on import, no `data.toJSON`, or `toJSON()` throws) instead of skipping them, and `deploy.js` then exits 1, naming each file, with nothing uploaded. Dev-only commands in global scope are a deliberate skip, not a failure. A failed upload also exits 1. `tests/loadCommands.test.js` makes a real command throw through a module hook (nothing on disk changes) and checks the real script refuses.

### Embed colors / chrome

Embed color is `0x083459` (a dark teal). Embed icon and color values live in `.env` (not hardcoded), so they can be overridden per environment — useful for making local dev visually distinct from prod. **The footer text is derived from `package.json`** (2026-09-30): `Biblicana v<version> by BlueBerean`, read once at startup by `src/utils/theme.js` (`footerText()` / `footerLine()`). `EMBEDFOOTERTEXT`, when set, overrides the whole footer; prod's `.env` still has it until Kenneth removes it, and local dev uses it to mark cards as dev. Every footer goes through `theme.js`; `tests/footerVersion.test.js` scans `src/` so nothing reads the variable directly.

### AI chat access gates

Four independent gates decide whether the **@mention / reply** conversation fires. All of them live on the guild row and are read in `src/events/messageCreate.js`; **none of them touch slash commands** — `/find`, `/web` and the rest work regardless, and are governed by Discord's own Command Permissions (Server Settings → Integrations), which Discord enforces before the interaction ever reaches the bot.

| Gate | Field | Empty means | Helper |
|---|---|---|---|
| Enabled | `aiEnabled` | off (opt-in) | `readAiEnabled` |
| Where | `aiChannels` | all channels | `isAiChannelAllowed` |
| Who may | `aiRequiredRoles` | everyone | `isAiAllowedForMember` |
| Who may not | `aiDeniedRoles` | nobody blocked | `isAiAllowedForMember` |

Evaluation order inside `isAiAllowedForMember` (`src/utils/aiConfig.js`), and the reasoning that fixes it:

1. **Manage Server → always allowed**, bypassing both role lists. An admin must not be able to lock themselves out of the bot they configure, and testing a setting shouldn't require juggling their own roles.
2. **Denylist → blocks**, even when the member also holds a required role. A `No AI` role stays authoritative without the admin unpicking every other assignment.
3. **Required list → must hold at least one.** Empty means no requirement, which is what keeps guilds configured before this existed unaffected.

Two things that look like bugs and aren't:

- **The two lists fail in OPPOSITE directions** on a member whose roles can't be resolved. `memberRoleIds` returns `[]`, so a denylist can't match (allowed) while a required list can't match (blocked). Each is faithful to its own meaning: "block these" can't block someone unidentifiable, "only allow these" can't allow them.
- **`memberRoleIds` reads two shapes.** A cached `GuildMember` exposes `roles.cache` (a `GuildMemberRoleManager`); raw gateway payloads carry a plain array of ID strings. Reading only `.cache` would see zero roles on the raw shape and silently let a denied member through. Snowflakes stay **strings** end to end — they're 18–19 digits, past `Number.MAX_SAFE_INTEGER`, so anything that coerces one to a Number has already corrupted it and no later `String()` can undo it.

Suppression is **silent** by design — a "you are not allowed" reply would be noisier than the feature it enforces and invites argument in-channel. The trail is `logger.debug('[AiChat] Suppressed by role gate — user=… guild=…')`.

Each `/config ai` select handler re-renders the **whole** panel after saving its own setting, so it must read all the settings it did *not* change. Miss one and the database keeps the right value while the panel renders it as unset — which reads to an admin as their setting having just been cleared. This has been got wrong twice; `tests/aiConfig.test.js` now asserts structurally that every handler calling `buildAiConfigView` sources all five.

## Development workflow

### Local setup (first time)

See `/Users/kenneth/Development/lionmark/discord-bot/BIBLICANA_OPS.md` for the full replayable steps. Abbreviated:

1. `nvm use 22` (or `echo 22 > .nvmrc` once, then `nvm use`; `.nvmrc` is excluded from git per machine)
2. `pnpm install` (installs 264 deps; `pnpm.onlyBuiltDependencies: ["sqlite3"]` in package.json allows the native binding to build)
3. Populate `data/` with the runtime SQLite files (all gitignored):
   - `books.json`, `bible.db`, `strongs.db` — scp from prod droplet
   - You also need: `extrabiblical_data.sqlite`, `clean_commentary.db`, `person_places.db`, `dictionary.sqlite`, `cross-references.sqlite`, `categories.sqlite`. These **are on prod** (since v1.5.0), so scp them from the droplet like the others, or source from Kenneth's local `data/new_data/` archive. See `BIBLICANA_OPS.md`.
4. `.env` with test bot credentials + Neon dev-branch credentials (dev branch is isolated from prod data)
5. Run `pnpm run deploy` to register slash commands with the test guild
6. `pnpm start` to start the bot (`node --import ./src/instrument.js src/index.js`; plain `node src/index.js` runs with Sentry off). **Since 2026-09-30, not with the dev token while `devbot-runner` may be running:** ask Kenneth first (see "Testing changes").

### Testing changes

**The suite is self-contained (2026-09-29).** Tests that read Bible or reference data import `tests/helpers/fixtureData.js` first, which sets `BIBLICANADATADIR` to `tests/fixtures/data`: about 1 MB of extracts of the real files, built reproducibly by `tests/fixtures/buildFixtures.js` (`tests/fixtures/README.md` says what each file keeps and why). A new test that needs rows the fixtures lack fails; add the slice to the builder and rebuild where the real files are. Don't hand-edit a fixture. The repo is public, so fixtures keep only public-domain text: never add NASB, NKJV, AMPC, modern Fathers, commentary or Theographic text. A test whose meaning depends on a WHOLE file (keyword search ranks by IDF over the entire Haley/Torrey corpus) goes in a `*.full.test.js` that skips when `data/<file>` is absent and imports nothing then. Keep negative assertions honest: a fixture must contain the rows a test rules out (Theophilus is in `persons` for the `LIKE`-escape test).

All code changes should be tested with the dev bot BEFORE they reach `main`. The prod bot is in ~590 Discord servers; breakage affects real users.

**Live tests go through ops-platform's `devbot-runner` (since 2026-09-30).** It runs the dev bot (Biblicana#6575) on Kenneth's dev token, and Stephen drives it; nobody else starts a dev bot. Two processes on one token both answer every message, so a local run (`node src/index.js`) needs Kenneth to confirm first that the runner is stopped.
- **The dev bot's only server is Sola Lab** (`1494355279515746455`). It left Biblicana2, "Grainger's server" and "Mr Moth Devs" on 2026-09-30, and the runner refuses to start if it is in any other server. Never add it to another one: the daily-verse scheduler, passive detection, reactions and AI chat all act in every server the bot is in.
- **The runner's database is `stephen-dev`**, a schema-only Neon branch with its own login. The older `dev-local` branch holds an April 2026 copy of prod's real users (guild settings, preferences, acknowledgments). It is Kenneth's, not for agents, and not used by the runner.

### Deploying to prod

Prod lives on droplet `biblicana-bot-prod-2` (Ubuntu 24.04, 1 vCPU / 2 GB, NYC3), reached **over the tailnet only** as `biblicana` — no public SSH, no root login, password auth off. The bot runs as user `biblicana` from `/srv/biblicana` under the systemd unit `pm2-biblicana`, started from `ecosystem.config.cjs` (which carries `--import ./src/instrument.js`, timestamps and log paths). The droplet's checkout is on **`main`**.

**Deploys through Peter (ops-platform), installed 2026-09-29.** `main` is protected (a ruleset requires a pull request; no force push, no deletion, no bypass), so a change reaches `main` only when Kenneth merges its PR; then Kenneth asks Peter to deploy that commit and approves by email. Peter's key reaches the droplet only as a forced command: `/usr/local/bin/biblicana-deploy` (root-owned, from `ops-platform/remote/biblicana-deploy.sh`), settings in `/etc/biblicana-deploy.conf`, key line in `~biblicana/.ssh/authorized_keys` restricted to ops' tailnet IP. It has two verbs, `status` and `deploy <40-hex sha>`. `deploy` accepts only commits already on `origin/main`, then does a `git reset --hard` to it, `pnpm install --frozen-lockfile`, a plain `pm2 restart index` (no `--update-env`, so the bot keeps its environment), and a 15 s health check. It never runs `deploy`/`deployg` and never touches `.env`. It **refuses** if the checkout isn't on `main` or has modified tracked files, so don't hand-edit files on prod or switch its branch. The first deploy through this path is pending (ops runs it through the approval flow).

Manual deploy (fallback, same result):
1. Get the change merged to `main` on `Lionmark-LLC/Biblicana` through a PR (the droplet's `origin` still names the old `BlueBerean/Biblicana` URL until someone runs `git remote set-url origin https://github.com/Lionmark-LLC/Biblicana.git` there as `biblicana`; GitHub's redirect keeps `git pull` working meanwhile)
2. `ssh kenneth@biblicana`
3. `sudo -iu biblicana bash -c 'cd /srv/biblicana && git pull --ff-only'`
4. If `pnpm-lock.yaml` changed: `sudo -iu biblicana bash -c 'cd /srv/biblicana && pnpm install --frozen-lockfile'`
5. `sudo -iu biblicana pm2 restart index`
6. `sudo tail -30 /var/log/biblicana/index-out.log` — every line is timestamped; expect `[Sentry] Enabled — environment=production` and `[Heartbeat] Started`. Anything else there means `.env` is wrong.

**Rollback is in-branch:** `sudo -iu biblicana bash -c 'cd /srv/biblicana && git reset --hard <good-commit>'` + restart. Through Peter, a rollback is `deploy <good-commit>` (any commit already on `main`; each successful deploy prints its own rollback sha). Don't switch the droplet's branch as part of a rollback: prod tracks `main`, and the deploy gate refuses any other branch. The old droplet was snapshotted (`biblicana-bot-prod-final-2026-09-25`, DO > Images > Snapshots) and destroyed on 2026-09-25; restoring that snapshot to a new droplet (~10 min) is the only way back to the old host, and should never be needed. If a prod-token bot ever runs in two places, both answer every event.

### Pull requests

`main` is protected: every change is a branch, pushed, with a PR opened by `gh pr create`; Kenneth merges on GitHub. CI (`.github/workflows/ci.yml`) runs lint and the tests on every PR.

**Every PR description has a `User-facing:` section.** It holds one to three plain sentences on what a user of the bot will notice, or `User-facing: none` for internal-only work (tests, docs, refactors, ops). On release, Peter collects them and hands them to Silas, the comms agent, who writes the top.gg post from them, and **they are the only claims Silas may make**, so a wrong sentence here is a wrong public announcement.
- **Verify every sentence against the code in the PR**, not against the plan or the issue. If a behaviour is conditional (admins only, AI chat only, one translation), say so.
- **Write for a Discord user**, in the style of the v1.5.1 announcement (Kenneth's private `BIBLICANA_ANNOUNCEMENTS_v1.5.1.md`, outside the repo): what they can now do or will see, with a concrete example where it helps. No file names, function names, internal jargon or emoji. For example, from that announcement: *"Matthew Henry and Keil & Delitzsch write on whole passages rather than verse by verse. Biblicana was only finding their notes on the first verse of each passage, and returned nothing at all for the rest. That is now fixed."*
- **Say what does not work yet** rather than implying it does. A fix names the symptom users saw ("`/config ai` no longer fails to open when many channels are selected").
- **Commands needing a `deployg` to appear** say so in the PR body (outside `User-facing:`), because the command is not visible until Kenneth registers it.

**The release PR bumps `package.json`'s `version`** (which also updates every footer); it is not a separate step after merge.

### Release checklist (version bumps only)

An ordinary deploy is the six steps above. A **version bump** adds these, and
they are ordered because two of them must happen BEFORE the restart.

1. **`package.json` version, bumped in the release PR itself.** It is what `pm2 list`
   reports and, since 2026-09-30, the version on the footer of every card. The PR's
   `User-facing:` sections since the last release are the release notes (see
   "Pull requests" above).
2. **`EMBEDFOOTERTEXT` in the droplet's `.env`, only while it is still set.** It
   overrides the footer derived from `package.json`, so while it exists it must be
   bumped by hand as before (`/srv/biblicana/.env`, as `biblicana`, after
   `cp .env .env.bak-$(date +%Y%m%d-%H%M%S)`; written `EMBEDFOOTERTEXT = …` with
   spaces). Removing that line ends this step for good: the footer then reads
   `Biblicana v<version> by BlueBerean`, the same wording prod uses today. It
   shipped stale at v1.6.0 and read `v1.5.1` in prod until someone noticed.
3. **New data files, BEFORE the restart.** `data/` is gitignored, so `git pull`
   never brings a new SQLite. `scp` it with NO PIPE — scp can see a pipe fill
   and truncate silently with a clean exit, and a half-copied SQLite has a
   valid header, so early reads succeed and later ones fail hours later in
   prod. Verify with `md5` on both ends, not the exit code.
4. **`deployg` only if a slash command was added, renamed, or had its
   options changed**, and only by Kenneth, on the droplet as `biblicana`:
   `BIBLICANA_ALLOW_PROD=1 pnpm run deployg`. Without the variable the prod
   guard refuses (exit 2; see "Slash command deployment"). Components (buttons, select menus) are matched by
   `customId` at interaction time and need nothing but a restart. Global
   registration takes up to an hour to propagate; it is a `PUT` over the whole
   set, so it cannot duplicate.
5. **Run the tests on the droplet before restarting**, as `biblicana`: `sudo -iu biblicana bash -c 'cd /srv/biblicana && node --test tests/*.test.js 2>&1 | tail -8'`.
   Since 2026-09-29 most tests read the committed fixtures, so this checks the CODE on
   prod's Node and native modules, not prod's data files. Only `*.full.test.js` read
   prod's real files, and they should show as passed there, not skipped. Prod's data is
   checked by step 6's real query.
   (History: prod's old Node 18.13 TAP lexer reported per FILE and died on
   non-ASCII test names; hence the per-subtest count habit and the ASCII rule.)
6. Restart, then verify with a real query against prod's own data — not just a
   clean log. A script that imports a module in isolation does NOT load `.env`
   (only `index.js` does), so anything reading config needs `import
   "dotenv/config"` or it silently reads defaults.

## Known pitfalls

- **Keep `package.json` slim.** The old CommonJS `main` had 190+ direct deps accidentally pinned via `npm install --save`, with `eslint` in prod `dependencies`; `647681e` cut that to the real direct deps plus one devDep, and that is the tree on `main` now. Add a dependency with `pnpm add`, which updates `pnpm-lock.yaml`, and commit the lockfile with it: prod installs `--frozen-lockfile`, so a `package.json` change without its lockfile fails the deploy.
- **Six different book-name conventions coexist across the data sources.** Always sample `SELECT DISTINCT book FROM ...` before writing queries against an unfamiliar DB. The conventions: canonical (`"John"`, from `numbersToBook`), compact-lowercase (`"john"` — Church Fathers DB), compact-lowercase-with-variants (`"psalms"` AND `"psalm"` both exist in `extrabiblical_data.sqlite` — also stray cross-book ranges like `"Ephesians 2:2-Philippians"` in `categories.sqlite`), Roman-numeral source (`"I Samuel"` in TSK `source_book`), Arabic target (`"1 Samuel"` in TSK `target_book`), 3-letter OSIS-like uppercase (`"JHN"`, `"1SA"` in `clean_commentary.db`, with mixed-case alternates like `"Ezek"`, `"Phil"` for four books). Conversion helpers live in `src/utils/studyHelper.js`: `toTSKSourceBook`, `toCommentaryBookCodes`, `toCommentaryBookVariants`, `fromCommentaryBookCode`.
- **Five books have one chapter, and citations omit it.** "Jude 5" means Jude 1:5 — likewise Obadiah, Philemon, 2 John and 3 John. Free text is handled: `parseScriptureRefs` remaps it, and so every consumer of that parser is covered. **Slash commands are not**, because they read `chapter` and `verse` as separate typed options and query directly without ever building a reference string. Any new command taking book/chapter/verse must call `resolveSingleChapterRef` (`src/utils/scriptureRefs.js`) after `bookId` resolves and before querying; ten already do. The rule is driven by impossibility, not preference — in a one-chapter book a number above 1 cannot be a chapter — which is why "Jude 1" alone is deliberately left as a chapter reference. **A range overrides even that**: "Obadiah 1-3" cannot be a chapter range, so a bare 1 before a dash is a verse. Getting that wrong showed the whole book to someone who asked for three verses (`9eadd0c`). The five books and their verse counts are derived from `bible.db` in `tests/singleChapterBooks.test.js`, including a scan over all 66 proving none is missing, so don't hand-edit that list.
- **pnpm is strict about undeclared imports.** A package the code imports must be in `package.json` even when it is already a transitive dependency; npm's flat `node_modules` hid this, pnpm doesn't. `@discordjs/builders` was once a direct dep for that reason; commands now import from `discord.js`, so it was removed. Import it directly again and it must go back in `package.json`.
- **`sqlite3` native build needs explicit approval under pnpm 10.** `package.json` must include `"pnpm": { "onlyBuiltDependencies": ["sqlite3"] }` or install will skip the postinstall script and leave you with a missing `.node` binding.
- **`.DS_Store` files are tracked in the repo** at the root and `src/`. macOS regenerates them constantly, causing noisy diffs. If you modify the repo from a Mac, expect `.DS_Store` to show up as a local modification; don't commit changes to it.
- **Node 22 in both places since 2026-09-25.** A machine coming from 18 must rebuild `sqlite3` against the new ABI (`pnpm rebuild sqlite3`). `@sentry/profiling-node` ships prebuilt binaries for darwin-arm64 and linux-x64-glibc on ABI 127, so nothing compiles; pnpm's "ignored build scripts" warning for `@sentry/node-cpu-profiler` is expected and harmless — its script only compiles when no prebuilt matches.
- **Never pipe `scp` output** (e.g., `| tail -5`) when copying data files from prod — scp can see the pipe fill and truncate the transfer silently with a clean exit code, producing corrupted files. Run scp without any pipe.
- **Postgres auth failures are logged but not fatal** — `redisPGHandler` continues even if the DB connection fails (`[Database ERR] ... Error creating tables: ...`). This means a broken local `.env` can produce a bot that "looks up" but silently fails every DB-dependent command. Check for `[Database ERR]` lines at startup.
- **`GUILDID` drifts, and `pnpm run deploy` silently targets the wrong server.** The deploy script registers to whatever guild `GUILDID` names, so if it points at a server you are not testing in, the deploy "succeeds" and the command still never appears. This has cost time twice: once at v1.6.0 when `/lxx` seemed missing, and again on 2026-09-06 when `GUILDID` was `1167893380341178418` (Biblicana2, which the dev bot has since left) while testing happened in `1494355279515746455` (Sola Lab, now its only server). **Check `GUILDID` against the server you are actually in before deploying**, and remember a guild keeps whatever set it was last given — Sola Lab sat on 33 commands registered before `/lxx` existed, so it was stale rather than empty. Verify with `GET /applications/<CLIENTID>/guilds/<GUILDID>/commands` rather than trusting the deploy's exit code.
- **`/ping` command does not log anything** — it's a pure latency check, no console.log. Don't use it to verify the bot received a command in log-based tests; use `/randomverse` or `/bible` instead.
- **The "Church Fathers" DB is not all Church Fathers.** `extrabiblical_data.sqlite` holds 334 authors: 285 patristic, plus 49 medieval, Reformation-era and modern writers (Aquinas, C.S. Lewis, Tolkien, at least one living author). Anything surfacing these rows must classify by `default_year` — `classifyFather` for model-facing text, `fatherEraBadge` for UI, both in `studyHelper.js`. Presenting a 1963 author as "the early church" is a factual error, and the two helpers are tested to never disagree.
- **Test names must be ASCII.** Prod's Node 18.13 TAP lexer dies on a non-ASCII character in a `test()` description and reports the whole FILE as 0 passed, naming nothing. Local Node 18.20 parses it fine, so it only shows up on the droplet. Em-dashes are fine in comments, assertions and log lines — just not in test titles. Kept after the move to Node 22 (both places, 2026-09-25): it costs nothing.
- **The OLD droplet had 1 vCPU and 952 MB of RAM, against ~700 MB of SQLite** (the current one has 2 GB: ~1.4 GB free for page cache at cutover, against ~390 MB before). SQLite has no buffer pool of its own and leans entirely on the kernel page cache, so when free memory is squeezed every query becomes a real disk read. On 2026-09-05 that put load at 13 with CPU near idle and `ps` hanging for 100+ seconds, while `pm2 list` still reported the bot healthy and `online` — there were no OOM kills, because the bot was starved, not killed. Diagnose with `free -m` (watch `available` and `buff/cache`) and load-vs-CPU divergence, NOT the bot's logs. A 2 GB swapfile and a masked `fwupd` bought the headroom back, and the 2026-09-25 migration to 2 GB is the durable fix. The diagnosis still holds on any size: page cache, not the bot, is what SQLite runs on.
- **Open data files only through `src/utils/dataFiles.js`.** Until 2026-09-29 the wrappers passed `readOnly: true`, which the `sqlite` package ignores (it reads only `mode`), so they opened READ-WRITE with CREATE: a missing file was silently created empty and failed later as "no such table", and a fresh clone running the tests left eight empty databases in `data/`. `openRequired` now opens `OPEN_READONLY` and rejects naming the missing file. It observes its own rejection at import, so one missing file fails its own queries without killing the bot. `openOptional` resolves null for the two optional files. `tests/dataFiles.test.js` proves none of this creates a file, and scans `src/` so nothing else opens SQLite (the offline `src/build*.js` are exempt).
- **The interlinear's English glosses are the KJV's, supplied italic words included**, attached to the nearest original word. In 2 Sam 21:19 "the brother of Goliath" is glossed onto the Hebrew for Goliath alone — there is no H251 ("brother") in the verse. Anything reading `interlinear.data` must treat the Hebrew/Greek word list as the text and the glosses as a KJV rendering of it; `lookup_original` says so on every success path.
- **Haley and Torrey are keyed differently, on purpose.** Haley's references are marked PRIMARY (the pair a case reconciles) or passing; automatic grounding uses primary only, because Haley cites ~2,500 verses in passing and grounding on those would attach an unrelated digression to much of the Old Testament. Torrey is ALL non-primary and reached only through `lookup_difficulty`'s keyword search — an essay citing Deut 20:16 is not about Deut 20:16. A Torrey hit returns its CHAPTER in order (up to 4,500 chars, windowed and marked beyond that), because the chunking is ours and one chunk is an argument without its conclusion.
- **Neon bills compute-time, not queries.** Anything polling on a timer shorter than the ~5-minute autosuspend threshold keeps the endpoint awake permanently, regardless of how few queries it makes. The daily-verse tick did exactly this from 2026-06-30 to 2026-08-01. Cache timer-driven reads in Redis and invalidate on write; see `getDailyVerseGuilds`.

## Branches

- **`main` — the working and deploy branch since 2026-09-29.** Prod's checkout moved from `refactor` to `main` that day at the same commit (`09d1e5e`, no code change), done with `git checkout -B main --track origin/main` rather than checking out the droplet's stale local `main` (`bf20673`) and pulling, which would have put the 2024 tree on disk under the running bot for a moment. Changes reach it only by a merged PR (the branch is protected); the deploy gate deploys only commits on `origin/main`. ESM, 11 real deps, 0 critical Dependabot alerts on its own tree. `/dictionary`, `/crossref`, `/topicalindex` and `/commentary` are local SQLite rather than RapidAPI; `/fathers`, `/persons`, `/places` and `/profile` were added. 34 command files, 33 registered globally (`/testwelcome` is `devOnly`). `/lxx` is the newest and, unlike a component, needed a `deployg`.
- **`refactor` — retired as the deploy branch 2026-09-29.** It was prod's branch from the v1.5.0 migration (2026-06-30) until then; `main` was fast-forwarded to it on 2026-09-25 (`bf20673..2920248`, 119 commits, nothing rewritten), and the two were kept identical until the switch. Pushing to `refactor` (and `git push origin refactor:main`) is no longer part of the flow. The branch still exists on GitHub and as a local branch on the droplet, both at `09d1e5e`; deleting it is Kenneth's call.

### Release history

- `647681e` — slim deps + patch 48+ Dependabot issues
- `6bd3d78` — full ESM migration; 3 new commands; `/dictionary` moved local
- `ef678ad` — `/crossref`, `/topicalindex`, `/commentary` moved local; chapter-level commentary
- **v1.5.0 (2026-06-30)** — first `refactor` deploy to the droplet. Data files uploaded; `main` not deployed since.
- **v1.5.1 (2026-08-03)** — reliability + cost batch: ack-before-I/O across 16 handlers, `pg.Pool` bounds (and a missing `pool.on('error')` listener that could crash the process), Redis negative caching, a single-query daily-verse tick with its guild list cached to stop the 5-minute tick waking Neon, GPT-5.6-Luna with prompt caching, Tavily replaced by OpenAI `web_search` on a domain allowlist, a Sources button on AI answers, era labelling in `/fathers`, and passage-slice anchoring so a passage-grouped commentator answers the verse actually asked about. `followups.md` (gitignored, local-only) has the item-by-item record.
- **post-v1.5.1, deployed 2026-08-11** (shipped ahead of the version bump; folded into v1.6.0 below) — AI chat role gating in `/config ai`: a **blocked-roles** denylist (`228791d`, so a server can hand out a `No AI` role) and a **required-roles** allowlist (`b7c44c2`, so AI chat can be kept to a study group or supporter tier), with blocked overruling required and Manage Server bypassing both. See "AI chat access gates" above. Both are select-menu components, so they needed no `deployg`.
- **v1.6.0 (2026-08-14)** — the Septuagint, AI role gating, and a verse pager. `/lxx` plus a `lookup_lxx` tool over **Brenton's English Septuagint** (`data/lxx.sqlite`, 28,690 verses, seventh SQLite, built by `src/buildLxx.js`); AI-chat **required-roles** and **blocked-roles** gating in `/config ai`; a **paginated passive layout** with owner-locked paging and a jump menu, plus a passive **channel allowlist**; AI answers expand their own citations into a verse card. Accuracy: the **Isaiah/1 Samuel parser collision** (`Isa` read as Roman `I` + `Sa`), continuation lists sharing one book name, replies truncating mid-word at the output ceiling, chapter-only references rendering no text. Announcement copy in `docs/announcements/v1.6.0.md` (gitignored, local-only).
- **v1.6.1 (2026-09-06)** — a day of accuracy and dead-end fixes. Eight functional commits plus docs, no `deployg` (nothing changed a command's option definitions).

  **One-chapter books.** `13dec7f`: "Jude 5" means Jude 1:5, not chapter 5 of a book with one chapter, and it resolved to nothing everywhere — passive detection posted no card, and the AI's tools replied "that's a chapter, not a verse, try Jude 5:1", advice that cannot work. Obadiah, Philemon, 2 John and 3 John failed identically. Fixed in `parseScriptureRefs` plus a separate `resolveSingleChapterRef` for the **ten** slash commands, which read `chapter` and `verse` as typed options and never build a reference string. `9eadd0c` then fixed a regression it introduced: "Obadiah 1-3" showed the whole book, because the bare-1 carve-out sat in front of the range lookahead.

  **Truncation with no way out.** The bot had grown **four independent verse renderers**, so a fix in one never reached the others — the root cause behind most of this day. `19f4d6e`: the autopost card's budget was a flat 450 per card, sized for three cards and charged to every post though 70% carry one reference; 1182 of 1189 chapters exceed it, so "Romans 8" showed ~15% of itself. Added a **Read full** reader that pages *within* one reference, which nothing did — `computePageGroups` groups whole references and never splits one. `e311823`: `/bible` said "Truncated — try a smaller range" and attached **no buttons at all** to a truncated range, and it is the terminus of every Open button in `/find`, `/topicalindex`, `/topic` and `/propheciesofjesus`. `bbe3184`: the 📖 reaction was the last renderer, with three faults — chapter references returned no text at all, its own copy of the flat 450, and only the FIRST of several references rendered. `/lxx` was the last dead end — a 1800-char ceiling **and** a hard 20-verse cap, against 765 chapters longer than 20 verses — closed by giving `buildPassagePages` an injectable fetcher so the Septuagint reuses the same reader instead of becoming a fifth one. `/lxx Psalms 119` now pages all 176 verses, and Septuagint-only books page by their own code.

  **`/config ai` was rejected outright by Discord** (`e311823`) with `50035 COMPONENT_DISPLAYABLE_TEXT_SIZE_EXCEEDED`: the panel renders every selected channel and role as a mention inside its own prose, so it grew with configuration — 3748 chars empty against a 4000 ceiling, over the line at ~10 channels. The panel an admin needs to UNDO the selection was the one that would not open. Mention lists are now capped and `tests/configPanels.test.js` pins both panels under 4000 at MAXIMUM configuration, since an empty panel passing says nothing.

  **ESLint had been checking nothing** (`7031d18`) since the ESM migration in `6bd3d78`: `.eslintrc.json` never set `sourceType: "module"`, so all 110 files failed to **parse** and no rule ever ran, while `pnpm run lint` looked like it worked. Restoring it surfaced 14 minor findings — and caught a real `no-undef` in that same day's work within the hour.

  **Resilience** (`44d3984`): one retry on connection-level query failures, at the primitive rather than the ~13 `save*` helpers, because a cold Neon endpoint losing a WRITE is silent data loss dressed as "could not save". Plus gateway lifecycle logging — nothing logged shard disconnect/resume, which made a whole class of "did not respond" undiagnosable, since a dropped interaction never reaches the bot to be logged.
- **post-v1.6.1, deployed 2026-09-16** — AI-chat honesty, under pressure and under a word limit. Four prompt guards (`9392ec5`, cache key **v6 → v10**), each added after a real failure in a live server: a **length cap is a preference, not a gag** ("one word" was extracting bare assertions); **the cap does not survive a loaded premise** — asked "Who is Peter according to the Church Christ founded? (One word)" the bot answered "Pope", then after a first fix answered "Apostle", which is *true and still dishonest* because it let the premise stand; **do not rank Christian traditions** (a verdict on a tradition reads as a verdict on the reader, across ~580 mixed servers — refuse the label, never the substance, with an explicit carve-out in rule 9 which lists "better"); and **reasons change an answer, displeasure does not** — told "holy bias" with no argument, the bot had replied "Fair correction" and reversed outright. The v9 attempt failed on PLACEMENT, which is the transferable lesson: the rule was correct but filed as prose under an identity heading, eighty lines below the self-declared "SINGLE MOST IMPORTANT SECTION" whose rule 1 is "TIGHT". The model consulted the section governing length and complied with it. v10 moves the exception INSIDE rule 1 and adds worked examples — **put a guard in the rule it qualifies, not in a new block**.
- **post-v1.6.1, deployed 2026-09-17** — the prompt holds a position across a long argument (`886b662`, cache key **v10 → v12**). Pressed over eight turns on Matthew 16:27-28 and 24:34 — the "some standing here will not taste death" and "this generation" objections — the bot offered **three different fulfilments in three messages** (Transfiguration, then resurrection/Pentecost, then AD 70) and ended by telling the challenger that the apostles' timetable was mistaken and that the skeptical reading was stronger. The user watching it said "bro jumped between 3 explanations". It had contradicted CORE DOCTRINE's "authority and inspiration of Scripture" without noticing.

  **The cause was ROUTING, not wording** — and that is the transferable lesson, a sibling to v9's placement lesson rather than a repeat of it. `SECONDARY ISSUES` lists **"eschatology timing"** and says present the range humbly, take no side. The model consulted the section governing the TOPIC and obeyed it. But "is Matthew 24 a failed prophecy" is not a timing question; preterist vs. futurist is. It asks whether Scripture holds, which is CORE DOCTRINE four lines above and never got consulted. **The model obeys the section that governs the topic, not the one that governs the stakes** — so a guard must sit where the question's SHAPE will route it. Five of the six changes are appended to rules that already existed; only `HOLD ONE POSITION, OR SAY WHAT CHANGED IT` is new, and it is placed last inside APOLOGETICS, whose "steelman first, then respond with the historic Christian answer" was the rule actually broken.

  Two further things worth keeping. **A length or engagement rule can invert under adversarial conditions**: rule 4's mandatory hook had the bot close eight consecutive messages by asking which argument to try next, which is warm pastorally and concedes the floor in a debate — it may now restate instead. And **the two-strengths clause** (v11 → v12): when a reading must be picked to defend the text, hold the READING loosely and the RELIABILITY tightly, naming where a rival Christian reading answers the objection too. v11 had staked Scripture's trustworthiness on AD 70 alone, which both hands a skeptic the win if he dents that scheme and tells a futurist reader — GotQuestions' position, and a large share of the ~580 servers — that their tradition was the concession. An objection that fails under several Christian readings has to beat all of them.

  Also: `search_web` scoped to a **named classic objection whose grounding came back off-target**. Both runs received the same Chrysostom passage on Matthew 16:27, which is about the worth of the soul and says nothing about timing; v10 argued from its silence ("he does not treat the saying as a failed timetable"), v12 says it "cannot settle the passage" and searches instead. Worth noting against the instinct to make apologetics always search: the search returned **the weakest available answer** near the top — GotQuestions offers only the Transfiguration reading for Matt 16:28 and never engages the angels-and-recompense objection — and the bot was right to discard it. Search supplied breadth, not authority; v10 already had the Isaiah 13 parallel in its own citations and folded anyway.

  Verified on the dev bot against the real transcript, plus a doubting-Christian case ("Yes, it can feel convenient" and a pastoral redirect, no debate posture) and a millennial-scheme control that still refuses to crown a view. What did NOT improve: the opening turn still leads with the Transfiguration, the weakest of the three readings, costing a turn before it commits.

  Also `459b90c`: **a lookup that found nothing is not a source.** "Who is Peter" honestly reported no dataset entry while the Sources panel listed one — two bugs. The person search matched a PREFIX of `Peter_Mat.4.18`, so the fuller and more precise the name the model supplied, the more certainly it failed; now tiered, returning `{results, matchType}` with 'fuzzy' meaning candidates. A pre-existing **`LIKE` wildcard bug** surfaced while testing (`_` is a single-char wildcard, so `the_%` matched THEophilus). And `toolCalls.push` ran unconditionally, so *every* tool recorded its misses as provenance — now gated, with a structural test scanning the file to enforce the "failures begin Error/No" convention. `baad3ad`: **vatican.va** added to the web allowlist — the magisterium itself rather than catholic.com, which explains Catholic teaching without issuing it.
- **post-v1.6.1, deployed 2026-09-24** — alleged contradictions (`90bf450`, `7c8f5ea`, `4fe8de3`, cache key **v12 → v16**). Asked "who killed Goliath" and then pressed on 2 Sam 21:19 — the Septuagint agrees with the Hebrew, and "your translation tampered with the text" — the bot ended by accepting that the BSB was "dishonest" and that "the contradiction is real at the textual level". The person pressing it called it "submissive".

  **The transferable lesson: every time a fact was missing, a firmer prompt produced a more confident wrong answer.** Four prompt revisions each moved the "tampering" turn — v13 conceded, v14 **invented a Masoretic "et ahi"** to defend the BSB, v15 **invented a missing footnote** to condemn it — and only v16, with the BSB's own footnote ("Hebrew does not include *the brother of*") finally in the grounding, answered it with a fact. The prompt decides how facts are used; it cannot supply them. Before tightening a guard to make the bot more confident, check that the fact confidence should rest on is actually in its context.

  Two plumbing gaps did more than any prompt change. **Grounding was per message** (`ragSourceText`): pushback rarely repeats its reference, so the turn under most pressure got `rag=none` and lost Clarke's note, which held the whole answer — now carried from the last user turn that cites a verse, marked `(carried)` in the log. And **the interlinear's glosses lie** (see Known pitfalls) — the KJV's supplied words sit on the Hebrew word for Goliath. BSB footnotes arrive as an optional eighth data file (see Tech stack), and surfaced unprompted on Luke 2:2 as well.

  Prompt side: ALLEGED CONTRADICTIONS answers with the MECHANISM, not the verdict, and treats **a scribal error as the orthodox answer rather than a concession**; **a true fact is not automatically a defeater** — v10's own "update on a fact you had wrong" guard had licensed the Septuagint concession; the ~800-char exception went **inside rule 1** (Clarke's full mechanism had been compressed to "likely scribal confusion" at 437 chars, dead centre of TIGHT — the v10 placement lesson again); grounding rule 2b forbids **shrinking** a source's argument, where the rules had only forbidden inflating one; and **grant a true fact inside the rebuttal**, never as the opener or with a closing "does that address your concern?" — a correct answer framed by concessions reads as a lost argument.

  Verified on the dev bot: Goliath passes all four turns (1.3 run once — watch it); Judas generalises with no mention in the prompt; Quirinius admits the debate and invents nothing. Archer's *Encyclopedia of Bible Difficulties* was considered as a RAG source and set aside pending permission from Zondervan; Haley (1874) and Torrey (1907) are the public-domain alternatives.

  Also `d46dfc2`: **a reference must exist before it becomes a card.** `parseScriptureRefs` validates book NAMES only, so "Romans 17:1" parsed and the 📖 reaction posted a card with no scripture and five study buttons, which a prod user pressed. Only `/find` checked existence; the reaction, passive autopost, the pager and AI answer expansion did not — and "Acts 29", a church network's name, drew unsolicited cards. `src/utils/versification.js` loads every chapter's last verse once (1,189 rows), so the check is synchronous and ack-safe, and **fails open** if it cannot load. Unsolicited paths drop silently; the reaction replies "Romans has 16 chapters". **Any new path that renders a parsed reference must call `getVersification().filter()`** — `tests/versification.test.js` scans the entry points for it. Loose ends (Psalm 151 unreachable from `/lxx` and `lookup_lxx`, the three right-click menus unchecked, message wording) are in `followups.md`.

  Later the same day: **Haley and Torrey** (cache key **v16 → v20**). Archer's *Encyclopedia of Bible Difficulties* was the first choice and is set aside pending permission from Zondervan (it is in copyright); these two public-domain works cover the same ground from 1874 and 1907. Haley arrives in grounding when a verse is a primary text of one of his cases; both are searchable through a new `lookup_difficulty` tool, which the routing now calls FIRST for classic objections — **moral objections included** (the Canaanites, Jephthah, the imprecatory psalms), which the model had not recognised as the same kind of question. `search_web` comes after it. The Sources panel gains a "Bible difficulties" section labelled by book.

  Three lessons, each found by a failing test rather than foreseen. **A verse can sit in two cases** — 2 Kings 8:26 is both "Ahaziah's age, 22 or 42" and "his grandfather, Omri or Ahab" — and nothing about the verse can choose; `pickDifficulty` chooses by the user's own words, converting Haley's "twenty-two" to "22". **Returning one chunk of an essay invites the model to finish it**: given the first third of Torrey on Cain, cut just before "Cain doubtless had his wife before going to the Land of Nod", it inverted the order of Genesis 4 to supply the conclusion — hence chapters in order, and truncation MARKED so the model says what it has not seen (it now does: "I can't responsibly summarize his argument about Paul beyond that point"). And **a real verse attached to the wrong source** is the most durable kind of false citation: the bot credited Torrey with Deut 9:4-5, Gen 15:16, Deut 7:1-4, Judg 2:2-3 and Gen 12:3, all relevant, none cited by him — it survives a casual check and fails a careful one. Grounding rule 3 now covers verse references as well as claims; the fix MOVED the model's supporting verses into its own voice rather than deleting them.

  A query mixing a reference into a topic ("Jephthah's daughter sacrifice Judges 11" — exactly how a model writes a tool call) used to drop the topic words and match two unrelated Haley entries that cite Judges 11. Both are now searched, and failing an overlap the words win. The tests use the verbatim failing queries from the logs, which is how the second half of that bug was found.
- **2026-09-24, deployed 2026-09-25 with the migration** — Sentry, a gateway heartbeat, and Node 22, from the ops-platform handoff (`../ops-platform/handoffs/biblicana.md`, section B). See "Sentry and the heartbeat" above and `project_log.md`. Three things the handoff had wrong, each caught against the real library rather than its docs: its health check (`isReady()` plus `ws.status`) latches Ready and would never have fired; Sentry 11 ignores `beforeSendTransaction`; and most errors never reach a shared catch at all. Node 22 is a hard prerequisite for deploying it, not an ordering preference. 352 tests.
- **2026-09-25 — prod moved to a new droplet** (`biblicana-bot-prod-2`, Ubuntu 24.04, 2 GB; the old one was snapshotted as `biblicana-bot-prod-final-2026-09-25` and destroyed the same night, and the long-orphaned `biblicana-bot-legacy-abandoned` turned out to be gone already), following `docs/ops/host-migration-2026-09.md`. The old one ran Ubuntu 23.10 (out of support since July 2024) with root PM2, no boot startup, untimestamped logs, and root password SSH under ~8,500 guesses a day (passwords turned off first, same night). Data copied from prod and checksum-identical on both ends (14 files); 358/358 tests on the new host against it; smoke-tested with the test bot under Sentry `staging`; **a reboot brought the bot back unattended in 29 s**. Cutover 04:35:43 -> 04:35:57 UTC, **~14 s down**: prod logged `environment=production`, the `biblicana-gateway` cron monitor was created by its first check-in the same second, and top.gg received `server_count=592`. Neon `ops_reader` role applied the same night (NOLOGIN until lionmark-ops exists).


## References

- **BIBLICANA_OPS.md** (at `../BIBLICANA_OPS.md`, outside this repo) — private ops doc covering DigitalOcean droplets, Neon setup, credentials, SSH access, and the session history of how the environment was bootstrapped. Start here if you need to recover infrastructure state.
- **`project_log.md`** — reverse-chronological log of changes, incidents and decisions, started 2026-09-24 and seeded back to v1.4.0. Add an entry after significant work.
- **Sentry**: https://lionmark.sentry.io — project `biblicana` (issues, traces, the `biblicana-gateway` cron monitor)
- **Upstream**: https://github.com/Lionmark-LLC/Biblicana
- **Discord dev portal**: https://discord.com/developers/applications (both prod and test bot apps owned by Kenneth)
- **Neon console**: https://console.neon.tech — `Biblicana` project holds the live Postgres; `dev-local` branch is the dev sandbox
