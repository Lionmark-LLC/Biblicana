import path from 'node:path';
import { fileURLToPath } from 'node:url';
import 'dotenv/config';
import { Routes, REST } from 'discord.js';
import yargs from 'yargs/yargs';
import { hideBin } from 'yargs/helpers';
import logger from './utils/logger.js';
import { refuseProdUnlessAllowed } from './utils/prodGuard.js';
import { loadCommands } from './utils/loadCommands.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Before anything loads or reaches Discord. A guild deploy to the prod app is
// refused too: the test bot is the only thing `pnpm run deploy` should touch.
refuseProdUnlessAllowed('src/deploy.js');

// Parse CLI args
const argv = yargs(hideBin(process.argv))
    .option('global', {
        alias: 'g',
        type: 'boolean',
        description: 'Deploy commands globally instead of to the development guild'
    })
    .option('rm', {
        alias: 'r',
        type: 'boolean',
        description: 'Remove all commands instead of deploying'
    })
    .help()
    .alias('help', 'h')
    .parse();

const { commands, failures, skipped } = await loadCommands(path.join(__dirname, 'commands'), { global: Boolean(argv.global) });

for (const file of skipped) {
    logger.info(`[Deploy] Skipping dev-only command '${file}' in global scope.`);
}

// A deploy REPLACES the whole set: a command that failed to load would be
// deleted from every server, not left as it was. Upload nothing instead.
if (failures.length) {
    for (const f of failures) {
        logger.error(`[Deploy] Failed to load src/commands/${f.file}: ${f.reason}`);
        if (f.error?.stack) logger.debug(f.error.stack);
    }
    logger.error(`[Deploy] Refusing to upload: ${failures.length} command file(s) failed to load (${failures.map(f => f.file).join(', ')}). ` +
        'Uploading the rest would remove the failed command(s) from Discord. Nothing was changed.');
    process.exit(1);
}

const rest = new REST({ version: '10' }).setToken(process.env.DISCORDTOKEN);

(async () => {
    try {
        const clientId = process.env.CLIENTID;
        const guildId = process.env.GUILDID;

        const route = argv.global
            ? Routes.applicationCommands(clientId)
            : Routes.applicationGuildCommands(clientId, guildId);

        const body = argv.rm ? [] : commands;

        const scope = argv.global ? 'global' : 'local (guild)';
        const action = argv.rm ? 'removed' : 'reloaded';

        logger.info(`Attempting to ${action} ${body.length} application (/) commands in ${scope} scope...`);

        await rest.put(route, { body });

        logger.info(`Successfully ${action} application (/) commands in ${scope} scope.`);
    } catch (error) {
        logger.error('Error during command deployment:', error);
        // Non-zero so a failed upload can't pass for a successful one in a
        // script or a gate that checks the exit code.
        process.exitCode = 1;
    }
})();
