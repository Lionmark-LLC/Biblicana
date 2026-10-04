// src/deploy.js and src/pruneGuildData.js must refuse to act on production
// unless BIBLICANA_ALLOW_PROD=1. The unit tests pin what counts as prod; the
// spawned tests prove the real scripts refuse BEFORE touching Discord or the
// database.
//
// Spawned scripts run with cwd set to an empty temp dir and a hand-built env,
// so dotenv finds no .env and nothing from the developer's shell (including a
// BIBLICANA_ALLOW_PROD they may have exported) leaks in. Every token here is
// fake. The override is never exercised against a network path: `--help` (deploy) and
// a missing DISCORDTOKEN (prune) both stop the script right after the guard.
//
// NOTE: test names stay ASCII (see the note in heartbeat.test.js).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
    PROD_CLIENT_ID, PROD_NEON_ENDPOINT, prodTargets, prodAllowed,
    tokenApplicationId, refuseProdUnlessAllowed,
} from '../src/utils/prodGuard.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const TEST_CLIENT_ID = '1167893380341178418';
const PROD_HOST = `${PROD_NEON_ENDPOINT}.us-east-1.aws.neon.tech`;
const DEV_HOST = 'ep-some-other-endpoint-a4r049db.us-east-1.aws.neon.tech';
const fakeToken = id => `${Buffer.from(id).toString('base64').replace(/=+$/, '')}.GxYzAb.fake-signature`;

// --- what counts as prod ------------------------------------------------------

test('a test-bot env is not prod', () => {
    assert.deepEqual(prodTargets({ CLIENTID: TEST_CLIENT_ID, DISCORDTOKEN: fakeToken(TEST_CLIENT_ID), PGHOST: DEV_HOST }), []);
    assert.deepEqual(prodTargets({}), []);
});

test('the prod CLIENTID is prod', () => {
    assert.equal(prodTargets({ CLIENTID: PROD_CLIENT_ID }).length, 1);
    assert.equal(prodTargets({ CLIENTID: ` ${PROD_CLIENT_ID} ` }).length, 1, 'whitespace from a KEY = VALUE line');
});

test('the prod Neon endpoint is prod under every host form', () => {
    for (const host of [PROD_HOST, `${PROD_NEON_ENDPOINT}-pooler.us-east-1.aws.neon.tech`,
        `${PROD_NEON_ENDPOINT}-hnw.us-east-1.aws.neon.tech`, PROD_HOST.toUpperCase()]) {
        assert.equal(prodTargets({ PGHOST: host }).length, 1, host);
    }
    assert.deepEqual(prodTargets({ PGHOST: `x${PROD_HOST}` }), [], 'prefix match only');
});

test('a prod bot token is prod even beside a test CLIENTID', () => {
    // pruneGuildData logs in with DISCORDTOKEN alone and never reads CLIENTID.
    assert.equal(tokenApplicationId(fakeToken(PROD_CLIENT_ID)), PROD_CLIENT_ID);
    const reasons = prodTargets({ CLIENTID: TEST_CLIENT_ID, DISCORDTOKEN: fakeToken(PROD_CLIENT_ID) });
    assert.equal(reasons.length, 1);
    assert.match(reasons[0], /DISCORDTOKEN/);
});

test('an unparseable token is not treated as prod or as an error', () => {
    for (const t of [undefined, '', 'garbage', '...', 'bm90LWFuLWlk.x.y']) {
        assert.equal(tokenApplicationId(t), null, String(t));
    }
});

test('only BIBLICANA_ALLOW_PROD=1 exactly unlocks prod', () => {
    assert.equal(prodAllowed({ BIBLICANA_ALLOW_PROD: '1' }), true);
    for (const v of [undefined, '', '0', 'true', 'yes', ' 1']) {
        assert.equal(prodAllowed({ BIBLICANA_ALLOW_PROD: v }), false, String(v));
    }
});

test('refuseProdUnlessAllowed exits non-zero on prod and passes otherwise', () => {
    const run = env => {
        const out = { code: null, msg: '' };
        refuseProdUnlessAllowed('x.js', env, { exit: c => { out.code = c; }, write: m => { out.msg += m; } });
        return out;
    };
    const refused = run({ CLIENTID: PROD_CLIENT_ID });
    assert.equal(refused.code, 2);
    assert.match(refused.msg, /Refusing to run x\.js against production/);
    assert.match(refused.msg, /BIBLICANA_ALLOW_PROD=1/);

    const allowed = run({ CLIENTID: PROD_CLIENT_ID, BIBLICANA_ALLOW_PROD: '1' });
    assert.equal(allowed.code, null);
    assert.match(allowed.msg, /acting on PRODUCTION/);

    const dev = run({ CLIENTID: TEST_CLIENT_ID });
    assert.equal(dev.code, null);
    assert.equal(dev.msg, '');
});

