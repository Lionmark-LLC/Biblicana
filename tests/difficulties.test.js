// Haley's "Alleged Discrepancies of the Bible" (1874) must answer the cases
// that shaped its importer, by verse and by keyword, with the right page.
//
// src/buildDifficulties.js parses heavily damaged OCR: Roman-numeral chapters,
// book names read as "Kom" and "Xum", quoted verses in side-by-side columns
// read straight across. These tests pin the three sentinel entries the build
// itself refuses to ship without, plus the ranking rules that keep a passing
// mention from outranking the entry that is ABOUT a verse.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import log from 'loglevel';
log.setLevel('error');
const { difficultiesWrapper, difficultyExcerpt } = await import('../src/utils/studyHelper.js');

test('by verse: Goliath and both sides of Judas resolve to the right entry and page', async () => {
    const cases = [
        [10, 21, 19, /Elhanan/, '336'],   // 2 Sam 21:19
        [40, 27, 5, /Judas/, '349'],      // Matt 27:5
        [44, 1, 18, /Judas/, '349'],      // Acts 1:18 - the OTHER side of the same case
    ];
    for (const [b, c, v, title, page] of cases) {
        const [top] = await difficultiesWrapper.getForVerse(b, c, v, { primaryOnly: true });
        assert.ok(top, `no entry for ${b}:${c}:${v}`);
        assert.match(top.title, title);
        assert.equal(top.page, page);
    }
});

test('a verse in two cases is resolved by what was asked', async () => {
    // 2 Kings 8:26 is primary in BOTH "Ahaziah's age, 22 or 42" and
    // "Ahaziah's grandfather, Omri or Ahab"; the verse alone cannot choose.
    const { pickDifficulty } = await import('../src/utils/studyHelper.js');
    const rows = await difficultiesWrapper.getForVerse(12, 8, 26, { primaryOnly: true, limit: 3 });
    const titles = rows.map(r => r.title).join(' | ');
    assert.match(titles, /age/, 'the age entry is a candidate');
    assert.match(titles, /grandfather/, 'so is the grandfather entry');
    assert.equal(pickDifficulty(rows, '2 Kings 8:26 says Ahaziah was 22 but Chronicles says 42').page, '398');
    assert.match(pickDifficulty(rows, 'was Ahaziah the grandson of Omri or of Ahab? 2 Kings 8:26').title, /grandfather/);
});

test('by keyword: a rare word outweighs a common one', async () => {
    // Flat counting ranked "Aaron died upon Mount Hor" above Judas for this.
    const [top] = await difficultiesWrapper.search('how did Judas die');
    assert.match(top.title, /Judas/);
    const [g] = await difficultiesWrapper.search('who killed Goliath, David or Elhanan');
    assert.match(g.title, /Elhanan/);
});

test('an excerpt of a long entry is the passage about the verse, not its opening', async () => {
    const [entry] = await difficultiesWrapper.getForVerse(12, 15, 1);
    assert.ok(entry.body.length > 700, 'the Ahaziah entry is long');
    const ex = difficultyExcerpt(entry.body, 15, 1, 300);
    assert.match(ex, /15:1\b/);
    assert.ok(ex.length <= 310);
});

test('Torrey essays are found by topic and cited as Torrey, not Haley', async () => {
    const { difficultyCitation } = await import('../src/utils/studyHelper.js');
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

test('by verse, an entry ABOUT the verse outranks an essay citing it', async () => {
    // Torrey is stored non-primary throughout, so Haley's Judas case must lead.
    const rows = await difficultiesWrapper.getForVerse(40, 27, 5);
    assert.equal(rows[0].source, 'haley');
    assert.match(rows[0].title, /Judas/);
});

test('a verse inside a verse LIST is found, not just a literal chapter:verse', async () => {
    // Torrey writes "Gen. 4:16, 17"; searching for "4:17" found nothing, so the
    // excerpt fell back to the entry's opening and cut the argument off.
    const { findVerseMention } = await import('../src/utils/studyHelper.js');
    assert.ok(findVerseMention('(Gen. 4:16, 17). What', 4, 17) >= 0);
    assert.ok(findVerseMention('2 Kings 14:2, 17, 23 (some', 14, 23) >= 0);
    assert.ok(findVerseMention('Gen 4:16-18 x', 4, 17) >= 0);
    assert.equal(findVerseMention('(Gen. 4:16, 17).', 4, 18), -1);
    assert.equal(findVerseMention('x 24:1 y', 4, 1), -1, '24:1 is not 4:1');
});

test('a Torrey hit returns his argument with its conclusion', async () => {
    // One chunk of the Cain chapter stopped before "Cain doubtless had his wife
    // before going to the Land of Nod", and the model inverted Genesis 4 to
    // fill the gap.
    const { torreyChapterText } = await import('../src/utils/aiChat.js');
    const cain = await difficultiesWrapper.getChapterParts('torrey', 'Where Did Cain Get His Wife?');
    const whole = torreyChapterText(cain, cain[0].id, 4500);
    assert.match(whole, /doubtless had his wife before going/);
    assert.match(whole, /married his own sister/);
    assert.doesNotMatch(whole, /not shown/, 'the Cain chapter fits whole');

    // A long chapter comes back as a marked window, never silently truncated.
    const ret = await difficultiesWrapper.getChapterParts('torrey', 'Were Jesus and Paul Mistaken as to the Time of Our Lord\u2019s Return?');
    assert.ok(ret.length > 3);
    const mid = torreyChapterText(ret, ret[4].id, 4500);
    assert.match(mid, /^\[\.\.\.earlier part/);
    assert.match(mid, /not shown\.\.\.\]$/);
});

test('moral objections are routed to lookup_difficulty', async () => {
    // "How can a loving God command the slaughter of the Canaanites?" was
    // answered from memory; the routing named only contradictions.
    const src = await readFile(new URL('../src/utils/aiChat.js', import.meta.url), 'utf8');
    assert.match(src, /INCLUDING a MORAL objection[\s\S]{0,400}Canaanites[\s\S]{0,400}call lookup_difficulty FIRST/);
});

test('a topic with a chapter number still reaches the topic', async () => {
    // "Jephthah's daughter sacrifice Judges 11" parsed "Judges 11", took the
    // by-verse path, checked verse 1, missed, and the bot went to the web.
    const { toolLookupDifficulty } = await import('../src/utils/aiChat.js');
    const out = await toolLookupDifficulty({ query: "Jephthah's daughter sacrifice Judges 11" });
    assert.match(out, /Torrey/);
    assert.match(out, /Jephthah/);
    // and a chapter-only reference matches anything in that chapter
    const rows = await difficultiesWrapper.getForVerse(7, 11, null, { limit: 5 });
    assert.ok(rows.some(r => /Jephthah/.test(r.title)));
});

test('attribution is limited to the source\'s own verses', async () => {
    const src = await readFile(new URL('../src/utils/aiChat.js', import.meta.url), 'utf8');
    assert.match(src, /THE SAME GOES FOR VERSE REFERENCES/);
    assert.match(src, /Attribute to Torrey ONLY the verses that appear in this text/);
});
