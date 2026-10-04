// The AI-features acknowledgment gate reads published legal versions from Neon
// (legal_document_versions) instead of a hardcoded date. These tests pin the
// rules (src/utils/legalVersions.js decideAck), the cache and its fallbacks,
// the disclosure's "What changed", and the two buttons, including that "Got it"
// never satisfies a material version (Kenneth, 2026-10-03).
//
// NOTE: test names stay ASCII (see the note in heartbeat.test.js).

import './helpers/fixtureData.js'; // aichatAck imports aiChat, which loads the data wrappers
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import log from 'loglevel';

import {
    decideAck, getLegalVersions, resetLegalVersionsCache, FALLBACK_REQUIRED_AT,
} from '../src/utils/legalVersions.js';
import {
    checkAckStatus, buildAckDisclosurePayload, buildAckDisclosureV2, disclosureOptionsFor,
    parseAckCustomId, isAckButtonCurrent, buildLegalNoticePayload,
} from '../src/utils/aiAck.js';
import legalNotice from '../src/components/buttons/legalNotice.js';
import aichatAck from '../src/components/buttons/aichatAck.js';

log.setLevel('silent');
beforeEach(() => resetLegalVersionsCache());

const at = s => Date.parse(s);
const v = (document, version, level, effectiveAt, publishedAt = effectiveAt, summary = `${document} v${version} summary`) =>
    ({ document, version, level, effectiveAt, publishedAt, summary });

// The two rows legal:publish will insert first: v1 of each, published on
// 2026-10-04, effective on the dates the pages already carried.
const V1 = [
    v('privacy', 1, 'material', '2026-09-29T00:00:00.000Z', '2026-10-04T12:00:00.000Z'),
    v('terms', 1, 'material', '2026-04-23T00:00:00.000Z', '2026-10-04T12:00:00.000Z'),
];
const NOW = at('2026-10-05T00:00:00Z');

// --- decideAck ---------------------------------------------------------------

test('no acknowledgment blocks as first time', () => {
    const d = decideAck({ ackedAt: null, versions: V1, now: NOW });
    assert.equal(d.valid, false);
    assert.equal(d.reason, 'never');
});

test('switching to v1 changes nothing: same cutoff as TERMS_MIN_ACK_DATE, no notices', () => {
    // The regression this guards: v1 is PUBLISHED long after it took effect,
    // and comparing against published_at would send every user a notice.
    const ok = decideAck({ ackedAt: '2026-09-30T08:00:00.000Z', versions: V1, now: NOW });
    assert.equal(ok.valid, true);
    assert.deepEqual(ok.notices, []);
    assert.equal(ok.requiredAt, FALLBACK_REQUIRED_AT);
    const stale = decideAck({ ackedAt: '2026-09-28T23:59:59.999Z', versions: V1, now: NOW });
    assert.equal(stale.valid, false);
    assert.equal(stale.reason, 'stale');
    assert.equal(decideAck({ ackedAt: FALLBACK_REQUIRED_AT, versions: V1, now: NOW }).valid, true, 'the cutoff itself is valid');
});

test('a stale user is told what changed since their acknowledgment, newest first', () => {
    const d = decideAck({ ackedAt: '2026-05-01T00:00:00.000Z', versions: V1, now: NOW });
    assert.deepEqual(d.changes.map(c => `${c.document} v${c.version}`), ['privacy v1'], 'terms v1 predates the ack');
    const older = decideAck({ ackedAt: '2026-01-01T00:00:00.000Z', versions: V1, now: NOW });
    assert.deepEqual(older.changes.map(c => `${c.document} v${c.version}`), ['privacy v1', 'terms v1']);
});

test('a notice version shows once and never blocks; editorial never shows', () => {
    const versions = [...V1,
        v('privacy', 2, 'notice', '2026-10-10T00:00:00.000Z'),
        v('terms', 2, 'editorial', '2026-10-11T00:00:00.000Z')];
    const later = at('2026-10-12T00:00:00Z');
    const d = decideAck({ ackedAt: '2026-10-01T00:00:00.000Z', versions, now: later });
    assert.equal(d.valid, true);
    assert.deepEqual(d.notices.map(n => `${n.document} v${n.version}`), ['privacy v2']);
    assert.equal(d.notices[0].upcoming, false);
    // Got it records a new timestamp; the notice is gone.
    assert.deepEqual(decideAck({ ackedAt: '2026-10-12T00:00:00.000Z', versions, now: later }).notices, []);
});

