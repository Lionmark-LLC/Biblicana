// Import FIRST in a test file that reads Bible/reference data: it points the
// data wrappers (src/utils/dataFiles.js) at the committed fixtures in
// tests/fixtures/data before any wrapper module opens its file, which happens
// at import time. ESM evaluates imports in order, so a later import sees this.
//
// node --test runs each file in its own process, so this never leaks into a
// file that wants the real data (the *.full.test.js files).
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const FIXTURE_DATA_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '../fixtures/data');
process.env.BIBLICANADATADIR = FIXTURE_DATA_DIR;
