import crypto from 'node:crypto';
import { parse as parseYaml } from 'yaml';

// The checks behind `pnpm run legal:publish` (src/publishLegal.js), kept pure so
// they can be tested. The rules mirror blueberean-site's scripts/legal.mjs,
// which validates the same files at build time; the yaml library is the same.

export const SITE_BASE = 'https://www.blueberean.com';
export const DOCUMENTS = ['terms', 'privacy'];
export const LEVELS = ['editorial', 'notice', 'material'];
export const SUMMARY_MAX = 400;

export function legalFileUrl(document, version, base = SITE_BASE) {
    return `${base}/legal/${document}/v${version}.md`;
}

export const sha256 = text => crypto.createHash('sha256').update(text, 'utf8').digest('hex');

/** Parse a published legal file (frontmatter + markdown body). Throws on any problem. */
export function parseLegalFile(raw, where = 'legal file') {
    const m = String(raw).match(/^---\n([\s\S]*?)\n---\n\n?([\s\S]*)$/);
    if (!m) throw new Error(`${where}: missing --- frontmatter --- block`);
    const meta = parseYaml(m[1]) ?? {};
    const body = m[2];
    const fail = msg => { throw new Error(`${where}: ${msg}`); };
    if (!DOCUMENTS.includes(meta.document)) fail(`document must be one of ${DOCUMENTS.join(', ')}`);
    if (!Number.isInteger(meta.version) || meta.version < 1) fail('version must be a positive integer');
    if (typeof meta.effective !== 'string' || Number.isNaN(Date.parse(meta.effective)) || !/Z$|[+-]\d\d:\d\d$/.test(meta.effective)) {
        fail('effective must be an ISO 8601 timestamp with a timezone');
    }
    if (!LEVELS.includes(meta.level)) fail(`level must be one of ${LEVELS.join(', ')}`);
    const summary = typeof meta.summary === 'string' ? meta.summary.trim() : '';
    if (!summary || summary.length > SUMMARY_MAX) fail(`summary is required, at most ${SUMMARY_MAX} characters`);
    if (!body.trim()) fail('body is empty');
    return {
        document: meta.document,
        version: meta.version,
        effectiveAt: new Date(meta.effective).toISOString(),
        level: meta.level,
        summary,
        body,
        bodySha256: sha256(body),
    };
}

/**
 * Decide what to do with a fetched version, given the versions already in
 * Neon for that document ({ version, effectiveAt, bodySha256 }, any order).
 *
 *   { action: 'insert' }                 — the next version, all checks pass
 *   { action: 'already' }                — this exact version is published
 *   { action: 'refuse', reason }         — anything else
 */
export function planPublish({ parsed, requested, existing, now = Date.now() }) {
    if (parsed.document !== requested.document || parsed.version !== requested.version) {
        return { action: 'refuse', reason: `the file says ${parsed.document} v${parsed.version}, not ${requested.document} v${requested.version}` };
    }
    const same = existing.find(e => e.version === parsed.version);
    if (same) {
        return same.bodySha256 === parsed.bodySha256
            ? { action: 'already' }
            : { action: 'refuse', reason: `v${parsed.version} is already published with different text; a change must be a new version` };
    }
    const latest = existing.reduce((a, e) => (e.version > (a?.version ?? 0) ? e : a), null);
    const expected = (latest?.version ?? 0) + 1;
    if (parsed.version !== expected) {
        return { action: 'refuse', reason: `the next ${parsed.document} version is v${expected}, not v${parsed.version}` };
    }
    if (latest && Date.parse(parsed.effectiveAt) <= Date.parse(latest.effectiveAt)) {
        return { action: 'refuse', reason: `effective must be later than v${latest.version}'s (${latest.effectiveAt})` };
    }
    // A material change must not take effect before it is published: the
    // acknowledgment gate would treat users as having missed it already. Version
    // 1 is the exception: it records text that was already live.
    if (parsed.level === 'material' && parsed.version > 1 && Date.parse(parsed.effectiveAt) < now) {
        return { action: 'refuse', reason: `a material version cannot take effect in the past (${parsed.effectiveAt}); set effective to now or later (the Terms promise about 14 days' notice)` };
    }
    return { action: 'insert' };
}