test('a material change: heads-up during the notice period, then a block Got it cannot clear', () => {
    const versions = [...V1, v('terms', 2, 'material', '2026-11-20T00:00:00.000Z', '2026-11-01T00:00:00.000Z')];
    const during = at('2026-11-05T00:00:00Z');
    const before = decideAck({ ackedAt: '2026-10-01T00:00:00.000Z', versions, now: during });
    assert.equal(before.valid, true, 'the notice period does not block');
    assert.equal(before.notices.length, 1);
    assert.equal(before.notices[0].upcoming, true);

    // Got it during the notice period: the heads-up stops...
    const gotIt = '2026-11-05T00:00:00.000Z';
    assert.deepEqual(decideAck({ ackedAt: gotIt, versions, now: during }).notices, []);
    // ...but once the change takes effect, that click does not satisfy it.
    const after = at('2026-11-20T00:00:00Z'); // exactly the effective time counts as in effect
    const blocked = decideAck({ ackedAt: gotIt, versions, now: after });
    assert.equal(blocked.valid, false);
    assert.equal(blocked.reason, 'stale');
    assert.equal(blocked.requiredAt, '2026-11-20T00:00:00.000Z');
    assert.deepEqual(blocked.changes.map(c => `${c.document} v${c.version}`), ['terms v2']);
    // Only an Acknowledge after the effective time clears it.
    assert.equal(decideAck({ ackedAt: '2026-11-20T00:00:01.000Z', versions, now: after }).valid, true);
});

test('an unreadable stored timestamp is stale, never valid', () => {
    const d = decideAck({ ackedAt: 'garbage', versions: V1, now: NOW });
    assert.equal(d.valid, false);
    assert.equal(d.reason, 'stale');
});

test('at most three changes or notices are listed', () => {
    const versions = [1, 2, 3, 4, 5].map(n => v('privacy', n, 'material', `2026-0${n}-01T00:00:00.000Z`));
    assert.equal(decideAck({ ackedAt: '2025-01-01T00:00:00.000Z', versions, now: NOW }).changes.length, 3);
});

// --- getLegalVersions --------------------------------------------------------

function fakeDb({ rows = [], fail = false, user = null } = {}) {
    const db = {
        queries: 0, saved: null,
        async queryWithWakeRetry() { db.queries++; if (db.fail) throw new Error('connection refused'); return { rows: db.rows }; },
        async getUserValue() { if (db.userFail) throw new Error('db down'); return db.user; },
        async setUserValue(id, value) { db.saved = value; db.user = value; return true; },
        rows, fail, user, userFail: false,
    };
    return db;
}
const ROWS = [
    { document: 'privacy', version: 1, effective_at: new Date('2026-09-29T00:00:00Z'), published_at: new Date('2026-10-04T12:00:00Z'), change_level: 'material', summary: 'Sentry.' },
];

test('an empty table behaves exactly like the old constant', async () => {
    const { versions, source } = await getLegalVersions(fakeDb({ rows: [] }), { now: NOW });
    assert.equal(source, 'fallback');
    assert.equal(decideAck({ ackedAt: '2026-09-28T00:00:00.000Z', versions, now: NOW }).valid, false);
    assert.equal(decideAck({ ackedAt: '2026-09-29T00:00:00.000Z', versions, now: NOW }).valid, true);
});

test('versions are cached for ten minutes and refreshed only on demand', async () => {
    const db = fakeDb({ rows: ROWS });
    assert.equal((await getLegalVersions(db, { now: NOW })).source, 'neon');
    await getLegalVersions(db, { now: NOW + 9 * 60_000 });
    assert.equal(db.queries, 1, 'served from cache');
    await getLegalVersions(db, { now: NOW + 11 * 60_000 });
    assert.equal(db.queries, 2, 'refreshed after ten minutes');
});

