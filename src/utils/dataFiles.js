import { fileURLToPath } from 'node:url';
import path, { dirname } from 'node:path';
import sqlite3 from 'sqlite3';
import { open } from 'sqlite';
import logger from './logger.js';

// Where the gitignored SQLite files live, and the one way to open them.
//
// BIBLICANADATADIR overrides the directory. The test suite points it at
// tests/fixtures/data (small committed extracts, built by
// tests/fixtures/buildFixtures.js); nothing else should need it.
//
// Every file opens with mode OPEN_READONLY. The `sqlite` package ignores a
// `readOnly: true` option (it reads only `mode`), so the wrappers used to open
// READ-WRITE with CREATE: a missing file was silently created empty, and the
// failure surfaced later as "no such table" instead of "file missing". A
// fresh clone running the tests would litter data/ with empty databases.

const __dirname = dirname(fileURLToPath(import.meta.url));
const DEFAULT_DIR = path.join(__dirname, '../..', 'data');

export function dataDir() {
    return process.env.BIBLICANADATADIR ? path.resolve(process.env.BIBLICANADATADIR) : DEFAULT_DIR;
}

export function dataFile(name) {
    return path.join(dataDir(), name);
}

function openReadOnly(name) {
    return open({ filename: dataFile(name), driver: sqlite3.Database, mode: sqlite3.OPEN_READONLY });
}

// A file the feature cannot work without. The promise REJECTS when the file
// is missing or unreadable, so every query awaiting it throws a clear error.
// It is created at import time, so the rejection is observed here (logged
// once) to keep it from being an unhandled rejection that kills the process:
// one missing data file must fail its own commands, not the whole bot.
export function openRequired(name) {
    const promise = openReadOnly(name).catch(err => {
        throw new Error(`data/${name} could not be opened read-only (${err.message}). ` +
            'Data files are gitignored and copied to data/ separately (see CLAUDE.md).', { cause: err });
    });
    promise.catch(err => logger.error(`[Data] ${err.message}`));
    return promise;
}

// A file whose absence is a normal state: resolves to null, with one warning
// naming what goes without.
export function openOptional(name, consequence) {
    return openReadOnly(name).catch(err => {
        logger.warn(`[Data] data/${name} unavailable (${err.message}) - ${consequence}`);
        return null;
    });
}
