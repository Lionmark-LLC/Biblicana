import logger from './logger.js';

// Published versions of the Terms and Privacy Policy, and the rule that decides
// whether a user must (re-)acknowledge before AI chat, /find and /web.
//
// Source of truth: legal/<document>/v<N>.md in blueberean-site. `pnpm run
// legal:publish` copies each version into Neon (legal_document_versions, see
// docs/ops/legal-versions.sql) only after the live site serves it, so the bot
// never announces text users cannot read. This module reads that table.
//
// Nothing new is stored per user: the Privacy Policy says the acknowledgment
// "records a timestamp against your Discord user ID", so the decision compares
// that one timestamp (aiTermsAcknowledgedAt) with version dates.

// Used when Neon has no published versions yet, or cannot be read and nothing
// is cached. It is Privacy v1's effective time, the same instant as the
// TERMS_MIN_ACK_DATE constant this replaced, so a database problem never
// changes who is gated.
export const FALLBACK_REQUIRED_AT = '2026-09-29T00:00:00.000Z';

const CACHE_MS = 10 * 60 * 1000;
// After a failed read, wait this long before asking Neon again. Without it,
// every gate check during an outage would sit through the connection timeout
// (5 s, twice with the wake retry) before falling back.
const RETRY_AFTER_FAILURE_MS = 60 * 1000;
const MAX_LISTED = 3;

export const DOCUMENT_TITLES = { terms: 'Terms of Service', privacy: 'Privacy Policy' };

const FALLBACK_VERSIONS = Object.freeze([Object.freeze({
    document: 'privacy', version: 1, effectiveAt: FALLBACK_REQUIRED_AT, publishedAt: FALLBACK_REQUIRED_AT,
    level: 'material', summary: null,
})]);

let cache = null; // { fetchedAt, versions }

/** For tests: forget the cached list. */
export function resetLegalVersionsCache() {
    cache = null;
}

function rowToVersion(r) {
    return {
        document: r.document,
        version: Number(r.version),
        effectiveAt: new Date(r.effective_at).toISOString(),
        publishedAt: new Date(r.published_at).toISOString(),
        level: r.change_level,
        summary: r.summary,
    };
}

/**
 * Published versions (metadata only, no bodies). Cached for 10 minutes and
 * refreshed only when a gate check asks, never on a timer: a timer would keep
 * Neon's compute awake (CLAUDE.md, "Neon bills compute-time").
 *
 * Returns { versions, source } where source is 'neon', 'cache' (stale cache
 * after a failed read) or 'fallback'.
 */
export async function getLegalVersions(database, { now = Date.now() } = {}) {
    if (cache && now - cache.fetchedAt < CACHE_MS) return { versions: cache.versions, source: 'cache' };
    try {
        const sql = `SELECT document, version, effective_at, published_at, change_level, summary
                     FROM legal_document_versions ORDER BY document, version`;
        const { rows } = database.queryWithWakeRetry
            ? await database.queryWithWakeRetry(sql, [], 'read legal_document_versions')
            : await database.pg.query(sql);
        const versions = rows.map(rowToVersion);
        if (versions.length === 0) {
            // Before the first legal:publish: behave exactly as before.
            cache = { fetchedAt: now, versions: FALLBACK_VERSIONS };
            return { versions: FALLBACK_VERSIONS, source: 'fallback' };
        }
        cache = { fetchedAt: now, versions };
        return { versions, source: 'neon' };
    } catch (err) {
        // Hold whatever we serve for a minute: fetchedAt is set so the entry
        // expires RETRY_AFTER_FAILURE_MS from now rather than CACHE_MS.
        const retryAt = now - CACHE_MS + RETRY_AFTER_FAILURE_MS;
        if (cache) {
            logger.warn(`[Legal] Could not refresh legal versions (${err.message}); using the copy from ${new Date(cache.fetchedAt).toISOString()}`);
            cache = { fetchedAt: retryAt, versions: cache.versions };
            return { versions: cache.versions, source: 'cache' };
        }
        logger.warn(`[Legal] Could not read legal versions (${err.message}); using the built-in floor ${FALLBACK_REQUIRED_AT}`);
        cache = { fetchedAt: retryAt, versions: FALLBACK_VERSIONS };
        return { versions: FALLBACK_VERSIONS, source: 'fallback' };
    }
}

const ms = iso => Date.parse(iso);
const newestFirst = (a, b) => ms(b.effectiveAt) - ms(a.effectiveAt) || b.version - a.version;

/**
 * The gate's decision. Pure: (stored timestamp, versions, now) in, verdict out.
 *
 *   no acknowledgment                            -> block, reason 'never'
 *   a MATERIAL version in effect, ack before it  -> block, reason 'stale',
 *        with `changes`: every non-editorial version since the ack
 *   otherwise                                    -> valid, with `notices`:
 *        - a NOTICE version in effect, ack before its effective time
 *        - a MATERIAL version not yet in effect (the 14-day notice period),
 *          ack before it was published
 *   EDITORIAL versions never show.
 *
 * A notice is dismissed by "Got it", which records a new timestamp. That can
 * never satisfy a material version: one in effect blocks before any notice is
 * shown, and the Got it handler re-checks this decision and refuses while the
 * user is blocked. Only an Acknowledge after the effective time clears it.
 *
 * `requiredAt` (ISO) is the effective time of the newest material version in
 * effect; it is encoded in the Acknowledge button so an outdated disclosure
 * cannot satisfy a newer version.
 */
export function decideAck({ ackedAt, versions, now = Date.now() }) {
    const t = typeof now === 'number' ? now : now.getTime();
    const inEffect = versions.filter(v => ms(v.effectiveAt) <= t);
    const requiredMs = Math.max(ms(FALLBACK_REQUIRED_AT), ...inEffect.filter(v => v.level === 'material').map(v => ms(v.effectiveAt)));
    const requiredAt = new Date(requiredMs).toISOString();

    if (!ackedAt) return { valid: false, reason: 'never', requiredAt, changes: [] };
    const acked = ms(ackedAt);
    if (Number.isNaN(acked) || acked < requiredMs) {
        const changes = inEffect
            .filter(v => v.level !== 'editorial' && v.summary && (Number.isNaN(acked) || ms(v.effectiveAt) > acked))
            .sort(newestFirst)
            .slice(0, MAX_LISTED);
        return { valid: false, reason: 'stale', ackedAt, requiredAt, changes };
    }

    const notices = versions
        .filter(v => v.summary && (
            (v.level === 'notice' && ms(v.effectiveAt) <= t && acked < ms(v.effectiveAt)) ||
            (v.level === 'material' && ms(v.effectiveAt) > t && acked < ms(v.publishedAt))
        ))
        .map(v => ({ ...v, upcoming: ms(v.effectiveAt) > t }))
        .sort(newestFirst)
        .slice(0, MAX_LISTED);
    return { valid: true, ackedAt, requiredAt, notices };
}
