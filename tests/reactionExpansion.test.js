// Coverage for the 📖 reaction card.
//
// This is the THIRD renderer that shows verses, after the autopost cards and
// /bible, and it has its own fetch. That is how it kept two faults the other
// two had already lost: a chapter-only reference returned no scripture at all,
// and everything else was cut at a hard-coded 450 with no way to read on.
//
// The chapter case is the one users actually hit. Reacting to another Bible
// bot's post is a common way to use this, and those posts are headed with a
// CHAPTER ("Psalm 23 - New King James Version"), so the card came back with a
// heading, five buttons and nothing to read.
//
// Reads the bible.db fixture (tests/fixtures/data), same as the pager tests.
//
// NOTE: test names stay ASCII - prod's Node 18.13 TAP lexer dies on non-ASCII
// in a test() description and reports the whole file as 0 passed.

import './helpers/fixtureData.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import log from 'loglevel';

log.setLevel('error');

import { buildExpansionReply, reactionRefValue } from '../src/events/messageReactionAdd.js';

const ref = (bookId, bookName, chapter, startVerse = null, endVerse = null) =>
    ({ bookId, bookName, chapter, startVerse, endVerse });

const rows = reply => reply.components.map(c => c.toJSON());
const buttonIds = json => json
    .filter(c => c.type === 1)
    .flatMap(r => r.components.map(b => b.custom_id));
const textOf = json => json
    .filter(c => c.type !== 1)
    .flatMap(c => (c.components ?? []).map(b => b.content ?? ''))
    .join('\n');

test('a chapter reference returns scripture, not an empty card', async () => {
    const json = rows(await buildExpansionReply(ref(19, 'Psalms', 23), 'BSB'));
    const text = textOf(json);
    assert.match(text, /shepherd/i, 'Psalm 23 should actually contain the psalm');
    assert.match(text, /Psalms 23/, 'and still name what it is showing');
});

test('a chapter reference shows more than the opening line', async () => {
    // The failure this guards is subtle: returning verse 1 alone would look
    // like a fix while still hiding the chapter.
    const json = rows(await buildExpansionReply(ref(19, 'Psalms', 23), 'BSB'));
    const text = textOf(json);
    assert.match(text, /valley/i, 'verse 4 should be present');
    assert.match(text, /dwell in the house/i, 'and the closing verse too');
});

test('a long chapter offers a way to read the rest', async () => {
    const json = rows(await buildExpansionReply(ref(19, 'Psalms', 119), 'BSB'));
    assert.ok(
        buttonIds(json).some(id => id?.startsWith('passageread:')),
        'a truncated reaction card must carry Read full'
    );
});

test('a card showing everything does not promise more', async () => {
    const json = rows(await buildExpansionReply(ref(43, 'John', 11, 35, 35), 'BSB'));
    assert.equal(
        buttonIds(json).some(id => id?.startsWith('passageread:')),
        false,
        '"Jesus wept." is complete, so there is nothing to read on to'
    );
});

test('Read full gets its own row because the study row is full', async () => {
    // Discord caps a row at five buttons and the study chain already uses all
    // five, so appending a sixth would have made the message unsendable.
    const json = rows(await buildExpansionReply(ref(19, 'Psalms', 119), 'BSB'));
    const actionRows = json.filter(c => c.type === 1);
    assert.equal(actionRows.length, 2, 'study row plus a Read full row');
    for (const row of actionRows) {
        assert.ok(row.components.length <= 5, 'no row may exceed five buttons');
    }
    assert.equal(actionRows[0].components.length, 5, 'the study chain still has all five');
});

test('a verse reference still shows its text and study stats', async () => {
    const json = rows(await buildExpansionReply(ref(43, 'John', 3, 16, 16), 'BSB'));
    assert.match(textOf(json), /loved the world/i);
    assert.equal(buttonIds(json).filter(id => id?.startsWith('openverse:')).length, 5);
});

// --- several references in one reacted message -----------------------------
//
// Only the first was ever rendered and the rest were dropped silently. The
// shape that exposes it is common: another Bible bot posting two embeds in one
// message, so a reader could see both verses quoted above and get a card for
// one of them with no sign the other existed.

const selects = json => json
    .filter(c => c.type === 1)
    .flatMap(r => r.components.filter(x => x.type === 3));

test('a message quoting two passages offers a picker', async () => {
    const siblings = [ref(20, 'Proverbs', 3, 7, 7), ref(43, 'John', 1, 1, 1)];
    const json = rows(await buildExpansionReply(siblings[0], 'BSB', siblings));
    const menu = selects(json)[0];
    assert.ok(menu, 'two references should produce a jump menu');
    assert.equal(menu.options.length, 2, 'and list both of them');
    assert.deepEqual(menu.options.map(o => o.label), ['Proverbs 3:7', 'John 1:1']);
});

test('a lone reference gets no picker', async () => {
    const one = [ref(20, 'Proverbs', 3, 7, 7)];
    const json = rows(await buildExpansionReply(one[0], 'BSB', one));
    assert.equal(selects(json).length, 0, 'nothing to jump between');
});

test('the picker marks the reference currently shown', async () => {
    const siblings = [ref(20, 'Proverbs', 3, 7, 7), ref(43, 'John', 1, 1, 1)];
    const json = rows(await buildExpansionReply(siblings[1], 'BSB', siblings));
    const menu = selects(json)[0];
    const marked = menu.options.filter(o => o.default);
    assert.equal(marked.length, 1, 'exactly one option is the current one');
    assert.equal(marked[0].label, 'John 1:1');
});

test('a reference address survives the value round trip', () => {
    // The value IS the state - a customId could never hold 25 references - so
    // the encoding has to be lossless for chapter-only refs too.
    assert.equal(reactionRefValue(ref(43, 'John', 3, 16, 21)), '43:3:16:21');
    assert.equal(reactionRefValue(ref(19, 'Psalms', 23)), '19:23:0:0');
});

test('the picker never exceeds the Discord select cap', async () => {
    const many = Array.from({ length: 40 }, (_, i) => ref(19, 'Psalms', 1, i + 1, i + 1));
    const json = rows(await buildExpansionReply(many[0], 'BSB', many));
    assert.ok(selects(json)[0].options.length <= 25, 'Discord rejects a menu above 25 options');
});
