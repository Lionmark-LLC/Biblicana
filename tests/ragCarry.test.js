// Grounding must survive pushback that does not repeat the reference.
//
// Asked about 2 Sam 21:19, the bot was handed Clarke's note on turns that
// named the verse. The turn in between - "the Septuagint also says Goliath",
// plus a line of Greek - named no English reference, so it got NO grounding at
// all, on exactly the turn under most pressure. ragSourceText falls back to the
// most recent earlier USER turn that cites a verse.
import './helpers/fixtureData.js'; // imports the data wrappers indirectly
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ragSourceText } from '../src/utils/aiChat.js';

const goliathMemory = [
    { role: 'user', content: 'Adama: who slew Goliath in the bible?' },
    { role: 'assistant', content: 'David slew Goliath (1 Sam 17:50).' },
    { role: 'user', content: 'Adama: What about 2 Samuel 21:19' },
    { role: 'assistant', content: 'The parallel in 1 Chr 20:5 reads Lahmi, the brother of Goliath.' },
];

test('a message that cites a verse grounds on itself', () => {
    const r = ragSourceText('Ironically the translation you cited of 2 Samuel 21:19 tampers with the text', goliathMemory);
    assert.equal(r.carried, false);
    assert.match(r.text, /tampers/);
});

test('pushback naming no verse carries the previous user reference', () => {
    const r = ragSourceText('the Septuagint also says slew Goliath', goliathMemory);
    assert.equal(r.carried, true);
    assert.match(r.text, /2 Samuel 21:19/);
});

test('assistant citations are never carried, only user turns', () => {
    // The last turn with a reference is the ASSISTANT's 1 Chr 20:5. Grounding
    // on it would swap the verse under discussion for the parallel.
    const r = ragSourceText('that is a weak argument', goliathMemory);
    assert.doesNotMatch(r.text, /1 Chr/);
    assert.match(r.text, /2 Samuel 21:19/);
});

test('lookback is bounded to the two most recent user turns', () => {
    const memory = [
        { role: 'user', content: 'What about 2 Samuel 21:19' },
        { role: 'assistant', content: 'ok' },
        { role: 'user', content: 'thanks' },
        { role: 'assistant', content: 'ok' },
        { role: 'user', content: 'and another thing' },
        { role: 'assistant', content: 'ok' },
    ];
    const r = ragSourceText('one more point', memory);
    assert.equal(r.carried, false);
    assert.equal(r.text, 'one more point');
});

test('no memory and no reference returns the message unchanged', () => {
    const r = ragSourceText('hello there', []);
    assert.deepEqual(r, { text: 'hello there', carried: false });
});
