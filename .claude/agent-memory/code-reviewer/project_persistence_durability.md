---
name: persistence-durability-model
description: How Biblicana's Redis+Postgres write/read path behaves, and the durability gap it creates for guild settings
metadata:
  type: project
---

`redisPGHandler.js` is a write-through cache with Redis-first reads (6h TTL).

**Corrected 2026-10-01 against the code.** An earlier version said `setValue` wrote Redis BEFORE Postgres, so a failed save left the new value cached for up to 6h. That was fixed: `setValue` now writes Postgres first (through `queryWithWakeRetry`, one retry on connection-level failures) and updates Redis only after the durable write succeeds. A failed save throws, and the `save*` helpers return `false` so the UI says "Could not save". Do not flag the old ordering.

Still true:
- `getValue`: a Redis hit returns immediately (a corrupt entry falls through to Postgres); on a miss it reads Postgres and re-caches, and an absent row is negatively cached. If Postgres is down on a miss, the read throws.
- The config readers (`readAiEnabled`, `readDailyVerseConfig`, `readPassiveMode` and similar) catch that and return a DEFAULT (off/silent), logging only at debug level. An outage therefore makes every guild look like "feature off" rather than erroring, which is the documented "DB down looks healthy" pitfall.

**Why:** the maintainer wants silent failures flagged. The read path trades correctness for availability, by design.

**How to apply:** when reviewing settings persistence, check whether a read failure returns a plausible default that could mask an outage, and whether it is logged loudly enough to notice. The write path is sound. Related: [[branch-state-for-reviews]].
