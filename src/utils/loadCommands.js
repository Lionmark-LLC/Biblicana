import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

// Loads every command definition in `dir` for src/deploy.js, reporting the
// files that failed instead of skipping them.
//
// Skipping was the danger: a deploy is a PUT that REPLACES the whole set, so a
// command that failed to import was not "left alone", it was deleted from every
// server (globally, with deployg). deploy.js refuses to upload when `failures`
// is non-empty.
//
// A failure is a file that throws on import, has no `data.toJSON`, or whose
// toJSON() throws. Dev-only commands (e.g. /testwelcome) are a deliberate skip
// in global scope, not a failure: they must never enter the production registry.
export async function loadCommands(dir, { global = false } = {}) {
    const commands = [];
    const failures = [];
    const skipped = [];
    const files = fs.readdirSync(dir).filter(file => file.endsWith('.js')).sort();

    for (const file of files) {
        try {
            const command = (await import(pathToFileURL(path.join(dir, file)).href)).default;
            if (typeof command?.data?.toJSON !== 'function') {
                failures.push({ file, reason: "missing 'data' or 'data.toJSON'" });
                continue;
            }
            if (command.devOnly && global) {
                skipped.push(file);
                continue;
            }
            commands.push(command.data.toJSON());
        } catch (error) {
            failures.push({ file, reason: error?.message ?? String(error), error });
        }
    }
    return { commands, failures, skipped };
}
