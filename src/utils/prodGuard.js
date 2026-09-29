// Refuses to let an admin script act on production unless explicitly told to.
//
// src/deploy.js (`--global --rm` empties the prod command registry across every
// server) and src/pruneGuildData.js (`--apply` deletes guild rows) act on
// whatever .env says. A developer or a builder agent with a prod-shaped .env
// would reach prod with no other signal. Kenneth's deliberate prod runs set
// BIBLICANA_ALLOW_PROD=1 (the name is ops-platform's, hence the underscores).
//
// The prod identifiers are constants HERE, not env vars: the whole point is
// that nothing in .env can redefine what counts as prod.

// Biblicana#7650's application (and bot user) ID.
export const PROD_CLIENT_ID = '1165716269425758249';

// Neon project "Biblicana", branch `main`, read-write endpoint. Matched as a
// prefix so the pooler (`<id>-pooler.…`) and per-compute (`<id>-hnw.…`) hosts,
// which reach the same database, count too. dev-local is a different endpoint.
export const PROD_NEON_ENDPOINT = 'ep-proud-snowflake-a4xubaxb';

export const OVERRIDE_VAR = 'BIBLICANA_ALLOW_PROD';

// A bot token's first segment is the base64 of the bot's user ID, which for a
// bot is its application ID. Checked because pruneGuildData logs in with
// DISCORDTOKEN alone and never reads CLIENTID: a prod token beside a test
// CLIENTID would otherwise pass.
export function tokenApplicationId(token) {
    if (typeof token !== 'string') return null;
    const first = token.trim().split('.')[0];
    if (!first) return null;
    const decoded = Buffer.from(first, 'base64').toString('utf8');
    return /^\d{17,20}$/.test(decoded) ? decoded : null;
}

function isProdHost(host) {
    if (typeof host !== 'string') return false;
    const h = host.trim().toLowerCase();
    return h === PROD_NEON_ENDPOINT
        || h.startsWith(`${PROD_NEON_ENDPOINT}.`)
        || h.startsWith(`${PROD_NEON_ENDPOINT}-`);
}

// Every reason env points at prod. Empty means not prod.
export function prodTargets(env) {
    const reasons = [];
    if (String(env.CLIENTID ?? '').trim() === PROD_CLIENT_ID) {
        reasons.push(`CLIENTID is the prod application (${PROD_CLIENT_ID})`);
    }
    if (tokenApplicationId(env.DISCORDTOKEN) === PROD_CLIENT_ID) {
        reasons.push('DISCORDTOKEN belongs to the prod application');
    }
    if (isProdHost(env.PGHOST)) {
        reasons.push(`PGHOST is the prod Neon endpoint (${PROD_NEON_ENDPOINT})`);
    }
    return reasons;
}

// Exactly "1": a stray "0", "false" or empty value must not unlock prod.
export function prodAllowed(env) {
    return env[OVERRIDE_VAR] === '1';
}

// Call before the script touches Discord or the database. Returns normally when
// the target is not prod or the override is set; otherwise prints why and exits
// non-zero. `exit` and `write` are injectable for tests.
export function refuseProdUnlessAllowed(script, env = process.env, {
    exit = code => process.exit(code),
    write = msg => process.stderr.write(msg),
} = {}) {
    const reasons = prodTargets(env);
    if (reasons.length === 0) return { prod: false };
    if (prodAllowed(env)) {
        write(`[ProdGuard] ${script}: acting on PRODUCTION (${OVERRIDE_VAR}=1). ${reasons.join('; ')}.\n`);
        return { prod: true };
    }
    write(
        `[ProdGuard] Refusing to run ${script} against production:\n` +
        reasons.map(r => `  - ${r}\n`).join('') +
        `If this is a deliberate prod run, re-run with ${OVERRIDE_VAR}=1 in the environment.\n`
    );
    exit(2);
    // Only reached when a test's exit() does not stop the process.
    return { prod: true, refused: true };
}
