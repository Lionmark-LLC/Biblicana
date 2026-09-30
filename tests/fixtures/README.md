# Test fixtures

`data/` here holds small extracts of the bot's gitignored SQLite files (about 1 MB in total, where the
real files are about 700 MB), so `pnpm test` runs in a fresh clone. They are built from the real files
by `buildFixtures.js`, which lists every slice it takes and why:

```
node tests/fixtures/buildFixtures.js            # reads data/, rewrites tests/fixtures/data/
node tests/fixtures/buildFixtures.js --from DIR # reads the real files from DIR
```

The build is reproducible (same input, byte-identical output), so a rebuild with no slice changes
shows no diff. Re-run it when a fixture-backed test needs rows that are not here. Such a test fails;
it never passes silently.

A test file uses the fixtures by importing `../helpers/fixtureData.js` **first**, which points
`BIBLICANADATADIR` (read by `src/utils/dataFiles.js`) at this directory. Tests that need a whole
file are named `*.full.test.js`. They skip, stating the reason, when the real file is absent, and
never create it.

## What each file keeps

| File | Rows kept | Text |
|---|---|---|
| `bible.db` | The verse ranges the tests read, widened by one verse each side, plus the last verse of every chapter (so chapter lengths stay exact), and 2 Sam 21:18-20 from `interlinear` | BSB and KJV only. All other translation columns are NULL |
| `lxx.sqlite` | The traced ranges, widened, and all of `lxx_books` and `lxx_alias` | Verbatim (Brenton, 1851) |
| `bsb_footnotes.sqlite` | Gen 1:1-7 and 2 Sam 21:18-20 | Verbatim (BSB) |
| `difficulties.sqlite` | Every entry referenced in six chapters, every ref of those entries, and three Torrey chapters | Verbatim (Haley 1874, Torrey 1907) |
| `cross-references.sqlite` | Five source verses | Verbatim (TSK) |
| `clean_commentary.db` | Five verses, keys only | Placeholder |
| `extrabiblical_data.sqlite` | Five verses, and all of `father_meta` (names, years, links) | Placeholder |
| `person_places.db` | Names starting peter/simon/saint/the/apostle | Names kept, descriptions placeholder |
| `strongs.db`, `dictionary.sqlite`, `categories.sqlite` | Schema only (opened at import, never queried by tests) | None |

## Why some text is missing

This repository is public. Text is kept only where the source is in the public domain.

- **NASB, NKJV and AMPC** are copyrighted translations and are NULL.
- **The other public-domain translations** are NULL for size alone; the tests read the BSB.
- **Rows the tests only need to exist** keep their keys, and their text is replaced by a
  placeholder:
  - the Fathers collection, which includes modern authors such as C.S. Lewis and a living writer;
  - the commentaries, which include the CC BY-SA Tyndale notes;
  - the Theographic person descriptions (CC BY-SA).

Nothing here is user data.

## Distractors are deliberate

Negative assertions need the rows they rule out. For example, the `LIKE`-escape test checks that
"the Apostle Peter" does not match Theophilus, so Theophilus and Theudas are in `persons` even
though the correct query never returns them. Verse ranges are widened for the same reason: "returns
nothing rather than a neighbour" needs the neighbour present.
