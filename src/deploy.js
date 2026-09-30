import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import 'dotenv/config';
import { Routes, REST } from 'discord.js';
import yargs from 'yargs/yargs';
import { hideBin } from 'yargs/helpers';
import logger from './utils/logger.js';
import { refuseProdUnlessAllowed } from './utils/prodGuard.js';

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

const commands = [];
const commandsPath = path.join(__dirname, 'commands');
const commandFiles = fs.readdirSync(commandsPath).filter(file => file.endsWith('.js'));

// Dynamically import each command module (ESM uses async import)
for (const file of commandFiles) {
    const filePath = path.join(commandsPath, file);
    try {
        const moduleExports = await import(pathToFileURL(filePath).href);
        const command = moduleExports.default;
        if (command?.data?.toJSON) {
            // Dev-only commands (e.g. /testwelcome) must never enter the GLOBAL
            // (production) registry — they'd surface in the picker across all
            // 512 servers. They may still register to the dev guild for testing.
            if (command.devOnly && argv.global) {
                logger.info(`[Deploy] Skipping dev-only command '${file}' in global scope.`);
                continue;
            }
            commands.push(command.data.toJSON());
        } else {
            logger.warn(`[WARNING] Command at ${file} is missing 'data' or 'data.toJSON' method.`);
        }
    } catch (error) {
        logger.error(`Error loading command at ${filePath}:`, error);
    }
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
