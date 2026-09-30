// Coverage for the Septuagint lookup path.
//
// The whole risk of this feature is versification. Brenton prints the LXX's own
// numbering, where "Create in me a clean heart" is Psalm 50:12 rather than
// 51:10, so a naive join on chapter and verse returns a REAL verse from the
// WRONG psalm — fluent, plausible, and wrong. src/buildLxx.js resolves that at
// import time; these tests pin the resolution so a rebuild cannot quietly
// regress it.
//
// Runs on the committed fixture (tests/fixtures/data/lxx.sqlite, extracted from
// the gitignored data/lxx.sqlite, which is built by
// `node src/buildLxx.js <eng-Brenton_vpl.txt>`).
//
// NOTE: test names stay ASCII — prod's Node 18.13 TAP lexer dies on non-ASCII
// in a test() description and reports the whole file as 0 passed.

import './helpers/fixtureData.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { lxxWrapper } from '../src/utils/studyHelper.js';

const one = async (bookId, chapter, verse) => {
    const rows = await lxxWrapper.getVerses(bookId, chapter, verse, verse);
    return rows[0] ?? null;
};

const PSALMS = 19, ISAIAH = 23, JEREMIAH = 24, GENESIS = 1, DANIEL = 27;

// --- the versification the feature exists to get right ---------------------

test('Psalm 51:10 returns the LXX verse it actually lives at', async () => {
    const row = await one(PSALMS, 51, 10);
    assert.ok(row, 'Psalm 51:10 must resolve');
    assert.match(row.text, /clean heart/i);
    assert.equal(row.lxx_ref, 'LXX Psalms 50:12');
});

test('Psalm 23 returns the shepherd psalm, not Psalm 24', async () => {
    // The failure this guards: LXX Psalm 23 is "The earth is the Lord's",
    // which is a real psalm and completely the wrong answer.
    const row = await one(PSALMS, 23, 1);
    assert.match(row.text, /shepherd/i);
    assert.doesNotMatch(row.text, /earth is the Lord/i);
    assert.equal(row.lxx_ref, 'LXX Psalms 22:1');
});

test('Psalm 22:1 lands on the cry Jesus quotes', async () => {
    // Offset by two here rather than one, because the LXX numbers this psalm's
    // superscription separately.
    const row = await one(PSALMS, 22, 1);
    assert.match(row.text, /forsaken me/i);
    assert.equal(row.lxx_ref, 'LXX Psalms 21:2');
});

test('a psalm needing no offset is left alone', async () => {
    const row = await one(PSALMS, 1, 1);
    assert.match(row.text, /blessed/i);
    assert.equal(row.lxx_ref, 'LXX Psalms 1:1');
});

test('Jeremiah 31:31 finds the new covenant at its LXX address', async () => {
    // The LXX puts Masoretic 26-44 seven chapters later.
    const row = await one(JEREMIAH, 31, 31);
    assert.match(row.text, /covenant/i);
    assert.equal(row.lxx_ref, 'LXX Jeremiah 38:31');
});

test('the relocated oracles against the nations resolve', async () => {
    // Masoretic 46-51 sit in the MIDDLE of the Greek book.
    const row = await one(JEREMIAH, 46, 2);
    assert.ok(row, 'Jeremiah 46:2 must resolve');
    assert.match(row.lxx_ref, /LXX Jeremiah 26:/);
});

test('books needing no mapping pass straight through', async () => {
    const gen = await one(GENESIS, 1, 1);
    assert.equal(gen.lxx_ref, 'LXX Genesis 1:1');
    const dan = await one(DANIEL, 7, 13);
    assert.match(dan.text, /Son of man/i);
});

// --- the reading people come for -------------------------------------------

test('Isaiah 7:14 carries the LXX reading the New Testament quotes', async () => {
    const row = await one(ISAIAH, 7, 14);
    assert.match(row.text, /virgin/i);
});

// --- absence is an answer, not a failure -----------------------------------

test('a verse the Greek does not have returns nothing rather than a neighbour', async () => {
    // The LXX has no heading at Jeremiah 46:1, so its Greek chapter starts at
    // verse 2. Returning the next verse along would be the silent-wrong-answer
    // failure this whole design avoids.
    const rows = await lxxWrapper.getVerses(JEREMIAH, 46, 1, 1);
    assert.equal(rows.length, 0);
});

test('New Testament books have no Septuagint rows at all', async () => {
    const rows = await lxxWrapper.getVerses(43, 3, 16, 16);   // John 3:16
    assert.equal(rows.length, 0);
});

// --- ranges ----------------------------------------------------------------

test('a verse range comes back in order and in Masoretic numbering', async () => {
    const rows = await lxxWrapper.getVerses(PSALMS, 51, 10, 12);
    assert.equal(rows.length, 3);
    assert.deepEqual(rows.map(r => r.verse), [10, 11, 12]);
    assert.match(rows[0].text, /clean heart/i);
});

// --- chapters the build could not corroborate ------------------------------

test('divergent chapters are FLAGGED rather than silently shipped', async () => {
    // The Greek tabernacle account in Exodus 36-39 is arranged differently
    // enough that the build could not confirm a verse-for-verse line-up. The
    // text is still served; the flag is what lets the card say so.
    const rows = await lxxWrapper.getVerses(2, 38, 1, 3);
    assert.ok(rows.length > 0, 'Exodus 38 should still return text');
    assert.ok(rows.some(r => r.approx === 1), 'Exodus 38 should be marked approximate');
});

test('well-corroborated chapters are NOT flagged', async () => {
    const row = await one(GENESIS, 1, 1);
    assert.equal(row.approx, 0);
});

// --- Septuagint-only books -------------------------------------------------

