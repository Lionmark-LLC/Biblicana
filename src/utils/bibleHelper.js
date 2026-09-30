import logger from './logger.js';
import { openRequired } from './dataFiles.js';

const numSuperMap = new Map([
    [0, '⁰'], [1, '¹'], [2, '²'], [3, '³'], [4, '⁴'],
    [5, '⁵'], [6, '⁶'], [7, '⁷'], [8, '⁸'], [9, '⁹']
]);

/**
 * @param {number} number Number to convert to superscript
 * @returns {string} The superscripted number
 * @example numberToSuperScript(123) // returns ¹²³
 */
export const numberToSuperScript = (number) => {
    let superScript = '';
    for (const digit of number.toString()) {
        superScript += numSuperMap.get(parseInt(digit));
    }
    return superScript;
};

const biblePromise = openRequired('bible.db');
const strongsPromise = openRequired('strongs.db');

class BibleWrapper {
    constructor() {
        this.db = biblePromise;
    }

    /** @deprecated Use getVerses. */
    async getVerse(book, chapter, verse) {
        const db = await this.db;
        return db.get(
            `SELECT * FROM english WHERE book = ? AND chapter = ? AND verse = ?`,
            [book, chapter, verse]
        );
    }

    // Every (book, chapter) with its last verse — 1,189 rows. Read ONCE by
    // versification.js; nothing else should need it.
    async getVersificationRows() {
        const db = await this.db;
        return db.all(
            `SELECT CAST(bookID AS INTEGER) AS book, chapter, MAX(verse) AS lastVerse
             FROM english GROUP BY bookID, chapter`
        );
    }

    async getVerses(book, chapter, startVerse, endVerse) {
        const db = await this.db;
        return db.all(
            `SELECT * FROM english WHERE bookID = ? AND chapter = ? AND verse BETWEEN ? AND ?`,
            [book, chapter, startVerse, endVerse]
        );
    }

    async getInterlinearVerse(book, chapter, verse) {
        const db = await this.db;
        return db.get(
            `SELECT * FROM interlinear WHERE bookid = ? AND chapter = ? AND verse = ?`,
            [book, chapter, verse]
        );
    }

    /**
     * Returns a single random verse row, optionally scoped to a book or a
     * specific chapter within a book. Returns undefined if no row matches.
     */
    async getRandomVerse(filterBookId = null, filterChapter = null) {
        const db = await this.db;
        const conditions = [];
        const params = [];
        if (filterBookId) {
            conditions.push('bookID = ?');
            params.push(filterBookId);
        }
        if (filterChapter) {
            conditions.push('chapter = ?');
            params.push(filterChapter);
        }
        const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
        return db.get(
            `SELECT * FROM english ${whereClause} ORDER BY RANDOM() LIMIT 1`,
            params
        );
    }
}

class StrongsWrapper {
    constructor() {
        this.db = strongsPromise;
    }

    async getStrongsEnglish(language, english) {
        const db = await this.db;
        // `language` is interpolated into the table name, so it must come from a
        // fixed allowlist — never the raw argument. Mirrors getStrongsId below.
        // (Today's caller passes a Discord choice-enforced value, but this keeps
        // the method safe regardless of caller.)
        const tableName = String(language).toLowerCase() === 'greek' ? 'greek' : 'hebrew';
        const query = await db.all(
            `SELECT * FROM ${tableName} WHERE kjvdef LIKE ?`,
            [`%${english}%`]
        );
        if (query.length == 0) return null;
        return query;
    }

    // Tries the full Strong's ID (e.g., "G2316") first, then falls back to
    // just the numeric part ("2316") since some rows are keyed without the
    // language prefix. "No match" is normal (many words have no Strong's)
    // so it logs at debug — only real DB errors bubble up at error level.
    async getStrongsId(language, id) {
        if (!id) return undefined;

        const db = await this.db;
        const normalizedLanguage = language.toLowerCase();
        const tableName = normalizedLanguage === 'greek' ? 'Greek' : 'Hebrew';

        try {
            let result = await db.get(`SELECT * FROM ${tableName} WHERE strongs = ?`, [id]);
            if (result) return result;

            const numberPart = id.substring(1);
            if (numberPart && !isNaN(numberPart)) {
                result = await db.get(`SELECT * FROM ${tableName} WHERE strongs = ?`, [numberPart]);
                if (result) return result;
            }
            return undefined;
        } catch (error) {
            logger.error(`[Strongs Wrapper] Database error querying ${tableName} for ${id}: ${error.message}`);
            return undefined;
        }
    }
}

/** Singleton wrapper instances (DB connections) */
export const strongsWrapper = new StrongsWrapper();
export const bibleWrapper = new BibleWrapper();

// Translation IDs we no longer surface to users because we don't currently
// hold commercial redistribution rights. Reads that still receive one of
// these values (e.g., from a stored user preference set before the removal)
// fall back to BSB via coerceTranslation. The columns remain in bible.db so
// data stays intact if we later secure a license; surfacing is gated at the
// code layer.
const DEPRECATED_TRANSLATIONS = new Set(['NASB', 'NKJV', 'AMPC']);

/**
 * Map any translation identifier to a surfacing-safe value. Null/undefined
 * or empty input → 'BSB'. A translation in DEPRECATED_TRANSLATIONS → 'BSB'.
 * Anything else → passed through unchanged.
 *
 * Used by every command that resolves a translation from slash-command
 * options OR from the user's stored preference. Centralizing here means a
 * single change (removing from the deprecated set, or adding a new one)
 * propagates to every translation-aware command without touching them.
 */
export function coerceTranslation(translation) {
    if (!translation) return 'BSB';
    return DEPRECATED_TRANSLATIONS.has(translation) ? 'BSB' : translation;
}
