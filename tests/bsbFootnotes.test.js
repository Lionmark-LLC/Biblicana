// The BSB's translator footnotes must reach the model.
//
// bible.db holds the BSB as plain verse text. Asked whether the BSB
// "tampered" with 2 Sam 21:19 by adding "the brother of", the bot could not see
// the BSB's own footnote disclosing exactly that, and guessed - once in each
// direction. data/bsb_footnotes.sqlite (src/buildBsbFootnotes.js) restores it.
import './helpers/fixtureData.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import log from 'loglevel';
log.setLevel('error');
const { bsbFootnotesWrapper } = await import('../src/utils/studyHelper.js');

test('2 Sam 21:19 carries the note disclosing the supplied words', async () => {
    const notes = await bsbFootnotesWrapper.getNotes(10, 21, 19);
    assert.ok(notes.some(n => /does not include the brother of/i.test(n.text)), JSON.stringify(notes));
});

test('a range returns notes for every verse in it, in order', async () => {
    const notes = await bsbFootnotesWrapper.getNotes(1, 1, 1, 6);
    assert.ok(notes.length >= 2);
    const verses = notes.map(n => n.verse);
    assert.deepEqual(verses, [...verses].sort((a, b) => a - b));
});
