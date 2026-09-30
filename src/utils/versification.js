import { bibleWrapper } from './bibleHelper.js';
import logger from './logger.js';

// Which chapters and verses actually exist.
//
// parseScriptureRefs validates BOOK NAMES only - it is pure text with no I/O,
// and is kept that way. So "Romans 17:1", "John 22:1", and "our church is part
// of Acts 29" all parse, and four renderers (the 📖 reaction, passive
// autopost, the verse pager, AI answer expansion) turned them into cards with
// no scripture and five study buttons. /find alone checked, by fetching the
// verses per reference.
//
// This loads the whole versification once - 1,189 rows, ~1ms - so every check
// after that is synchronous with zero I/O. That matters for anything that must
// ack a Discord interaction first: awaiting an already-settled promise costs a
// microtask, not a query.

let tablePromise = null;

async function loadTable() {
    const rows = await bibleWrapper.getVersificationRows();
    // book -> Map(chapter -> lastVerse)
    const table = new Map();
    for (const r of rows) {
        if (!table.has(r.book)) table.set(r.book, new Map());
        table.get(r.book).set(r.chapter, r.lastVerse);
    }
    logger.debug(`[Versification] Loaded ${rows.length} chapters across ${table.size} books`);
    return table;
}

/**
 * Resolves to a checker with synchronous methods. The first call starts the
 * load; every later call awaits the same settled promise.
 *
 * A load FAILURE resolves to a checker that allows everything and says so in
 * the log - refusing every reference because bible.db was briefly unreadable
 * would silence the bot entirely, which is worse than the bug this prevents.
 */
export function getVersification() {
    if (!tablePromise) {
        tablePromise = loadTable()
            .then(table => makeChecker(table))
            .catch(err => {
                logger.error(`[Versification] Load failed, existence checks disabled: ${err.message}`);
                tablePromise = null; // retry on the next call
                return makeChecker(null);
            });
    }
    return tablePromise;
}

// Start loading at import, the way every database in this codebase is opened,
// so the first interaction that checks a reference finds the table ready
// rather than paying for the query ahead of its ack.
getVersification();

export function makeChecker(table) {
    const lastVerse = (bookId, chapter) => table?.get(Number(bookId))?.get(Number(chapter));

    return {
        loaded: table !== null,

        chapterCount(bookId) {
            return table?.get(Number(bookId))?.size ?? null;
        },

        lastVerse,

        /** True when the reference's chapter exists and its first verse does. */
        exists(ref) {
            if (!table) return true;
            const max = lastVerse(ref.bookId, ref.chapter);
            if (max === undefined) return false;
            if (ref.startVerse == null) return true;
            return ref.startVerse >= 1 && ref.startVerse <= max;
        },

        /**
         * The reference with its end verse pulled back to the chapter's last
         * verse, so "John 3:16-40" is labelled 3:16-36. Returns the SAME object
         * when nothing changes, and null when the reference does not exist.
         */
        clamp(ref) {
            if (!this.exists(ref)) return null;
            if (!table || ref.startVerse == null || ref.endVerse == null) return ref;
            const max = lastVerse(ref.bookId, ref.chapter);
            if (ref.endVerse <= max) return ref;
            return { ...ref, endVerse: max };
        },

        /** Existing references only, each clamped. Order preserved. */
        filter(refs) {
            return refs.map(r => this.clamp(r)).filter(Boolean);
        },

        /**
         * One line saying why a reference does not exist, for the paths where
         * a reader explicitly asked (the 📖 reaction, the context-menu
         * commands). Null if it does.
         */
        describeMissing(ref) {
            if (!table || this.exists(ref)) return null;
            const chapters = this.chapterCount(ref.bookId);
            const max = lastVerse(ref.bookId, ref.chapter);
            if (max === undefined) {
                return `${ref.bookName} has ${chapters} chapter${chapters === 1 ? '' : 's'}, so there is no ${ref.bookName} ${ref.chapter}.`;
            }
            return `${ref.bookName} ${ref.chapter} has ${max} verse${max === 1 ? '' : 's'}, so there is no ${ref.bookName} ${ref.chapter}:${ref.startVerse}.`;
        },
    };
}

// The reply for a reference someone asked for that does not exist: the 📖
// reaction and the three context-menu commands.
//
// Psalm 151 is the one missing chapter people are likely to mean on purpose:
// it is real, it is in the Septuagint, and it is not in the Hebrew canon.
// Deliberately does NOT point at /lxx - neither /lxx nor lookup_lxx can reach
// it yet, since its rows have no Masoretic address to look it up by.
export function missingReferenceLine(versification, ref) {
    const label = ref.startVerse == null
        ? `${ref.bookName} ${ref.chapter}`
        : `${ref.bookName} ${ref.chapter}:${ref.startVerse}`;
    const why = versification.describeMissing(ref) ?? `I couldn't find ${label}.`;
    if (ref.bookId === 19 && ref.chapter === 151) {
        return `${why} Psalm 151 is found in the Septuagint, not in the Hebrew Psalter.`;
    }
    return why;
}
