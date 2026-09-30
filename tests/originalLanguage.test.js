// lookup_original must warn that its English glosses are not the original.
//
// The interlinear's glosses follow the KJV, supplied italic words included,
// and hang them on the nearest original word. In 2 Sam 21:19 "the brother of
// Goliath" is glossed onto the Hebrew for Goliath alone. Under pressure to
// defend a translation, the bot asserted the Masoretic text read "et ahi" -
// "the brother of" - which it does not. These tests pin both the data fact
// and the caveat that stops the gloss being read as the text.
import path from 'node:path';
import { FIXTURE_DATA_DIR } from './helpers/fixtureData.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import sqlite3 from 'sqlite3';

const src = await readFile(new URL('../src/utils/aiChat.js', import.meta.url), 'utf8');

test('both lookup_original success paths carry the gloss caveat', () => {
    const start = src.indexOf('async function toolLookupOriginal');
    const body = src.slice(start, src.indexOf('\n}\n', start));
    const successReturns = body.match(/return `\$\{ref\} \(\$\{lexicon\}\)[^`]*`/g) ?? [];
    assert.equal(successReturns.length, 2, 'expected the word-mode and whole-verse returns');
    for (const r of successReturns) assert.match(r, /\$\{GLOSS_CAVEAT\}/);
});

test('2 Sam 21:19 has no Hebrew word for brother, though the gloss says so', async () => {
    const db = new sqlite3.Database(path.join(FIXTURE_DATA_DIR, 'bible.db'), sqlite3.OPEN_READONLY);
    const row = await new Promise((res, rej) =>
        db.get('SELECT data FROM interlinear WHERE bookid=10 AND chapter=21 AND verse=19', (e, r) => (e ? rej(e) : res(r))));
    db.close();
    const words = JSON.parse(row.data);
    // H251 is ach, "brother". Its absence is the whole point.
    assert.ok(!words.some(w => /^h0*251$/i.test(w.number)), 'no H251 in the Hebrew');
    // ...while the KJV gloss still attaches "brother" to Goliath (H1555).
    const goliath = words.find(w => /^h1555$/i.test(w.number));
    assert.match(goliath.text, /brother/);
});
