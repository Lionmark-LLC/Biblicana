// Data files open read-only, and a missing one is an ERROR, never created.
//
// The wrappers used to pass `readOnly: true`, which the sqlite package does not
// read (it reads only `mode`), so they opened READ-WRITE with CREATE: a missing
// file was silently created empty and failed later as "no such table". A fresh
// clone running the suite left eight empty databases in data/.
//
// NOTE: test names stay ASCII (see the note in heartbeat.test.js).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import log from 'loglevel';

import { openRequired, openOptional, dataFile } from '../src/utils/dataFiles.js';
import sqlite3 from 'sqlite3';

log.setLevel('silent');
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const emptyDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'biblicana-nodata-'));

test('a missing required file rejects with its name and is not created', async () => {
    const dir = emptyDir();
    process.env.BIBLICANADATADIR = dir;
    await assert.rejects(openRequired('bible.db'), /data\/bible\.db could not be opened read-only/);
    assert.equal(fs.existsSync(path.join(dir, 'bible.db')), false, 'must not be created');
    assert.deepEqual(fs.readdirSync(dir), []);
});

test('a missing optional file resolves null and is not created', async () => {
    const dir = emptyDir();
    process.env.BIBLICANADATADIR = dir;
    assert.equal(await openOptional('bsb_footnotes.sqlite', 'test'), null);
    assert.deepEqual(fs.readdirSync(dir), []);
});

test('an opened data file is read-only', async () => {
    const dir = emptyDir();
    const seed = new sqlite3.Database(path.join(dir, 'bible.db'));
    await new Promise((res, rej) => seed.exec("CREATE TABLE english (v TEXT); INSERT INTO english VALUES ('x');", e => (e ? rej(e) : seed.close(res))));
    process.env.BIBLICANADATADIR = dir;
    assert.equal(dataFile('bible.db'), path.join(dir, 'bible.db'));
    const db = await openRequired('bible.db');
    try {
        assert.equal((await db.get('SELECT COUNT(*) AS n FROM english')).n, 1);
        await assert.rejects(db.run('DELETE FROM english'), /SQLITE_READONLY/);
    } finally {
        await db.close();
    }
});

test('the real wrappers survive missing files, fail per query, and create nothing', () => {
    // Every wrapper opens at import. With an empty data dir the process must
    // not die of an unhandled rejection, each query must name the missing
    // file, and the directory must stay empty.
    const dir = emptyDir();
    const script = `
        const { bibleWrapper } = await import(${JSON.stringify(pathToFileURL(path.join(ROOT, 'src/utils/bibleHelper.js')).href)});
        const study = await import(${JSON.stringify(pathToFileURL(path.join(ROOT, 'src/utils/studyHelper.js')).href)});
        await new Promise(r => setTimeout(r, 200));
        try { await bibleWrapper.getVerses(43, 3, 16, 16); console.log('NO ERROR'); }
        catch (e) { console.log('QUERY ERROR: ' + e.message); }
        console.log('FOOTNOTES ' + JSON.stringify(await study.bsbFootnotesWrapper.getNotes(10, 21, 19)));
    `;
    const r = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
        cwd: dir, env: { PATH: process.env.PATH, HOME: dir, BIBLICANADATADIR: dir }, encoding: 'utf8', timeout: 30_000,
    });
    const out = `${r.stdout}${r.stderr}`;
    assert.equal(r.status, 0, out);
    assert.match(out, /QUERY ERROR: data\/bible\.db could not be opened read-only/);
    assert.match(out, /FOOTNOTES \[\]/, 'an optional file degrades to nothing');
    assert.deepEqual(fs.readdirSync(dir), [], 'no data file may be created');
});

test('no runtime code opens SQLite except through dataFiles.js', () => {
    // The offline builders (src/build*.js) write their own outputs and are exempt.
    const offenders = [];
    const walk = d => {
        for (const e of fs.readdirSync(d, { withFileTypes: true })) {
            const p = path.join(d, e.name);
            if (e.isDirectory()) { walk(p); continue; }
            if (!e.name.endsWith('.js') || /^build[A-Z]/.test(e.name) || e.name === 'dataFiles.js') continue;
            const src = fs.readFileSync(p, 'utf8');
            if (/from 'sqlite'|new sqlite3\.Database|readOnly\s*:/.test(src)) offenders.push(path.relative(ROOT, p));
        }
    };
    walk(path.join(ROOT, 'src'));
    assert.deepEqual(offenders, []);
});
