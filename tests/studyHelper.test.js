// Pure-function coverage for the Father classification helpers in
// src/utils/studyHelper.js.
//
// The extrabiblical_data collection is 2,000 years of Christian commentary
// under a patristic label: 285 genuinely patristic authors alongside 49
// medieval, Reformation-era and modern writers (C.S. Lewis, Tolkien, and at
// least one living author). Getting this classification wrong means the bot
// tells someone the early church said something C.S. Lewis wrote in 1963.
//
// NOTE: importing studyHelper.js opens the SQLite files as a side effect of
// module load. That is fine here — the files are present in dev — but it is
// why these tests only exercise the pure exports.

import './helpers/fixtureData.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import log from 'loglevel';

log.setLevel('error');

import {
    classifyFather, fatherEraBadge, normalizeFatherName, extractVerseSlice, personsWrapper,
} from '../src/utils/studyHelper.js';

// --- normalizeFatherName ---------------------------------------------------
// The DB stores "CS Lewis" with no periods, so a correctly-typed "C.S. Lewis"
// used to match nothing. Both sides of the comparison must normalise the same
// way or the match silently fails.

test('punctuation variants of a name collapse to one key', () => {
    const expected = 'cslewis';
    assert.equal(normalizeFatherName('C.S. Lewis'), expected);
    assert.equal(normalizeFatherName('CS Lewis'), expected);
    assert.equal(normalizeFatherName('c.s.lewis'), expected);
    assert.equal(normalizeFatherName('C S Lewis'), expected);
});

test('hyphens and apostrophes are stripped too', () => {
    assert.equal(normalizeFatherName("Pseudo-Dionysius"), 'pseudodionysius');
    assert.equal(normalizeFatherName("John of the Cross"), 'johnofthecross');
});

test('null and undefined normalise to an empty string, not a crash', () => {
    assert.equal(normalizeFatherName(null), '');
    assert.equal(normalizeFatherName(undefined), '');
});

// --- classifyFather (model-facing) -----------------------------------------

test('patristic authors are classified as Church Fathers', () => {
    assert.equal(classifyFather('430').patristic, true);      // Augustine
    assert.equal(classifyFather('800').patristic, true);      // era boundary, inclusive
});

test('post-800 authors are NOT Church Fathers', () => {
    assert.equal(classifyFather('801').patristic, false);     // just past the boundary
    assert.equal(classifyFather('1274').patristic, false);    // Aquinas
    assert.equal(classifyFather('1963').patristic, false);    // C.S. Lewis
});

test('undated and pseudonymous works count as patristic-adjacent', () => {
    // 9999 is the dataset's marker for undated/pseudonymous works, which are
    // patristic-adjacent rather than modern.
    assert.equal(classifyFather('9999').patristic, true);
    assert.equal(classifyFather(null).patristic, true);
    assert.equal(classifyFather('not a year').patristic, true);
});

test('non-patristic era strings warn the model explicitly', () => {
    // These strings are injected into the prompt, so the disclaimer has to be
    // in the string itself — the model never sees the boolean.
    assert.match(classifyFather('1963').era, /NOT a Church Father/);
    assert.match(classifyFather('1274').era, /NOT a Church Father/);
    assert.doesNotMatch(classifyFather('430').era, /NOT a Church Father/);
});

test('default_year is parsed from TEXT, not assumed numeric', () => {
    // The column is TEXT in the DB; a string must classify identically.
    assert.deepEqual(classifyFather('430'), classifyFather(430));
});

// --- fatherEraBadge (user-facing) ------------------------------------------

test('genuine Fathers get no badge', () => {
    assert.equal(fatherEraBadge('430'), null);
    assert.equal(fatherEraBadge('9999'), null);
    assert.equal(fatherEraBadge(null), null);
});

test('later writers get a short, non-scolding badge', () => {
    // classifyFather's era strings shout "NOT a Church Father" because they
    // instruct a model. In the UI that reads as scolding, so the badge is
    // deliberately calmer while still being accurate.
    assert.equal(fatherEraBadge('1295'), 'Medieval · c. 1295');
    assert.equal(fatherEraBadge('1637'), 'Reformation era · c. 1637');
    assert.equal(fatherEraBadge('1963'), 'Modern · c. 1963');
    assert.doesNotMatch(fatherEraBadge('1963'), /NOT/);
});

// --- extractVerseSlice -----------------------------------------------------
// Passage-grouped commentators key a whole block at its first verse. Matthew
// Henry on Philippians 4:1-9 is ONE 11,968-character entry, and the verse-6
// discussion begins at character 7,687 — so taking the first 900 characters
// answered a question about verse 6 with material about verse 1, confidently
// and about the wrong verse. Synthetic text here so the tests don't need the DB.

// Filler is space-separated. Padding a marker directly against filler would
// produce "xxxPhi 4:1", and \b needs a word boundary before the book token —
// real commentary always has whitespace there (verified against the actual
// Henry block, which yields 10 markers), so gluing them would test a shape the
// data never takes.
const filler = ch => ` ${ch.repeat(300)} `;
const BLOCK = [
    `Intro material before any marker.${filler('x')}`,
    `Phi 4:1. First verse discussion.${filler('a')}`,
    `Phi 4:4. Fourth verse discussion.${filler('b')}`,
    `Phi 4:6. Be careful for nothing.${filler('c')}`,
    `Phi 4:9. Ninth verse discussion.${filler('d')}`,
].join('');

test('text within budget is returned untouched', () => {
    const result = extractVerseSlice('a short note', 4, 6, 900);
    assert.equal(result.text, 'a short note');
    assert.equal(result.fromVerse, null);
});