// --- the real scripts ---------------------------------------------------------

const emptyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'biblicana-prodguard-'));

function runScript(script, env, args = []) {
    const r = spawnSync(process.execPath, [path.join(ROOT, script), ...args], {
        cwd: emptyDir,
        env: { PATH: process.env.PATH, HOME: emptyDir, LOGLEVEL: 'info', ...env },
        encoding: 'utf8',
        timeout: 30_000,
    });
    return { code: r.status, out: `${r.stdout}${r.stderr}` };
}

test('deploy.js refuses the prod CLIENTID before reaching Discord', () => {
    const r = runScript('src/deploy.js', {
        CLIENTID: PROD_CLIENT_ID, GUILDID: '1', DISCORDTOKEN: fakeToken(TEST_CLIENT_ID),
    }, ['--global', '--rm']);
    assert.equal(r.code, 2, r.out);
    assert.match(r.out, /Refusing to run src\/deploy\.js against production/);
    assert.doesNotMatch(r.out, /Attempting to/, 'must stop before the PUT');
});

test('deploy.js refuses a prod PGHOST', () => {
    const r = runScript('src/deploy.js', { CLIENTID: TEST_CLIENT_ID, PGHOST: PROD_HOST });
    assert.equal(r.code, 2, r.out);
    assert.match(r.out, /PGHOST is the prod Neon endpoint/);
});

test('deploy.js passes the guard with the override', () => {
    // --help exits inside yargs, after the guard and before any command loads.
    const r = runScript('src/deploy.js', { CLIENTID: PROD_CLIENT_ID, BIBLICANA_ALLOW_PROD: '1' }, ['--help']);
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /acting on PRODUCTION/);
    assert.match(r.out, /--global/);
});

test('deploy.js exits non-zero when the upload fails', () => {
    // No DISCORDTOKEN: discord.js's REST throws "Expected token to be set"
    // locally, before any request, so this exercises the failure path offline.
    // It used to log the error and exit 0.
    const r = runScript('src/deploy.js', { CLIENTID: TEST_CLIENT_ID, GUILDID: '1' });
    assert.match(r.out, /Error during command deployment/, r.out);
    assert.equal(r.code, 1, r.out);
});

test('publishLegal.js refuses a prod PGHOST before fetching or connecting', () => {
    const r = runScript('src/publishLegal.js', { PGHOST: PROD_HOST, PGUSER: 'x', PGPASSWORD: 'x', PGDATABASE: 'x' }, ['privacy', '1']);
    assert.equal(r.code, 2, r.out);
    assert.match(r.out, /Refusing to run src\/publishLegal\.js against production/);
    assert.doesNotMatch(r.out, /Fetched|Published/, 'must stop before any network step');
});

test('pruneGuildData.js refuses a prod PGHOST before connecting', () => {
    const r = runScript('src/pruneGuildData.js', {
        PGHOST: PROD_HOST, PGUSER: 'x', PGPASSWORD: 'x', PGDATABASE: 'x', DISCORDTOKEN: fakeToken(TEST_CLIENT_ID),
    }, ['--apply']);
    assert.equal(r.code, 2, r.out);
    assert.match(r.out, /Refusing to run src\/pruneGuildData\.js against production/);
    assert.doesNotMatch(r.out, /\[Prune\]/, 'must stop before any prune step');
});

test('pruneGuildData.js refuses the prod token and the prod CLIENTID', () => {
    for (const env of [{ DISCORDTOKEN: fakeToken(PROD_CLIENT_ID) }, { CLIENTID: PROD_CLIENT_ID }]) {
        const r = runScript('src/pruneGuildData.js', { PGHOST: DEV_HOST, ...env }, ['--apply']);
        assert.equal(r.code, 2, r.out);
        assert.doesNotMatch(r.out, /\[Prune\]/);
    }
});

test('pruneGuildData.js passes the guard with the override', () => {
    // No DISCORDTOKEN: the script's own first check exits 1 before any connection,
    // which proves the guard let it through.
    const r = runScript('src/pruneGuildData.js', { PGHOST: PROD_HOST, BIBLICANA_ALLOW_PROD: '1' });
    assert.equal(r.code, 1, r.out);
    assert.match(r.out, /acting on PRODUCTION/);
    assert.match(r.out, /DISCORDTOKEN missing/);
});
