/**
 * Publish a version of the Terms or Privacy Policy to the bot's database.
 *
 *   BIBLICANA_ALLOW_PROD=1 pnpm run legal:publish -- privacy 2
 *
 * Run AFTER blueberean-site is deployed with legal/<document>/v<N>.md. It
 * fetches that file from the live site (https://www.blueberean.com/legal/...),
 * so the bot never announces text users cannot read, validates it, and inserts
 * it into legal_document_versions (docs/ops/legal-versions.sql), then reads the
 * row back and compares the hash. The acknowledgment gate picks it up within 10
 * minutes (src/utils/legalVersions.js). Re-running for a version already
 * published with the same text is a no-op.
 *
 * Options: --site <base URL> fetches from another host (a preview deploy).
 */

import pg from 'pg';
import 'dotenv/config';
import { postgresConfig } from './config.js';
import { refuseProdUnlessAllowed } from './utils/prodGuard.js';
import { legalFileUrl, parseLegalFile, planPublish, SITE_BASE, sha256 } from './utils/legalPublish.js';

// Before any network or database access.
refuseProdUnlessAllowed('src/publishLegal.js');

const args = process.argv.slice(2).filter(a => a !== '--');
const siteIdx = args.indexOf('--site');
const site = siteIdx >= 0 ? args.splice(siteIdx, 2)[1] : SITE_BASE;
const [document, versionArg] = args;
const version = Number(versionArg);
if (!['terms', 'privacy'].includes(document) || !Number.isInteger(version) || version < 1) {
    console.error('usage: pnpm run legal:publish -- <terms|privacy> <version> [--site <base URL>]');
    process.exit(1);
}

const url = legalFileUrl(document, version, site);
const res = await fetch(url, { redirect: 'follow' });
if (!res.ok) {
    console.error(`Refusing: ${url} returned ${res.status}. Deploy blueberean-site first; the bot must not announce text users cannot read.`);
    process.exit(1);
}
const raw = await res.text();
const parsed = parseLegalFile(raw, url);
console.log(`Fetched ${url}: ${parsed.document} v${parsed.version}, ${parsed.level}, effective ${parsed.effectiveAt}, body sha256 ${parsed.bodySha256.slice(0, 12)}...`);

const pool = new pg.Pool({ ...postgresConfig, max: 1 });
try {
    const { rows } = await pool.query(
        'SELECT version, effective_at, body_sha256 FROM legal_document_versions WHERE document = $1', [document]);
    const existing = rows.map(r => ({ version: r.version, effectiveAt: new Date(r.effective_at).toISOString(), bodySha256: r.body_sha256 }));
    const plan = planPublish({ parsed, requested: { document, version }, existing });
    if (plan.action === 'already') {
        console.log(`${document} v${version} is already published with this exact text. Nothing to do.`);
    } else if (plan.action === 'refuse') {
        console.error(`Refusing: ${plan.reason}`);
        process.exitCode = 1;
    } else {
        const { rows: [row] } = await pool.query(
            `INSERT INTO legal_document_versions
                 (document, version, effective_at, change_level, summary, body_md, body_sha256)
             VALUES ($1, $2, $3, $4, $5, $6, $7)
             RETURNING document, version, effective_at, published_at, change_level, summary, body_md, body_sha256`,
            [parsed.document, parsed.version, parsed.effectiveAt, parsed.level, parsed.summary, parsed.body, parsed.bodySha256]);
        if (sha256(row.body_md) !== parsed.bodySha256 || row.body_sha256 !== parsed.bodySha256) {
            throw new Error('read-back hash does not match what was fetched');
        }
        console.log(`Published ${row.document} v${row.version} (${row.change_level}), effective ${new Date(row.effective_at).toISOString()}, published ${new Date(row.published_at).toISOString()}. Read back: hash matches.`);
        console.log(`Summary shown to users: ${row.summary}`);
    }
} finally {
    await pool.end();
}
