/**
 * One-shot audit + prune for stale `guilddata` rows.
 *
 *   node src/pruneGuildData.js            # dry run — reports, changes nothing
 *   node src/pruneGuildData.js --apply    # actually deletes orphaned rows
 *
 * A guilddata row outlives the bot's membership: when a server removes
 * Biblicana, its settings row stays behind forever. Two of these were found in
 * prod (FOLLOWUPS Ops), and the daily-verse scheduler now counts them every
 * tick as `orphaned=N` because the DB, not the guild cache, is its source of
 * truth.
 *
 * DELIBERATELY CONSERVATIVE. It deletes only rows for guilds the bot is no
 * longer a member of, which are safe: if that server re-adds Biblicana, a fresh
 * row is created on first use. Rows for guilds the bot IS in are never touched,
 * even when misconfigured — those are somebody's live settings, and a bad
 * channelId is a support conversation, not a row to delete.
 *
 * Logging in is what makes membership knowable, so this needs the same
 * DISCORDTOKEN as the bot. Guilds intent only; it reads nothing else.
 */

import { Client, GatewayIntentBits } from 'discord.js';
import DatabaseHandler from './database/redisPGHandler.js';
import { postgresConfig } from './config.js';
import logger from './utils/logger.js';
import { refuseProdUnlessAllowed } from './utils/prodGuard.js';
import 'dotenv/config';

const APPLY = process.argv.includes('--apply');

// Before Redis, Postgres or the gateway. Refuses the dry run as well: it logs in
// with the prod token and reads every prod guild row.
refuseProdUnlessAllowed('src/pruneGuildData.js');

function summarize(data) {
    const daily = data?.dailyVerse;
    const bits = [];
    if (daily?.enabled) bits.push(`dailyVerse=on${daily.channelId ? '' : ' (NO channelId — could never post)'}`);
    if (daily?.lastPostedDate) bits.push(`lastPosted=${daily.lastPostedDate}`);
    if (data?.passiveMode) bits.push(`passive=${data.passiveMode}`);
    if (data?.aiEnabled) bits.push('ai=on');
    return bits.length ? bits.join(', ') : 'no settings';
}

async function main() {
    if (!process.env.DISCORDTOKEN) {
        logger.error('[Prune] DISCORDTOKEN missing — membership cannot be determined. Aborting.');
        process.exit(1);
    }

    // Constructed exactly as index.js does — no Redis config, so ioredis uses
    // its localhost default. Inventing REDISHOST/REDISPORT here would silently
    // point the prune at a different Redis than the bot uses.
    const database = new DatabaseHandler(postgresConfig);
    await database.initialize();

    const client = new Client({ intents: [GatewayIntentBits.Guilds] });
    await client.login(process.env.DISCORDTOKEN);
    // GUILD_CREATE events arrive after READY; wait for the cache to fill or an
    // otherwise-healthy bot looks like it has left every server.
    await new Promise(resolve => client.once('ready', resolve));
    logger.info(`[Prune] Logged in as ${client.user.tag}; bot is in ${client.guilds.cache.size} guild(s).`);

    // Admin-tool query: reaching into the pool directly rather than adding a
    // one-caller method to the data layer.
    const { rows } = await database.pg.query('SELECT id, data FROM guilddata ORDER BY id');
    logger.info(`[Prune] guilddata holds ${rows.length} row(s).`);

    const orphaned = [];
    const misconfigured = [];

    for (const row of rows) {
        const guildId = String(row.id).replace(/^guild:/, '');
        const inGuild = client.guilds.cache.has(guildId);

        if (!inGuild) {
            orphaned.push({ guildId, key: row.id, summary: summarize(row.data) });
            continue;
        }
        const daily = row.data?.dailyVerse;
        if (daily?.enabled && !daily.channelId) {
            misconfigured.push({ guildId, name: client.guilds.cache.get(guildId)?.name ?? '?' });
        }
    }

    logger.info('');
    logger.info(`[Prune] ORPHANED (bot no longer a member) — ${orphaned.length}:`);
    for (const row of orphaned) logger.info(`[Prune]   ${row.guildId} — ${row.summary}`);

    logger.info('');
    logger.info(`[Prune] MISCONFIGURED (bot still present, daily verse on with no channel) — ${misconfigured.length}:`);
    for (const row of misconfigured) logger.info(`[Prune]   ${row.guildId} (${row.name}) — needs /config daily, NOT deleted`);

    if (!APPLY) {
        logger.info('');
        logger.info(`[Prune] Dry run. Nothing was changed. Re-run with --apply to delete the ${orphaned.length} orphaned row(s).`);
    } else if (orphaned.length === 0) {
        logger.info('');
        logger.info('[Prune] Nothing to delete.');
    } else {
        logger.info('');
        let deleted = 0;
        for (const row of orphaned) {
            // deleteGuildValue clears Redis alongside Postgres, so a cached copy
            // can't outlive the row it came from.
            const ok = await database.deleteGuildValue(row.guildId).catch(err => {
                logger.error(`[Prune] Failed to delete ${row.guildId}: ${err.message}`);
                return false;
            });
            if (ok) { deleted++; logger.info(`[Prune] Deleted ${row.guildId}`); }
        }
        logger.info(`[Prune] Deleted ${deleted}/${orphaned.length} orphaned row(s).`);
    }

    await client.destroy();
    await database.close();
    process.exit(0);
}

main().catch(err => {
    logger.error(`[Prune] Fatal: ${err.message}`);
    process.exit(1);
});