test('deuterocanonical books resolve by name and by alias', async () => {
    const sirach = await lxxWrapper.resolveDeuteroBook('Sirach');
    assert.equal(sirach.code, 'SIR');
    const alias = await lxxWrapper.resolveDeuteroBook('ecclesiasticus');
    assert.equal(alias.code, 'SIR');
    const cased = await lxxWrapper.resolveDeuteroBook('  TOBIT  ');
    assert.equal(cased.code, 'TOB');
});

test('an unknown book name resolves to nothing', async () => {
    assert.equal(await lxxWrapper.resolveDeuteroBook('Hezekiah'), null);
    assert.equal(await lxxWrapper.resolveDeuteroBook(''), null);
});

test('a Septuagint-only book returns text by its own address', async () => {
    const rows = await lxxWrapper.getByCode('SIR', 2, 1, 1);
    assert.equal(rows.length, 1);
    assert.match(rows[0].lxx_ref, /Sirach 2:1/);
});

test('Psalm 151 exists in the Greek and has no Masoretic address', async () => {
    const rows = await lxxWrapper.getByCode('PSA', 151, 1, 1);
    assert.equal(rows.length, 1);
    // Every other psalm is reachable by Masoretic coordinates; this one cannot
    // be, because the Hebrew Psalter stops at 150.
    const viaMt = await lxxWrapper.getVerses(PSALMS, 151, 1, 1);
    assert.equal(viaMt.length, 0);
});

test('the deuterocanonical book list is complete', async () => {
    const books = await lxxWrapper.listDeuteroBooks();
    const names = books.map(b => b.name);
    for (const expected of ['Tobit', 'Judith', 'Sirach', 'Baruch', '1 Maccabees', 'Wisdom of Solomon']) {
        assert.ok(names.includes(expected), `missing ${expected}`);
    }
});

// --- reading a whole LXX passage -------------------------------------------
//
// /lxx had two ceilings and no way past either: 1800 chars of Greek text, and
// a hard MAX_VERSES of 20. 765 chapters exceed 20 verses, so "/lxx Psalms 119"
// could never show more than a fifth of the psalm and offered nothing to click.
//
// The reader is the SHARED one from passiveDetection, given a fetcher for this
// corpus. That sharing is the point: the bot previously grew four separate
// verse renderers that each had to be fixed on its own.

import { buildPassagePages, buildPassageReaderComponents } from '../src/utils/passiveDetection.js';

const lxxFetcher = (bookId, code) => async (r, from, to) => {
    const rows = bookId !== null
        ? await lxxWrapper.getVerses(bookId, r.chapter, from, to)
        : await lxxWrapper.getByCode(code, r.chapter, from, to);
    return rows.map(x => ({ number: x.verse, text: x.text })).filter(v => Boolean(v.text));
};

test('a long psalm pages past the twenty-verse card cap', async () => {
    const ref = { bookId: PSALMS, bookName: 'Psalms', chapter: 119, startVerse: null, endVerse: null };
    const pages = await buildPassagePages(ref, 'LXX', undefined, lxxFetcher(PSALMS, null));
    assert.ok(pages.length > 1, 'Psalm 119 should need several pages');
    assert.ok(
        pages[pages.length - 1].lastVerse > 20,
        `the reader must go past the card cap, reached ${pages[pages.length - 1].lastVerse}`
    );
});

test('paging LXX loses no verses and keeps them in order', async () => {
    const ref = { bookId: PSALMS, bookName: 'Psalms', chapter: 119, startVerse: null, endVerse: null };
    const pages = await buildPassagePages(ref, 'LXX', undefined, lxxFetcher(PSALMS, null));
    for (let i = 1; i < pages.length; i++) {
        assert.equal(
            pages[i].firstVerse, pages[i - 1].lastVerse + 1,
            `page ${i + 1} should resume exactly where page ${i} stopped`
        );
    }
});

test('a Septuagint-only book pages by its own code', async () => {
    // Deuterocanonical books have no Masoretic address at all, so the reader
    // has to reach them through getByCode rather than a bookId.
    const ref = { bookId: null, bookName: 'Tobit', chapter: 1, startVerse: null, endVerse: null };
    const pages = await buildPassagePages(ref, 'LXX', undefined, lxxFetcher(null, 'TOB'));
    assert.ok(pages.length > 0, 'Tobit 1 should page');
    assert.equal(pages[0].firstVerse, 1);
});

test('the LXX reader addresses itself, not the Bible reader', async () => {
    // Both readers share one builder, so the customId base is what keeps a
    // Septuagint page from paging into the BSB.
    const ref = { bookId: PSALMS, bookName: 'Psalms', chapter: 119, startVerse: null, endVerse: null };
    const pages = await buildPassagePages(ref, 'LXX', undefined, lxxFetcher(PSALMS, null));
    const comps = buildPassageReaderComponents(ref, 'LXX', pages, 0, {
        customIdBase: 'lxxread:19:119:0:0',
        heading: 'Brenton',
    });
    const ids = comps.map(c => c.toJSON())
        .filter(c => c.type === 1)
        .flatMap(r => r.components.map(b => b.custom_id));
    assert.ok(ids.some(id => id?.startsWith('lxxread:')), 'controls must address the LXX reader');
    assert.ok(!ids.some(id => id?.startsWith('passageread:')), 'and never the Bible reader');
});

test('a passage that fits needs no pages beyond the first', async () => {
    const ref = { bookId: ISAIAH, bookName: 'Isaiah', chapter: 53, startVerse: null, endVerse: null };
    const pages = await buildPassagePages(ref, 'LXX', undefined, lxxFetcher(ISAIAH, null));
    assert.equal(pages.length, 1);
    assert.match(pages[0].text, /virgin|servant|sorrows|iniquit/i);
});
