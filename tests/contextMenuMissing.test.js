// The three message context-menu commands say WHY a reference does not exist.
//
// After the versification check reached them they refused "Romans 17:1" with a
// generic "no valid references" line, while the 📖 reaction on the same message
// explained it ("Romans has 16 chapters, so there is no Romans 17."). These
// drive each command's execute() with a fake interaction and read the reply.
// Every case here returns before the defer, so nothing touches the database.
//
// NOTE: test names stay ASCII (see the note in heartbeat.test.js).

import './helpers/fixtureData.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import log from 'loglevel';
log.setLevel('error');

const { default: lookup } = await import('../src/commands/ctxLookupScripture.js');
const { default: commentary } = await import('../src/commands/ctxShowCommentary.js');
const { default: interlinear } = await import('../src/commands/ctxShowInterlinear.js');

const COMMANDS = { lookup, commentary, interlinear };

function fakeInteraction(content, embeds = []) {
    const calls = [];
    return {
        calls,
        targetMessage: { content, embeds },
        user: { id: '1' },
        reply: async payload => { calls.push(['reply', payload]); },
        deferReply: async payload => { calls.push(['deferReply', payload]); },
    };
}

async function run(cmd, content, embeds) {
    const i = fakeInteraction(content, embeds);
    await cmd.execute(i, {});
    assert.equal(i.calls.length, 1, 'answers once, before any defer');
    assert.equal(i.calls[0][0], 'reply');
    return i.calls[0][1].content;
}

for (const [name, cmd] of Object.entries(COMMANDS)) {
    test(`${name}: a chapter past the end of the book says how many there are`, async () => {
        assert.equal(await run(cmd, 'see Romans 17:1'), '🔍 Romans has 16 chapters, so there is no Romans 17.');
    });

    test(`${name}: a verse past the end of the chapter says how many there are`, async () => {
        assert.equal(await run(cmd, 'Matthew 28:21'), '🔍 Matthew 28 has 20 verses, so there is no Matthew 28:21.');
    });

    test(`${name}: Psalm 151 is pointed at the Septuagint`, async () => {
        assert.match(await run(cmd, 'Psalm 151'), /150 chapters.*Septuagint/);
    });

    test(`${name}: a missing reference in an embed is explained too`, async () => {
        assert.match(await run(cmd, '', [{ title: 'John 22:1' }]), /John has 21 chapters/);
    });

    test(`${name}: a message with no references keeps its own reply`, async () => {
        assert.doesNotMatch(await run(cmd, 'hello there'), /so there is no/);
    });
}

test('the verse-level reference is the one explained when there are several', async () => {
    assert.equal(await run(lookup, 'Acts 29 and Romans 16:28'), '🔍 Romans 16 has 27 verses, so there is no Romans 16:28.');
});

test('commentary and interlinear: an existing chapter-only reference keeps the verse-level hint', async () => {
    // Psalm 23 exists, so this is not a missing reference: it is the wrong kind.
    assert.match(await run(commentary, 'Psalm 23'), /verse-level reference/);
    assert.match(await run(interlinear, 'Psalm 23'), /verse-level reference/);
});
