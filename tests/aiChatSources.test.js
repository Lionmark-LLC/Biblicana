// The Sources panel must reflect what a tool FOUND, not what it was asked.
//
// Someone asked "who is Peter". The person search missed, the answer honestly
// said the dataset had no entry - and the Sources panel underneath listed
// "Biblical figure: Peter (Simon Peter)" as though it were a source. The panel
// exists so provenance is checkable; one that contradicts the answer is worse
// than none at all.
//
// The fix leans on a CONVENTION - every tool signals a miss with a string
// starting "Error" or "No " - which is a promise across ~30 return statements
// with nothing enforcing it. So this scans the source. A new tool that invents
// a different failure shape would otherwise reintroduce the bug silently, and
// silently is exactly how it survived the first time.
//
// NOTE: test names stay ASCII - prod's Node 18.13 TAP lexer dies on non-ASCII
// in a test() description and reports the whole file as 0 passed.

import './helpers/fixtureData.js'; // imports the data wrappers indirectly
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import log from 'loglevel';

log.setLevel('error');

import { toolFoundSomething } from '../src/utils/aiChat.js';

test('a miss is not recorded as a source', () => {
    for (const miss of [
        'No biblical figure named "Simon Peter" in the dataset. Say so rather than answering from memory.',
        'No commentary found for John 3:16 from Calvin.',
        'No Septuagint text for Matthew 1:1.',
        'No cross-references found for Jude 1:5.',
        'No exact topic "joy". Closest indexed topics: gladness.',
        'Error: provide a "reference" like "John 3:16".',
        'Error running lookup_person: boom',
    ]) {
        assert.equal(toolFoundSomething(miss), false, `should be treated as a miss: ${miss.slice(0, 50)}`);
    }
});

test('a real result IS recorded', () => {
    for (const hit of [
        'Biblical figure "Peter" — Peter (first mentioned Mat.4.18): the apostle.',
        'Adam Clarke, from his Commentary on the Bible, on John 3:16: "..."',
        'John 3:16 (BSB): For God so loved the world...',
    ]) {
        assert.equal(toolFoundSomething(hit), true, `should count as a source: ${hit.slice(0, 50)}`);
    }
});

test('a name beginning with No is not mistaken for a miss', () => {
    // "No" is matched as a whole word precisely so Noah, Nod and Nob survive.
    assert.equal(toolFoundSomething('Biblical figure "Noah" — Noah (first mentioned Gen.5.29): built the ark.'), true);
    assert.equal(toolFoundSomething('Place "Nod" — east of Eden.'), true);
});

test('every tool failure return follows the convention the panel depends on', async () => {
    // The structural guard. Collects the literal strings this file returns on a
    // failure path and checks each one would be classed as a miss.
    const src = await readFile(new URL('../src/utils/aiChat.js', import.meta.url), 'utf8');

    // Returns of a template/quoted literal that the tools use to report failure.
    const returns = [...src.matchAll(/return\s+(`|')((?:No|Error)[^`']{0,160})\1/g)]
        .map(m => m[2]);

    assert.ok(returns.length > 15, `expected to find the failure returns, found ${returns.length}`);
    for (const literal of returns) {
        assert.equal(
            toolFoundSomething(literal), false,
            `this failure message would be recorded as a source: ${literal.slice(0, 70)}`
        );
    }
});
