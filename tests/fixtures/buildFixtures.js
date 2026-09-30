// Builds tests/fixtures/data/*.sqlite: small committed extracts of the
// gitignored data files, so the test suite runs in a fresh clone.
//
//   node tests/fixtures/buildFixtures.js [--from data]
//
// Needs the REAL files (Kenneth's Mac or the droplet) and rewrites every
// fixture from scratch. Re-run it when a fixture-backed test starts asking for
// rows that are not here; the test will fail, not silently pass.
//
// Each file keeps the real schema and indexes (copied from sqlite_master), and
// only the rows listed below. The slices were derived by tracing every query
// the fixture-backed tests make against the real files (2026-09-29), then
// WIDENED so negative assertions keep their teeth: a test that "returns nothing
// rather than a neighbour" needs the neighbour present, and the LIKE-escape test
// needs "Theophilus" present for "the_%" to wrongly match. So verse ranges are
// widened by one verse each side, and name searches take the unescaped prefix.
//
// Copyright: the repo is public. Text is kept verbatim only from public-domain
// sources (BSB, KJV, Brenton's LXX, Haley 1874, Torrey 1907, TSK). NASB, NKJV
// and AMPC are copyrighted and are NULL here; the other public-domain
// translations are NULL too, purely for size (tests read BSB). Rows the tests
// need only to EXIST (Fathers, which include modern authors; the commentaries,
// which include CC BY-SA Tyndale notes; Theographic person descriptions, CC
// BY-SA) keep their keys and have their text replaced by PLACEHOLDER. See
// tests/fixtures/README.md.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sqlite3 from 'sqlite3';
import { open } from 'sqlite';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '../..');
const fromArg = process.argv.indexOf('--from');
const SRC = path.resolve(ROOT, fromArg > 0 ? process.argv[fromArg + 1] : 'data');
const OUT = path.join(ROOT, 'tests/fixtures/data');
const PLACEHOLDER = 'FIXTURE: text omitted, see tests/fixtures/README.md';

// --- slices ------------------------------------------------------------------

// [bookId, chapter, fromVerse, toVerse] read from bible.db's `english`.
const BIBLE_RANGES = [
    [19, 23, 1, 200], [19, 119, 1, 200], [45, 8, 1, 200], [46, 15, 1, 58], // whole chapters (pager, reader)
    [43, 11, 35, 35], [43, 3, 16, 16], [20, 3, 7, 7], [43, 1, 1, 1], [19, 1, 1, 1], // reaction expansion
    [44, 3, 15, 15], [44, 3, 26, 26], [44, 4, 33, 33], [45, 8, 28, 28], [43, 999, 1, 1], // pager
    // One-chapter books: the end of chapter 1 and the non-existent chapter 2.
    [31, 1, 1, 1], [31, 1, 21, 22], [57, 1, 1, 1], [57, 1, 25, 26], [63, 1, 1, 1], [63, 1, 13, 14],
    [64, 1, 1, 1], [64, 1, 14, 15], [65, 1, 1, 1], [65, 1, 25, 26],
    // singleChapterBooks probes chapter 2 verse 1 of every book.
    ...Array.from({ length: 66 }, (_, i) => [i + 1, 2, 1, 1]),
];

const LXX_MT_RANGES = [ // [book_id, chapter, from, to] in Masoretic numbering
    [19, 51, 10, 12], [19, 23, 1, 1], [19, 22, 1, 1], [19, 1, 1, 1], [24, 31, 31, 31], [24, 46, 1, 2],
    [1, 1, 1, 1], [27, 7, 13, 13], [23, 7, 14, 14], [43, 3, 16, 16], [2, 38, 1, 3], [19, 151, 1, 1],
    [19, 119, 1, 200], [23, 53, 1, 200],
];
const LXX_NATIVE_RANGES = [['SIR', 2, 1, 1], ['PSA', 151, 1, 1], ['TOB', 1, 1, 200]];

const BSB_NOTE_RANGES = [[10, 21, 19, 19], [1, 1, 1, 6]];

// reactionExpansion: verses whose study buttons depend on these sources.
const XREF_VERSES = [['John', 11, 35], ['John', 3, 16], ['Proverbs', 3, 7], ['John', 1, 1], ['Psalms', 1, 1]];
const COMMENTARY_VERSES = [['JHN', 11, 35], ['JHN', 3, 16], ['PRO', 3, 7], ['JHN', 1, 1], ['PSA', 1, 1]];
const FATHERS_VERSES = [[['john'], 11000035], [['john'], 3000016], [['proverbs'], 3000007], [['john'], 1000001], [['psalms', 'psalm'], 1000001]];

// studyHelper's tiered person search; unescaped prefixes on purpose (see top).
const PERSON_PREFIXES = ['peter', 'simon', 'saint', 'the', 'apostle'];

// difficulties: chapters looked up by verse, and Torrey chapters read whole.
const DIFFICULTY_CHAPTERS = [[10, 21], [12, 8], [40, 27], [44, 1], [12, 15], [7, 11]];
const TORREY_SECTIONS = [
    'The Sacrifice of Jephthah’s Daughter',
    'Were Jesus and Paul Mistaken as to the Time of Our Lord’s Return?',
    'Where Did Cain Get His Wife?',
];

// --- helpers -----------------------------------------------------------------

const q = s => `'${String(s).replace(/'/g, "''")}'`;
const or = parts => parts.map(p => `(${p})`).join(' OR ');
const widened = ([a, c, from, to], cols) =>
    `${cols[0]} = ${a} AND ${cols[1]} = ${c} AND ${cols[2]} BETWEEN ${from - 1} AND ${to + 1}`;

