// References must exist before they become cards.
//
// parseScriptureRefs validates book names only, so "Romans 17:1" parsed, and
// the 📖 reaction posted a card with no scripture and five study buttons - a
// user then pressed Commentary, Fathers and Interlinear on it in prod. The
// versification table is loaded from bible.db once; these tests read the
// same data rather than a hand-written list (the bible.db fixture keeps the
// last verse of every chapter, so its table is the real one).
import './helpers/fixtureData.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import log from 'loglevel';
log.setLevel('error');
const { getVersification, makeChecker, missingReferenceLine } = await import('../src/utils/versification.js');
const { parseScriptureRefs } = await import('../src/utils/scriptureRefs.js');

const v = await getVersification();
const ref = s => parseScriptureRefs(s)[0];

test('the table covers the whole Protestant canon', () => {
    assert.equal(v.loaded, true);
    let chapters = 0;
    for (let b = 1; b <= 66; b++) chapters += v.chapterCount(b);
    assert.equal(chapters, 1189);
    assert.equal(v.chapterCount(45), 16);    // Romans
    assert.equal(v.lastVerse(43, 3), 36);    // John 3
});

test('real references exist and invented ones do not', () => {
    assert.equal(v.exists(ref('Romans 16:27')), true);
    assert.equal(v.exists(ref('John 3')), true);
    assert.equal(v.exists(ref('Romans 17:1')), false);
    assert.equal(v.exists(ref('Romans 16:28')), false);
    assert.equal(v.exists(ref('John 22:1')), false);
    assert.equal(v.exists(ref('Matthew 28:21')), false);
});

test('a church network named Acts 29 is not a chapter of Acts', () => {
    const refs = parseScriptureRefs('our church is part of Acts 29');
    assert.equal(refs.length, 1, 'the parser does see it');
    assert.deepEqual(v.filter(refs), [], 'and the filter drops it');
});

test('a range running past the chapter is clamped, not dropped', () => {
    const clamped = v.clamp(ref('John 3:16-40'));
    assert.equal(clamped.startVerse, 16);
    assert.equal(clamped.endVerse, 36);
    const whole = ref('John 3:16');
    assert.equal(v.clamp(whole), whole, 'unchanged refs come back as the same object');
});

test('filter keeps order and drops only what does not exist', () => {
    const out = v.filter(parseScriptureRefs('Romans 17:1, John 3:16 and Psalm 23'));
    assert.deepEqual(out.map(r => `${r.bookId}:${r.chapter}`), ['43:3', '19:23']);
});

test('the reaction reply says why, with Psalm 151 pointed at the Septuagint', () => {
    assert.equal(missingReferenceLine(v, ref('Romans 17:1')), 'Romans has 16 chapters, so there is no Romans 17.');
    assert.equal(missingReferenceLine(v, ref('Matthew 28:21')), 'Matthew 28 has 20 verses, so there is no Matthew 28:21.');
    assert.match(missingReferenceLine(v, ref('Psalm 151')), /150 chapters.*Septuagint/);
});

test('an unloaded table allows everything rather than silencing the bot', () => {
    const open = makeChecker(null);
    assert.equal(open.exists(ref('Romans 17:1')), true);
    assert.equal(open.describeMissing(ref('Romans 17:1')), null);
});

test('every renderer entry point checks existence', async () => {
    // Four renderers each needed this and only /find had it. A new entry point
    // that forgets it reintroduces the bug with nothing failing.
    const files = {
        'src/utils/passiveDetection.js': 2,          // passive entry + postVersePager (covers AI expansion)
        'src/events/messageReactionAdd.js': 1,
        'src/components/buttons/openverse.js': 1,
    };
    for (const [file, n] of Object.entries(files)) {
        const src = await readFile(new URL(`../${file}`, import.meta.url), 'utf8');
        const calls = (src.match(/await getVersification\(\)/g) ?? []).length;
        assert.ok(calls >= n, `${file}: expected ${n} existence check(s), found ${calls}`);
    }
});