test('a failed read keeps the last good copy, or falls back to the floor', async () => {
    const db = fakeDb({ rows: ROWS });
    await getLegalVersions(db, { now: NOW });
    db.fail = true;
    const stale = await getLegalVersions(db, { now: NOW + 11 * 60_000 });
    assert.equal(stale.source, 'cache');
    assert.equal(stale.versions[0].summary, 'Sentry.');
    resetLegalVersionsCache();
    const floor = await getLegalVersions(db, { now: NOW });
    assert.equal(floor.source, 'fallback');
    assert.equal(floor.versions[0].effectiveAt, FALLBACK_REQUIRED_AT);
});

test('after a failed read Neon is not asked again for a minute', async () => {
    const db = fakeDb({ rows: ROWS, fail: true });
    await getLegalVersions(db, { now: NOW });
    await getLegalVersions(db, { now: NOW + 30_000 });
    assert.equal(db.queries, 1, 'the fallback is held, not re-fetched on every gate check');
    db.fail = false;
    const later = await getLegalVersions(db, { now: NOW + 61_000 });
    assert.equal(db.queries, 2);
    assert.equal(later.source, 'neon', 'recovers once Neon answers');
});

test('checkAckStatus fails closed when the user record cannot be read', async () => {
    const db = fakeDb({ rows: ROWS });
    db.userFail = true;
    const s = await checkAckStatus(db, '123', { now: NOW });
    assert.equal(s.valid, false);
    assert.equal(s.reason, 'error');
});

// --- disclosure and buttons ----------------------------------------------------

const BIG = [1, 2, 3].map(n => v(n % 2 ? 'privacy' : 'terms', n, 'material', `2026-0${n}-01T00:00:00.000Z`, undefined, 'x'.repeat(400)));

test('the updated disclosure shows what changed, within Discord limits', () => {
    const ack = { valid: false, reason: 'stale', ackedAt: '2026-05-01T00:00:00.000Z', requiredAt: FALLBACK_REQUIRED_AT,
        changes: [v('privacy', 1, 'material', FALLBACK_REQUIRED_AT, undefined, 'We now use Sentry.')] };
    const plain = buildAckDisclosurePayload('42', disclosureOptionsFor(ack));
    assert.match(plain.content, /What changed:/);
    assert.match(plain.content, /Privacy Policy\*\* \(version 1, 2026-09-29\): We now use Sentry\./);
    assert.match(plain.content, /Privacy Policy\]\(/, 'links stay');

    // Worst case: three 400-character summaries.
    const worst = { ...ack, changes: BIG };
    assert.ok(buildAckDisclosurePayload('42', disclosureOptionsFor(worst)).content.length <= 2000, 'plain message limit');
    const v2Text = buildAckDisclosureV2('42', disclosureOptionsFor(worst))[0].toJSON().components[0].content;
    assert.ok(v2Text.length <= 4000, 'V2 text limit');
});

test('the Acknowledge button carries the requirement it was shown for', () => {
    const [, row] = buildAckDisclosureV2('42', { kind: 'first_time', requiredAt: '2026-11-20T00:00:00.000Z' });
    const id = row.toJSON().components[0].custom_id;
    assert.equal(id, `aichat_ack:42:${at('2026-11-20T00:00:00.000Z')}`);
    assert.deepEqual(parseAckCustomId(id), { userId: '42', requiredMs: at('2026-11-20T00:00:00.000Z') });
    // Buttons from before 2026-10-03 carry no requirement: valid for the floor only.
    assert.deepEqual(parseAckCustomId('aichat_ack:42'), { userId: '42', requiredMs: null });
    assert.equal(isAckButtonCurrent(null, FALLBACK_REQUIRED_AT, FALLBACK_REQUIRED_AT), true);
    assert.equal(isAckButtonCurrent(null, '2026-11-20T00:00:00.000Z', FALLBACK_REQUIRED_AT), false);
});

function fakeInteraction(customId, { userId = '42', v2 = false } = {}) {
    const calls = { reply: [], update: [] };
    return {
        calls, customId,
        user: { id: userId },
        message: { flags: { has: () => v2 }, content: 'notice text', reference: null },
        async reply(p) { calls.reply.push(p); },
        async update(p) { calls.update.push(p); },
    };
}
const FUTURE_MATERIAL_ROWS = [...ROWS,
    { document: 'terms', version: 2, effective_at: new Date('2026-01-01T00:00:00Z'), published_at: new Date('2025-12-01T00:00:00Z'), change_level: 'material', summary: 'Terms v2.' }];

