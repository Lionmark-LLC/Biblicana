// `pnpm run legal:publish` copies a legal version from the live site into Neon.
// These pin its checks (src/utils/legalPublish.js); the prod-guard refusal is
// in prodGuard.test.js with the other admin scripts.
//
// NOTE: test names stay ASCII (see the note in heartbeat.test.js).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseLegalFile, planPublish, legalFileUrl, sha256 } from '../src/utils/legalPublish.js';

// The shape blueberean-site writes (legal/privacy/v1.md), abridged.
const V1 = `---
document: privacy
title: Privacy Policy
version: 1
effective: 2026-09-29T00:00:00Z
level: material
summary: >-
  We now use Sentry to receive error reports and performance data from the bot,
  with message text removed, and the website moved from Vercel to Cloudflare.
---

This Privacy Policy describes how **Lionmark LLC** ...

## 1. Information we collect
`;
const file = (version, { level = 'notice', effective = '2026-12-01T00:00:00Z', summary = 'Clearer wording.' } = {}) =>
    V1.replace('version: 1', `version: ${version}`).replace('level: material', `level: ${level}`)
        .replace('effective: 2026-09-29T00:00:00Z', `effective: ${effective}`)
        .replace(/summary: >-\n[\s\S]*?\n---/, `summary: ${summary}\n---`);
const NOW = Date.parse('2026-10-05T00:00:00Z');

test('a site file parses into what Neon stores', () => {
    const p = parseLegalFile(V1);
    assert.equal(p.document, 'privacy');
    assert.equal(p.version, 1);
    assert.equal(p.effectiveAt, '2026-09-29T00:00:00.000Z');
    assert.equal(p.level, 'material');
    assert.equal(p.summary, 'We now use Sentry to receive error reports and performance data from the bot, with message text removed, and the website moved from Vercel to Cloudflare.');
    assert.ok(p.body.startsWith('This Privacy Policy describes'), 'body starts after the blank line');
    assert.equal(p.bodySha256, sha256(p.body));
    assert.equal(legalFileUrl('privacy', 1), 'https://www.blueberean.com/legal/privacy/v1.md');
});

test('malformed files are refused', () => {
    assert.throws(() => parseLegalFile('no frontmatter'), /frontmatter/);
    assert.throws(() => parseLegalFile(V1.replace('level: material', 'level: big')), /level/);
    assert.throws(() => parseLegalFile(V1.replace('effective: 2026-09-29T00:00:00Z', 'effective: 2026-09-29')), /timezone/);
    assert.throws(() => parseLegalFile(file(2, { summary: 'x'.repeat(401) })), /summary/);
});

test('version 1 of a document publishes even though it took effect in the past', () => {
    assert.deepEqual(planPublish({ parsed: parseLegalFile(V1), requested: { document: 'privacy', version: 1 }, existing: [], now: NOW }), { action: 'insert' });
});

test('re-running with the same text is a no-op; different text is refused', () => {
    const parsed = parseLegalFile(V1);
    const existing = [{ version: 1, effectiveAt: parsed.effectiveAt, bodySha256: parsed.bodySha256 }];
    assert.equal(planPublish({ parsed, requested: { document: 'privacy', version: 1 }, existing, now: NOW }).action, 'already');
    const changed = [{ ...existing[0], bodySha256: 'f'.repeat(64) }];
    assert.match(planPublish({ parsed, requested: { document: 'privacy', version: 1 }, existing: changed, now: NOW }).reason, /new version/);
});

test('versions must be the next one, later, and named as requested', () => {
    const v1 = parseLegalFile(V1);
    const existing = [{ version: 1, effectiveAt: v1.effectiveAt, bodySha256: v1.bodySha256 }];
    assert.match(planPublish({ parsed: parseLegalFile(file(3)), requested: { document: 'privacy', version: 3 }, existing, now: NOW }).reason, /next privacy version is v2/);
    assert.match(planPublish({ parsed: parseLegalFile(file(2, { effective: '2026-09-01T00:00:00Z' })), requested: { document: 'privacy', version: 2 }, existing, now: NOW }).reason, /later than v1/);
    assert.match(planPublish({ parsed: parseLegalFile(file(2)), requested: { document: 'terms', version: 2 }, existing, now: NOW }).reason, /not terms v2/);
    assert.equal(planPublish({ parsed: parseLegalFile(file(2)), requested: { document: 'privacy', version: 2 }, existing, now: NOW }).action, 'insert');
});

test('a material change cannot take effect before it is published', () => {
    const v1 = parseLegalFile(V1);
    const existing = [{ version: 1, effectiveAt: v1.effectiveAt, bodySha256: v1.bodySha256 }];
    const past = parseLegalFile(file(2, { level: 'material', effective: '2026-10-01T00:00:00Z' }));
    assert.match(planPublish({ parsed: past, requested: { document: 'privacy', version: 2 }, existing, now: NOW }).reason, /in the past/);
    const future = parseLegalFile(file(2, { level: 'material', effective: '2026-10-20T00:00:00Z' }));
    assert.equal(planPublish({ parsed: future, requested: { document: 'privacy', version: 2 }, existing, now: NOW }).action, 'insert');
});