const bibleWhere = or([
    ...BIBLE_RANGES.map(r => widened(r, ['CAST(bookID AS INTEGER)', 'chapter', 'verse'])),
    // The last verse of every chapter: versification.js derives chapter
    // lengths from MAX(verse) per chapter, which then stays exact.
    `id IN (SELECT e.id FROM src.english e JOIN (SELECT bookID b, chapter c, MAX(verse) m
            FROM src.english GROUP BY bookID, chapter) x ON e.bookID = x.b AND e.chapter = x.c AND e.verse = x.m)`,
]);

const FIXTURES = {
    'bible.db': {
        english: bibleWhere,
        interlinear: 'bookid = 10 AND chapter = 21 AND verse BETWEEN 18 AND 20',
        after: [`UPDATE english SET ${['ASV', 'AKJV', 'CPDV', 'DBT', 'DRB', 'ERV', 'JPSWEY', 'NHEB', 'SLT', 'WBT', 'WEB', 'YLT', 'AMPC', 'NASB', 'NKJV']
            .map(c => `${c} = NULL`).join(', ')}`],
    },
    'strongs.db': {},
    'dictionary.sqlite': {},
    'categories.sqlite': {},
    'lxx.sqlite': {
        lxx: or([
            ...LXX_MT_RANGES.map(r => widened(r, ['book_id', 'chapter', 'verse'])),
            ...LXX_NATIVE_RANGES.map(([b, c, f, t]) => `lxx_book = ${q(b)} AND lxx_chapter = ${c} AND lxx_verse BETWEEN ${f - 1} AND ${t + 1}`),
        ]),
        lxx_books: '1', lxx_alias: '1',
    },
    'bsb_footnotes.sqlite': {
        bsb_footnotes: or(BSB_NOTE_RANGES.map(r => widened(r, ['book_id', 'chapter', 'verse']))),
    },
    'cross-references.sqlite': {
        cross_reference_sources: '1',
        cross_references: or(XREF_VERSES.map(([b, c, v]) => `source_book = ${q(b)} AND source_chapter = ${c} AND source_verse = ${v}`)),
    },
    'clean_commentary.db': {
        Commentary: '1',
        CommentaryChapterVerse: or(COMMENTARY_VERSES.map(([b, c, v]) => `bookId = ${q(b)} AND chapterNumber = ${c} AND number = ${v}`)),
        after: [`UPDATE CommentaryChapterVerse SET text = ${q(PLACEHOLDER)}, contentJson = '{}', sha256 = NULL`],
    },
    'extrabiblical_data.sqlite': {
        father_meta: '1',
        commentary: or(FATHERS_VERSES.map(([books, loc]) =>
            `book IN (${books.map(q).join(', ')}) AND location_start <= ${loc} AND location_end >= ${loc}`)),
        after: [`UPDATE commentary SET txt = ${q(PLACEHOLDER)}`],
    },
    'person_places.db': {
        persons: or(PERSON_PREFIXES.map(p => `lower(unique_name) LIKE ${q(`${p}%`)}`)),
        after: [`UPDATE persons SET short_description = ${q(PLACEHOLDER)}, ext_description = ${q(PLACEHOLDER)}`],
    },
    'difficulties.sqlite': {
        difficulty_entries: `id IN (SELECT entry_id FROM src.difficulty_refs WHERE ${or(DIFFICULTY_CHAPTERS.map(([b, c]) => `book_id = ${b} AND chapter = ${c}`))})
            OR (source = 'torrey' AND section IN (${TORREY_SECTIONS.map(q).join(', ')}))`,
        // Every ref of every kept entry: getForVerse counts them (ref_count).
        difficulty_refs: 'entry_id IN (SELECT id FROM main.difficulty_entries)',
    },
};

// --- build ---------------------------------------------------------------------

async function build(file, spec) {
    const src = path.join(SRC, file);
    if (!fs.existsSync(src)) throw new Error(`${src} not found; run this where the real data files are`);
    const out = path.join(OUT, file);
    fs.rmSync(out, { force: true });
    const db = await open({ filename: out, driver: sqlite3.Database,
        mode: sqlite3.OPEN_READWRITE | sqlite3.OPEN_CREATE | sqlite3.OPEN_URI });
    await db.exec(`ATTACH DATABASE ${q(`file:${src}?mode=ro`)} AS src`);

    const schema = await db.all(`SELECT type, name, sql FROM src.sqlite_master
        WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%' ORDER BY type = 'index', rowid`);
    const counts = {};
    for (const { type, name, sql } of schema) {
        await db.exec(sql);
        if (type === 'table' && spec[name]) {
            // Tables are filled in schema order, so a later WHERE may read an
            // earlier table's kept rows via main.<table>.
            await db.exec(`INSERT INTO main."${name}" SELECT * FROM src."${name}" WHERE ${spec[name]}`);
        }
        if (type === 'table') counts[name] = (await db.get(`SELECT COUNT(*) AS n FROM main."${name}"`)).n;
    }
    for (const sql of spec.after ?? []) await db.exec(sql);
    await db.exec('DETACH DATABASE src');
    await db.exec('VACUUM');
    await db.close();
    const kb = Math.round(fs.statSync(out).size / 1024);
    console.log(`${file.padEnd(26)} ${String(kb).padStart(4)} KB  ${Object.entries(counts).map(([t, n]) => `${t}=${n}`).join(' ')}`);
}

fs.mkdirSync(OUT, { recursive: true });
for (const [file, spec] of Object.entries(FIXTURES)) await build(file, spec);