test('Got it never satisfies a material version in effect', async () => {
    // Terms v2 (material) took effect after this user's last acknowledgment.
    const db = fakeDb({ rows: [{ ...FUTURE_MATERIAL_ROWS[1], effective_at: new Date('2026-10-02T00:00:00Z'), published_at: new Date('2026-09-15T00:00:00Z') }, ...ROWS],
        user: { id: '42', aiTermsAcknowledgedAt: '2026-09-30T00:00:00.000Z' } });
    const i = fakeInteraction('legal_notice_ok:42');
    await legalNotice.execute(i, db);
    assert.equal(db.saved, null, 'nothing saved');
    assert.equal(i.calls.reply.length, 1);
    const text = JSON.stringify(i.calls.reply[0]);
    assert.match(text, /What changed/, 'the full disclosure is shown instead');
    assert.match(text, /aichat_ack:42:/);
});

test('Got it on a notice records the click and clears the notice', async () => {
    const db = fakeDb({ rows: [...ROWS, { document: 'privacy', version: 2, effective_at: new Date('2026-10-02T00:00:00Z'), published_at: new Date('2026-10-02T00:00:00Z'), change_level: 'notice', summary: 'Clearer wording.' }],
        user: { id: '42', aiTermsAcknowledgedAt: '2026-09-30T00:00:00.000Z' } });
    const i = fakeInteraction('legal_notice_ok:42');
    await legalNotice.execute(i, db);
    assert.ok(db.saved?.aiTermsAcknowledgedAt > '2026-10-02', 'timestamp recorded');
    assert.equal(i.calls.update.length, 1);
    assert.deepEqual(i.calls.update[0].components, [], 'button removed');
});

test('Got it pressed by someone else does nothing', async () => {
    const db = fakeDb({ rows: ROWS, user: { id: '42', aiTermsAcknowledgedAt: '2026-09-30T00:00:00.000Z' } });
    const i = fakeInteraction('legal_notice_ok:42', { userId: '7' });
    await legalNotice.execute(i, db);
    assert.equal(db.saved, null);
    assert.match(i.calls.reply[0].content, /different user/);
});

test('an outdated Acknowledge is refreshed, not saved', async () => {
    // Shown for the 2026-09-29 floor; terms v2 (material) took effect since.
    const db = fakeDb({ rows: [{ ...FUTURE_MATERIAL_ROWS[1], effective_at: new Date('2026-10-02T00:00:00Z'), published_at: new Date('2026-09-15T00:00:00Z') }, ...ROWS],
        user: { id: '42', aiTermsAcknowledgedAt: '2026-09-30T00:00:00.000Z' } });
    const i = fakeInteraction(`aichat_ack:42:${at(FALLBACK_REQUIRED_AT)}`, { v2: true });
    await aichatAck.execute(i, db);
    assert.equal(db.saved, null, 'nothing saved');
    const text = JSON.stringify(i.calls.update[0]);
    assert.match(text, /Terms v2\./, 'the refreshed disclosure names the new change');
    assert.match(text, new RegExp(`aichat_ack:42:${at('2026-10-02T00:00:00Z')}`));
});

test('a current Acknowledge saves as before', async () => {
    const db = fakeDb({ rows: ROWS, user: { id: '42', aiTermsAcknowledgedAt: '2026-05-01T00:00:00.000Z' } });
    const i = fakeInteraction(`aichat_ack:42:${at(FALLBACK_REQUIRED_AT)}`, { v2: true });
    await aichatAck.execute(i, db);
    assert.ok(db.saved?.aiTermsAcknowledgedAt, 'saved');
    assert.match(JSON.stringify(i.calls.update[0]), /Acknowledged/);
});

test('the notice names the document and links both policies', () => {
    const p = buildLegalNoticePayload('42', [{ ...v('terms', 2, 'material', '2026-11-20T00:00:00.000Z'), upcoming: true }]);
    assert.match(p.content, /Heads-up/);
    assert.match(p.content, /Terms of Service\*\* changes on 2026-11-20: terms v2 summary/);
    assert.equal(p.components[0].toJSON().components[0].custom_id, 'legal_notice_ok:42');
});
