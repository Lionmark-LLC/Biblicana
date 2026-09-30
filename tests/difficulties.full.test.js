// Keyword search over Haley and Torrey, against the REAL data/difficulties.sqlite.
//
// search() weights each word by how rare it is across all 664 entries (IDF),
// so ranking is a property of the whole corpus: on the 43-entry fixture these
// would pass or fail for different reasons than in prod. So they run only
// where the real file exists (Kenneth's Mac, the droplet) and SKIP elsewhere,
// with the reason. Nothing is imported when the file is absent, so a fresh
// clone neither opens nor creates anything under data/.
//
// NOTE: test names stay ASCII (see the note in heartbeat.test.js).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import log from 'loglevel';

const REAL = fileURLToPath(new URL('../data/difficulties.sqlite', import.meta.url));
const skip = fs.existsSync(REAL) ? false
    : 'data/difficulties.sqlite is absent (gitignored; see CLAUDE.md). Keyword ranking needs the whole corpus, not the fixture.';

let difficultiesWrapper, difficultyCitation, toolLookupDifficulty;
if (!skip) {
    log.setLevel('error');
    ({ difficultiesWrapper, difficultyCitation } = await import('../src/utils/studyHelper.js'));
    ({ toolLookupDifficulty } = await import('../src/utils/aiChat.js'));
}

test('by keyword: a rare word outweighs a common one', { skip }, async () => {
    // Flat counting ranked "Aaron died upon Mount Hor" above Judas for this.
    const [top] = await difficultiesWrapper.search('how did Judas die');
    assert.match(top.title, /Judas/);
    const [g] = await difficultiesWrapper.search('who killed Goliath, David or Elhanan');
    assert.match(g.title, /Elhanan/);
});

test('Torrey essays are found by topic and cited as Torrey, not Haley', { skip }, async () => {
    for (const [q, title] of [
        ['where did Cain get his wife', /Cain Get His Wife/],
        ['were Jesus and Paul mistaken about the time of his return', /Mistaken as to the Time/],
        ['slaughter of the Canaanites', /Canaanites/],
    ]) {
        const [top] = await difficultiesWrapper.search(q);
        assert.match(top.title, title, q);
        assert.equal(top.source, 'torrey');
        assert.match(difficultyCitation(top.source), /Torrey.*1907/);
    }
});

test('a topic with a chapter number still reaches the topic', { skip }, async () => {
    // "Jephthah's daughter sacrifice Judges 11" parsed "Judges 11", took the
    // by-verse path, checked verse 1, missed, and the bot went to the web.
    const out = await toolLookupDifficulty({ query: "Jephthah's daughter sacrifice Judges 11" });
    assert.match(out, /Torrey/);
    assert.match(out, /Jephthah/);
});
