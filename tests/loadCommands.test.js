// A deploy PUT replaces the whole command set, so a command that fails to
// load must stop the deploy rather than be silently left out (which deletes
// it from every server). loadCommands reports failures; deploy.js refuses on
// any. Fixtures are written to a temp dir, never into src/commands.
//
// NOTE: test names stay ASCII (see the note in heartbeat.test.js).

import './helpers/fixtureData.js'; // imports the data wrappers indirectly
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { loadCommands } from '../src/utils/loadCommands.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

function fixtureDir(files) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'biblicana-cmds-'));
    for (const [name, src] of Object.entries(files)) fs.writeFileSync(path.join(dir, name), src);
    return dir;
}

const good = name => `export default { data: { toJSON: () => ({ name: '${name}' }) } };\n`;

test('a clean directory loads every command with no failures', async () => {
    const dir = fixtureDir({ 'a.js': good('a'), 'b.js': good('b'), 'notes.txt': 'ignored' });
    const r = await loadCommands(dir);
    assert.deepEqual(r.commands.map(c => c.name), ['a', 'b']);
    assert.deepEqual(r.failures, []);
});

test('every kind of broken command file is reported by name', async () => {
    const dir = fixtureDir({
        'ok.js': good('ok'),
        'throws.js': "throw new Error('boom at import');\n",
        'syntax.js': 'export default {\n',
        'nodata.js': 'export default { execute() {} };\n',
        'badjson.js': "export default { data: { toJSON() { throw new Error('bad option'); } } };\n",
    });
    const r = await loadCommands(dir);
    assert.deepEqual(r.commands.map(c => c.name), ['ok']);
    assert.deepEqual(r.failures.map(f => f.file).sort(), ['badjson.js', 'nodata.js', 'syntax.js', 'throws.js']);
    assert.match(r.failures.find(f => f.file === 'throws.js').reason, /boom at import/);
    assert.match(r.failures.find(f => f.file === 'nodata.js').reason, /data\.toJSON/);
});

test('dev-only commands are skipped globally, not failed, and kept for a guild', async () => {
    const dir = fixtureDir({
        'pub.js': good('pub'),
        'dev.js': "export default { devOnly: true, data: { toJSON: () => ({ name: 'dev' }) } };\n",
    });
    const g = await loadCommands(dir, { global: true });
    assert.deepEqual(g.commands.map(c => c.name), ['pub']);
    assert.deepEqual(g.skipped, ['dev.js']);
    assert.deepEqual(g.failures, []);
    const local = await loadCommands(dir);
    assert.deepEqual(local.commands.map(c => c.name).sort(), ['dev', 'pub']);
});

test('the real src/commands loads with zero failures', async () => {
    // What deployg would upload today. A failure here would make deploy.js
    // refuse, which is the point, but it should be caught in CI first.
    const r = await loadCommands(path.join(ROOT, 'src/commands'), { global: true });
    assert.deepEqual(r.failures.map(f => `${f.file}: ${f.reason}`), []);
    assert.ok(r.commands.length >= 30, `only ${r.commands.length} commands loaded`);
    assert.deepEqual(r.skipped, ['testwelcome.js']);
});

test('deploy.js refuses to upload when any command fails to load', () => {
    // End to end against the real script. A module hook, preloaded with
    // --import, makes src/commands/stats.js throw on import; nothing on disk
    // changes. No DISCORDTOKEN, so even a broken refusal could not reach
    // Discord: it would fail on the missing token with a different message.
    const hooks = fixtureDir({
        'hooks.mjs': `export async function load(url, context, next) {
    if (url.endsWith('/src/commands/stats.js')) {
        return { format: 'module', shortCircuit: true, source: "throw new Error('injected load failure');" };
    }
    return next(url, context);
}
`,
        'register.mjs': `import { register } from 'node:module';
register('./hooks.mjs', import.meta.url);
`,
    });
    const r = spawnSync(process.execPath,
        ['--import', pathToFileURL(path.join(hooks, 'register.mjs')).href, path.join(ROOT, 'src/deploy.js'), '--global'],
        { cwd: hooks, env: { PATH: process.env.PATH, HOME: hooks, LOGLEVEL: 'info', CLIENTID: '1167893380341178418' }, encoding: 'utf8', timeout: 60_000 });
    const out = `${r.stdout}${r.stderr}`;
    assert.equal(r.status, 1, out);
    assert.match(out, /Failed to load src\/commands\/stats\.js: injected load failure/);
    assert.match(out, /Refusing to upload: 1 command file\(s\) failed to load \(stats\.js\)/);
    assert.doesNotMatch(out, /Attempting to|Error during command deployment/, 'must stop before the upload');
});
