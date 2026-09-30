// Corroborates SINGLE_CHAPTER_BOOKS against bible.db.
//
// The parser hardcodes which books have one chapter and how many verses each
// holds, because parseScriptureRefs is synchronous and pure and must not open a
// database to resolve "Jude 5". Hardcoded structural facts are exactly the kind
// that drift silently: a wrong book ID would quietly stop remapping one book,
// and a wrong verse count would either reject real citations or admit prose as
// a reference. Neither would throw.
//
// So the list is DERIVED here rather than trusted. This file is separate from
// scriptureRefs.test.js on purpose: that suite is pure and fast, and should not
// start failing wholesale if data goes missing. It runs on the bible.db
// fixture, which keeps the last verse of every chapter, so the derived
// counts are the real ones.
//
// NOTE: test names stay ASCII - prod's Node 18.13 TAP lexer dies on non-ASCII
// in a test() description and reports the whole file as 0 passed.

import './helpers/fixtureData.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import log from 'loglevel';

log.setLevel('error');

import { SINGLE_CHAPTER_BOOKS } from '../src/utils/scriptureRefs.js';
import { bibleWrapper } from '../src/utils/bibleHelper.js';
import { toCanonical } from '../src/utils/bookNames.js';

const exists = async (bookId, chapter, verse) => {
    const rows = await bibleWrapper.getVerses(bookId, chapter, verse, verse);
    return rows.length > 0;
};

test('every listed book really has exactly one chapter', async () => {
    for (const bookId of SINGLE_CHAPTER_BOOKS.keys()) {
        const name = toCanonical(bookId);
        assert.ok(await exists(bookId, 1, 1), `${name} should have a chapter 1`);
        assert.equal(await exists(bookId, 2, 1), false, `${name} should have NO chapter 2`);
    }
});

test('every listed verse count is the books actual last verse', async () => {
    for (const [bookId, verseCount] of SINGLE_CHAPTER_BOOKS) {
        const name = toCanonical(bookId);
        assert.ok(
            await exists(bookId, 1, verseCount),
            `${name} 1:${verseCount} should exist - the count is too high`
        );
        assert.equal(
            await exists(bookId, 1, verseCount + 1),
            false,
            `${name} 1:${verseCount + 1} should not exist - the count is too low`
        );
    }
});

test('no single-chapter book is missing from the list', async () => {
    // The completeness half. Catches the failure the two tests above cannot:
    // a one-chapter book that was never added, which would go on parsing
    // "Obadiah 3" as chapter 3 forever.
    const missing = [];
    for (let bookId = 1; bookId <= 66; bookId++) {
        if (SINGLE_CHAPTER_BOOKS.has(bookId)) continue;
        if (!(await exists(bookId, 2, 1))) missing.push(`${bookId} ${toCanonical(bookId)}`);
    }
    assert.deepEqual(missing, [], `single-chapter books absent from SINGLE_CHAPTER_BOOKS: ${missing.join(', ')}`);
});
