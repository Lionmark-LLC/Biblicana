// The version on every card comes from package.json, not a hand-edited .env.
//
// EMBEDFOOTERTEXT was a second copy of the version living only in the
// droplet's .env; it shipped stale at v1.6.0 and read v1.5.1 in prod. The
// footer now derives from package.json, and EMBEDFOOTERTEXT (still set on prod
// until Kenneth removes it) overrides it whole.
//
// NOTE: test names stay ASCII (see the note in heartbeat.test.js).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { APP_VERSION, defaultFooter, footerFor, footerText, footerLine } from '../src/utils/theme.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));

test('the version is package.json version', () => {
    assert.equal(APP_VERSION, pkg.version);
    assert.match(APP_VERSION, /^\d+\.\d+\.\d+/);
});

test('with no override the footer carries the version in prod wording', () => {
    // Prod's EMBEDFOOTERTEXT reads "Biblicana v1.6.1 by BlueBerean"; removing
    // it must change nothing but keeping the version current.
    assert.equal(footerFor({}, '1.6.1'), 'Biblicana v1.6.1 by BlueBerean');
    assert.equal(footerFor({}, '1.7.0'), 'Biblicana v1.7.0 by BlueBerean');
    assert.equal(defaultFooter(), `Biblicana v${pkg.version} by BlueBerean`);
});

test('EMBEDFOOTERTEXT overrides the whole footer, blank does not', () => {
    assert.equal(footerFor({ EMBEDFOOTERTEXT: 'Biblicana v1.2 by BlueBerean (LOCAL DEV)' }, '9.9.9'),
        'Biblicana v1.2 by BlueBerean (LOCAL DEV)');
    for (const blank of ['', '   ']) {
        assert.equal(footerFor({ EMBEDFOOTERTEXT: blank }, '1.7.0'), 'Biblicana v1.7.0 by BlueBerean', JSON.stringify(blank));
    }
});

test('footerText and footerLine read the live environment', () => {
    const saved = process.env.EMBEDFOOTERTEXT;
    try {
        delete process.env.EMBEDFOOTERTEXT;
        assert.equal(footerText(), `Biblicana v${pkg.version} by BlueBerean`);
        assert.equal(footerLine('Translation: BSB'), `-# Biblicana v${pkg.version} by BlueBerean | Translation: BSB`);
        process.env.EMBEDFOOTERTEXT = 'Custom';
        assert.equal(footerLine(), '-# Custom');
    } finally {
        if (saved === undefined) delete process.env.EMBEDFOOTERTEXT;
        else process.env.EMBEDFOOTERTEXT = saved;
    }
});

test('no code reads EMBEDFOOTERTEXT except theme.js', () => {
    // A direct read with its own fallback would show a footer without the
    // version wherever the variable is unset.
    const offenders = [];
    const walk = d => {
        for (const e of fs.readdirSync(d, { withFileTypes: true })) {
            const p = path.join(d, e.name);
            if (e.isDirectory()) walk(p);
            else if (e.name.endsWith('.js') && p !== path.join(ROOT, 'src/utils/theme.js')
                && /EMBEDFOOTERTEXT/.test(fs.readFileSync(p, 'utf8'))) offenders.push(path.relative(ROOT, p));
        }
    };
    walk(path.join(ROOT, 'src'));
    assert.deepEqual(offenders, []);
});