test('anchors to the requested verse rather than the start of the block', () => {
    const result = extractVerseSlice(BLOCK, 4, 6, 900);
    assert.equal(result.fromVerse, 6);
    assert.match(result.text, /^Phi 4:6/);
    assert.match(result.text, /Be careful for nothing/);
    // The regression this exists to prevent: the old code returned this.
    assert.doesNotMatch(result.text, /Intro material/);
});

test('stops before the next verse so the slice stays on topic', () => {
    const result = extractVerseSlice(BLOCK, 4, 6, 900);
    assert.doesNotMatch(result.text, /Phi 4:9/);
});

test('falls back to the nearest preceding verse when the exact one is absent', () => {
    // Verse 7 has no marker; verse 6's discussion is the one most likely to
    // still cover it.
    const result = extractVerseSlice(BLOCK, 4, 7, 900);
    assert.equal(result.fromVerse, 6);
    assert.match(result.text, /^Phi 4:6/);
});

test('a verse before every marker falls back to plain truncation', () => {
    const noEarlyMarker = extractVerseSlice(BLOCK, 4, 1, 900);
    assert.equal(noEarlyMarker.fromVerse, 1);
    assert.match(noEarlyMarker.text, /^Phi 4:1/);
});

test('unmarked text degrades to truncation rather than returning nothing', () => {
    const result = extractVerseSlice('y'.repeat(3000), 4, 6, 120);
    assert.equal(result.fromVerse, null);
    assert.equal(result.text.length, 120);
});

test('never exceeds the caller\'s character budget', () => {
    for (const verse of [1, 4, 6, 9]) {
        assert.ok(extractVerseSlice(BLOCK, 4, verse, 200).text.length <= 200);
    }
});

test('markers from other chapters cannot hijack the anchor', () => {
    // A cross-reference like "Psa 37:4" inside a Philippians 4 block must not
    // be mistaken for this chapter's verse 4 — Henry's real text is full of
    // exactly these citations.
    const withCrossRef = [
        `Phi 4:1. Opening discussion.${filler('a')}`,
        `See also Psa 37:4 and Rom 6:6 for comparison.${filler('b')}`,
        `Phi 4:6. The verse we actually want.${filler('c')}`,
    ].join('');
    const result = extractVerseSlice(withCrossRef, 4, 6, 400);
    assert.equal(result.fromVerse, 6);
    assert.match(result.text, /The verse we actually want/);
});

test('badge and classification never disagree', () => {
    // A badge means "not patristic"; no badge means "patristic". If these ever
    // drift apart, /fathers and the AI path would tell users different things
    // about the same author.
    for (const year of ['430', '800', '801', '1274', '1500', '1963', '9999', null, 'junk']) {
        const { patristic } = classifyFather(year);
        const badge = fatherEraBadge(year);
        assert.equal(patristic, badge === null, `disagreement for year=${JSON.stringify(year)}`);
    }
});

// --- finding a person by a fuller name -------------------------------------
//
// The dataset keys people as "Peter_Mat.4.18" - canonical name then first
// mention - and the search matched a PREFIX of that whole string. So "Peter"
// worked while "Simon Peter" returned nothing, and the tool reported "no entry
// in the dataset" for one of the best-attested figures in Scripture. The model
// had behaved sensibly by supplying the fuller name; the more precise it was,
// the more certainly it failed.

test('an exact canonical name is reported as exact', async () => {
    const { results, matchType } = await personsWrapper.search('Peter');
    assert.equal(matchType, 'exact');
    assert.ok(results.length > 0);
    assert.match(results[0].unique_name, /^Peter_/);
});

test('a fuller name still finds the person, as a candidate', async () => {
    const { results, matchType } = await personsWrapper.search('Simon Peter');
    assert.equal(matchType, 'fuzzy', 'must not report "none" for a real figure');
    assert.ok(
        results.some(r => /^Peter_/.test(r.unique_name)),
        'Peter should be among the candidates'
    );
});

test('punctuation and honorifics do not defeat the search', async () => {
    for (const query of ['Peter (Simon Peter)', 'the Apostle Peter', 'Saint Peter']) {
        const { results, matchType } = await personsWrapper.search(query);
        assert.notEqual(matchType, 'none', `"${query}" should still reach Peter`);
        assert.ok(
            results.some(r => /^Peter_/.test(r.unique_name)),
            `"${query}" should return Peter`
        );
    }
});

test('LIKE wildcards in the pattern are escaped', async () => {
    // REGRESSION: SQLite LIKE treats _ as a single-character wildcard, and this
    // dataset uses literal underscores. Unescaped, "the_%" matched THEophilus
    // and THEudas - so "the Apostle Peter" answered with Theophilus.
    const { results } = await personsWrapper.search('the Apostle Peter');
    const names = results.map(r => r.unique_name);
    assert.ok(!names.some(n => /^Theophilus/.test(n)), 'must not match Theophilus');
    assert.ok(!names.some(n => /^Theudas/.test(n)), 'must not match Theudas');
});

test('a name the dataset genuinely lacks reports none', async () => {
    // The honest negative has to survive: widening the search must not turn
    // every miss into a pile of unrelated candidates.
    const { results, matchType } = await personsWrapper.search('Xyzzy');
    assert.equal(matchType, 'none');
    assert.equal(results.length, 0);
});

test('a single unmatched word does not fan out', async () => {
    // One word has nothing to split on, so there is no second tier to try -
    // returning the whole table because a name was misspelled would be worse
    // than saying so.
    const { matchType } = await personsWrapper.search('Qwertyuiop');
    assert.equal(matchType, 'none');
});
