import { toTSKSource, getBookId } from './bookNames.js';
import { openRequired, openOptional } from './dataFiles.js';

const fathersPromise = openRequired('extrabiblical_data.sqlite');
const personPlacesPromise = openRequired('person_places.db');
const dictionaryPromise = openRequired('dictionary.sqlite');
const crossRefPromise = openRequired('cross-references.sqlite');
const categoriesPromise = openRequired('categories.sqlite');
const commentaryPromise = openRequired('clean_commentary.db');
const lxxPromise = openRequired('lxx.sqlite');

// OPTIONAL, unlike every file above: resolves to null when absent. Footnotes
// enrich AI grounding; they must never be the reason the bot fails to start,
// and a data file lands on the droplet by scp, separately from the git pull
// that ships this code.
const bsbFootnotesPromise = openOptional('bsb_footnotes.sqlite', 'grounding will omit BSB footnotes');

// Optional for the same reason: Haley's "Alleged Discrepancies" (1874), built by
// src/buildDifficulties.js. Absent, grounding and lookup_difficulty go without.
const difficultiesPromise = openOptional('difficulties.sqlite', 'Haley and Torrey will not be consulted');

export const COMMENTATORS = [
    { id: 'john-gill',              label: "John Gill" },
    { id: 'matthew-henry',          label: "Matthew Henry" },
    { id: 'adam-clarke',            label: "Adam Clarke" },
    { id: 'jamieson-fausset-brown', label: "Jamieson-Fausset-Brown" },
    { id: 'keil-delitzsch',         label: "Keil & Delitzsch (OT only)" },
    { id: 'tyndale',                label: "Tyndale Open Study Notes" },
];

// Preferred order for "lead Father name" in stat lines (e.g., the reaction-
// expansion reply's "📜 {name} + N other Fathers"). Matched case-insensitively
// as a substring against `father_name`, so "Augustine" picks up "Augustine of
// Hippo". First marquee entry with a hit wins; fall through to alphabetical.
// Curated for name recognition, not theological hierarchy — the goal is users
// see a name that signals depth, not a canonical ordering of importance.
const MARQUEE_FATHERS = [
    'Augustine',
    'John Chrysostom', 'Chrysostom',
    'Thomas Aquinas', 'Aquinas',
    'Jerome',
    'Athanasius',
    'Ambrose',
    'Origen',
    'Irenaeus',
    'Gregory the Great',
    'Tertullian',
    'Basil',
    'Cyprian',
    'Clement of Alexandria',
    'Justin Martyr',
    'Polycarp',
    'Ignatius',
];

/**
 * Pick the most recognizable Father name out of a result set. Used for the
 * stat-line lead; doesn't affect which rows are returned or ordered to users
 * in the /fathers command.
 *
 * Returns the picked father_name string, or null if rows is empty.
 */
export function pickMarqueeFather(fathersRows) {
    if (!fathersRows || fathersRows.length === 0) return null;
    for (const marquee of MARQUEE_FATHERS) {
        const needle = marquee.toLowerCase();
        const match = fathersRows.find(f => f.father_name?.toLowerCase().includes(needle));
        if (match) return match.father_name;
    }
    return fathersRows[0].father_name ?? null;
}

class FathersWrapper {
    constructor() { this.db = fathersPromise; }

    async getByPassage(books, chapter, verse, fatherFilter = null) {
        const db = await this.db;
        const bookList = Array.isArray(books) ? books : [books];
        const loc = chapter * 1_000_000 + verse;
        const placeholders = bookList.map(() => '?').join(',');
        const params = [...bookList, loc, loc];
        // LEFT JOIN father_meta pulls wiki_url + default_year inline so /fathers
        // can show a Wikipedia button without a second round-trip per Father.
        let sql = `SELECT c.father_name, c.txt, c.source_url, c.source_title,
                          c.location_start, c.location_end,
                          m.wiki_url, m.default_year
                   FROM commentary c
                   LEFT JOIN father_meta m ON m.name = c.father_name COLLATE NOCASE
                   WHERE c.book IN (${placeholders}) AND c.location_start <= ? AND c.location_end >= ?`;
        if (fatherFilter) {
            // Punctuation-insensitive match. The DB stores names without
            // periods ("CS Lewis"), so a bare LIKE '%C.S. Lewis%' matched
            // nothing — the user typed the name correctly and got no results.
            //
            // Normalising BOTH sides fixes the class rather than one author:
            // "C.S. Lewis", "CS Lewis" and "c s lewis" all collapse to
            // "cslewis". The nested replace() forces a scan, but the row set is
            // already bounded by book and location, so it stays cheap.
            //
            // Wildcards are still escaped so a filter of '%' or '_' cannot
            // bypass the filter by matching everything.
            const normalized = normalizeFatherName(fatherFilter).replace(/[\\%_]/g, ch => `\\${ch}`);
            sql += ` AND REPLACE(REPLACE(REPLACE(REPLACE(LOWER(c.father_name), '.', ''), ' ', ''), '-', ''), '''', '') LIKE ? ESCAPE '\\'`;
            params.push(`%${normalized}%`);
        }
        sql += ` ORDER BY c.father_name LIMIT 50`;
        return db.all(sql, params);
    }

    async fatherMeta(name) {
        const db = await this.db;
        return db.get(
            `SELECT name, default_year, wiki_url FROM father_meta WHERE name = ? COLLATE NOCASE`,
            [name]
        );
    }

    // Distinct list of all fathers with their entry counts + metadata for a
    // "who can I search?" directory page. NULL default_year values (fathers
    // without dating metadata) are sorted last.
    async listAllFathers() {
        const db = await this.db;
        return db.all(
            `SELECT c.father_name AS name,
                    m.default_year AS year,
                    m.wiki_url    AS wiki_url,
                    COUNT(c.id)   AS entry_count
             FROM commentary c
             LEFT JOIN father_meta m ON m.name = c.father_name COLLATE NOCASE
             GROUP BY c.father_name
             ORDER BY
                CASE WHEN m.default_year IS NULL THEN 1 ELSE 0 END,
                m.default_year ASC,
                c.father_name ASC`
        );
    }
}

/**
 * Split a person/place `unique_name` into its display parts.
 *
 * Format is "Name_Book.Chapter.Verse" — "Mary_Magdalene_Mat.27.56",
 * "Akeldama_Mat.27.7" — i.e. the name may itself contain underscores, so only
 * the LAST segment is the reference.
 *
 * Lives here rather than in a command file because persons.js, places.js and
 * the AI chat tools all need identical formatting; it was previously duplicated
 * verbatim (modulo variable names) in the two command files.
 *
 * @returns {{name: string, firstRef: string, structured: ?{bookId: number, chapter: number, verse: number}}}
 */
export function displayName(uniqueName) {
    if (!uniqueName) return { name: 'Unknown', firstRef: '', structured: null };
    const parts = String(uniqueName).split('_');
    const ref = parts[parts.length - 1];
    const name = parts.slice(0, -1).join(' ');

    let structured = null;
    const refParts = ref.split('.');
    if (refParts.length === 3) {
        const [bookCode, chapterStr, verseStr] = refParts;
        const bookId = getBookId(bookCode.toLowerCase(), { silent: true });
        const chapter = parseInt(chapterStr, 10);
        const verse = parseInt(verseStr, 10);
        if (bookId && !isNaN(chapter) && !isNaN(verse)) {
            structured = { bookId, chapter, verse };
        }
    }

    return { name, firstRef: ref.replace(/\./g, ' '), structured };
}

/**
 * Collapse a Father's name to a punctuation-free, lowercase key.
 *
 * Must stay in sync with the SQL expression in getByPassage — both sides of the
 * comparison have to be normalised identically or the match silently fails.
 */
export function normalizeFatherName(name) {
    return String(name ?? '').toLowerCase().replace(/[.\s'-]/g, '');
}

/**
 * Classify a "Church Father" by year.
 *
 * The extrabiblical_data collection is really 2,000 years of Christian
 * commentary under a patristic label: 275 patristic, 36 medieval (Aquinas,
 * Bernard), 13 modern (C.S. Lewis, Tolkien, and at least one living author).
 * Presenting any of the latter as "the early church" would be a factual error,
 * so every surface that shows these rows needs the same classification.
 *
 * Lives here rather than in aiChat.js because /fathers needs it too — it was
 * previously a private function declaration inside the AI tools section, which
 * is why the slash command shipped without the filter the AI path had.
 *
 * default_year is stored as TEXT, so it needs parseInt. 9999 marks
 * pseudonymous/undated works, which are patristic-adjacent. The patristic era
 * closes ~AD 800 (John of Damascus).
 */
export function classifyFather(yearRaw) {
    const y = parseInt(yearRaw, 10);
    if (!Number.isFinite(y) || y === 9999) return { patristic: true, era: 'early Church Father, date uncertain' };
    if (y <= 800) return { patristic: true, era: `early Church Father, c. AD ${y}` };
    if (y <= 1499) return { patristic: false, era: `medieval writer (c. ${y}) — NOT a Church Father` };
    if (y <= 1700) return { patristic: false, era: `Reformation-era writer (c. ${y}) — NOT a Church Father` };
    return { patristic: false, era: `modern author (c. ${y}) — NOT a Church Father` };
}

/**
 * Short, user-facing era label for the /fathers command.
 *
 * classifyFather's `era` strings are written to instruct a MODEL (they shout
 * "NOT a Church Father"), which reads as scolding in a UI. This returns
 * something suitable for a human: null when the author is genuinely patristic,
 * a compact tag otherwise.
 */
export function fatherEraBadge(yearRaw) {
    const y = parseInt(yearRaw, 10);
    if (!Number.isFinite(y) || y === 9999) return null;
    if (y <= 800) return null;
    if (y <= 1499) return `Medieval · c. ${y}`;
    if (y <= 1700) return `Reformation era · c. ${y}`;
    return `Modern · c. ${y}`;
}

// Commentators who key an entire passage note at its FIRST verse rather than
// writing verse by verse. An exact-verse lookup misses everything else in the
// block, so these need the covering lookup.
export const PASSAGE_GROUPED_COMMENTATORS = new Set(['matthew-henry', 'keil-delitzsch']);

/**
 * Slice a passage-grouped commentary block down to the part about a verse.
 *
 * Passage blocks are long — Matthew Henry on Philippians 4:1-9 is a single
 * 11,968-character entry — and callers cap what they forward at around 900
 * characters. Taking the FIRST 900 characters of a block keyed at verse 1
 * answers a question about verse 6 with material about verse 1: measured on
 * that exact block, the verse-6 discussion begins at character 7,687, so the
 * relevant text was never in the slice at all. The answer looked sourced and
 * confident, and was about the wrong verse.
 *
 * These blocks mark their internal structure with inline references
 * ("Phi 4:6"), so anchor to the target verse's marker and stop at the next
 * verse's, keeping the slice on topic.
 *
 * @returns {{text: string, fromVerse: ?number}} fromVerse is the verse the
 *   slice was anchored to (null when no marker was usable and the text was
 *   simply truncated), so callers can say which verse they actually quoted.
 */
export function extractVerseSlice(text, chapter, verse, maxChars = 900) {
    const source = String(text ?? '');
    if (source.length <= maxChars) return { text: source, fromVerse: null };

    // A short book token followed by this chapter's number, e.g. "Phi 4:6",
    // "1 Sa 4:6", "Gen. 4:6". Pinned to THIS chapter so a cross-reference to
    // another chapter cannot hijack the anchor.
    const markerPattern = new RegExp(`\\b(?:[1-3]\\s?)?[A-Z][A-Za-z]{1,5}\\.?\\s+${chapter}:(\\d+)`, 'g');
    const marks = [];
    let match;
    while ((match = markerPattern.exec(source)) !== null) {
        marks.push({ verse: parseInt(match[1], 10), at: match.index });
    }
    if (marks.length === 0) return { text: source.slice(0, maxChars), fromVerse: null };

    // Prefer an exact marker for the target verse; otherwise fall back to the
    // nearest preceding one, whose discussion most likely still covers it.
    let anchor = marks.find(mark => mark.verse === verse) ?? null;
    if (!anchor) {
        for (const mark of marks) {
            if (mark.verse < verse && (!anchor || mark.verse > anchor.verse)) anchor = mark;
        }
    }
    if (!anchor) return { text: source.slice(0, maxChars), fromVerse: null };

    // Stop at the next LATER verse so the slice doesn't run into the following
    // verse's discussion, but never exceed the caller's budget.
    const next = marks.find(mark => mark.at > anchor.at && mark.verse > anchor.verse);
    const end = Math.min(next ? next.at : source.length, anchor.at + maxChars);

    return { text: source.slice(anchor.at, end).trim(), fromVerse: anchor.verse };
}

const PERSON_COLUMNS = `id, unique_name, uStrong, father, mother, siblings, partners,
             offspring, tribe, sex, short_description, ext_description`;

class PersonsWrapper {
    constructor() { this.db = personPlacesPromise; }

    /**
     * Find a biblical figure, widening the search rather than failing.
     *
     * The dataset keys people as "Peter_Mat.4.18" — canonical name, then first
     * mention — and the original match was a PREFIX of that whole string. So
     * "Peter" worked while "Simon Peter", "the Apostle Peter" and
     * "Peter (Simon Peter)" all returned nothing, because the query has to
     * BEGIN the canonical name. The model behaves sensibly and supplies the
     * fuller, more precise name, and the more precise it was the more certainly
     * it failed — then the tool reported "no entry in the dataset" for one of
     * the best-attested figures in Scripture.
     *
     * Tier 1 is that same prefix match, kept intact: it is what stops the
     * trailing reference matching junk, and an exact hit should never be
     * diluted by near-misses.
     *
     * Tier 2 tries each WORD of the query as its own canonical prefix, so
     * "Simon Peter" reaches both Peter and the seven Simons and the caller can
     * choose. There is deliberately no stopword list to maintain: "the" and
     * "Apostle" are not canonical names, so they match nothing and filter
     * themselves out against the data.
     *
     * Returns { results, matchType } following dictionaryWrapper.search —
     * 'fuzzy' means CANDIDATES, not an answer, and callers must say so rather
     * than asserting the first row is the person who was asked about.
     */
    async search(name) {
        const db = await this.db;
        // SQLite LIKE treats _ as a SINGLE-CHARACTER WILDCARD, and this dataset
        // keys people with literal underscores ("Peter_Mat.4.18"). Unescaped,
        // the pattern "the_%" matches "THEophilus" and "THEudas" — which is
        // how a search for "the Apostle Peter" returned Theophilus. Escaping
        // makes every underscore mean the underscore the data actually has.
        const canonicalPrefix = (q) => {
            const literal = q.trim().replace(/\s+/g, '_');
            const escaped = literal.replace(/[\\%_]/g, c => `\\${c}`);
            return `${escaped}\\_%`;
        };

        const exact = await db.all(
            `SELECT ${PERSON_COLUMNS}
             FROM persons
             WHERE unique_name LIKE ? ESCAPE '\\' COLLATE NOCASE
             ORDER BY unique_name
             LIMIT 25`,
            [canonicalPrefix(name)]
        );
        if (exact.length > 0) return { results: exact, matchType: 'exact' };

        // Letters only, so "Peter (Simon Peter)" loses its punctuation. Single
        // letters are dropped — an initial is not a canonical name and would
        // match a large slice of the table.
        const words = [...new Set((String(name).match(/[A-Za-z]+/g) ?? []).filter(w => w.length > 1))];
        if (words.length < 2) return { results: [], matchType: 'none' };

        const fuzzy = await db.all(
            `SELECT ${PERSON_COLUMNS}
             FROM persons
             WHERE ${words.map(() => "unique_name LIKE ? ESCAPE '\\' COLLATE NOCASE").join(' OR ')}
             ORDER BY unique_name
             LIMIT 25`,
            words.map(canonicalPrefix)
        );
        return { results: fuzzy, matchType: fuzzy.length > 0 ? 'fuzzy' : 'none' };
    }
}

class PlacesWrapper {
    constructor() { this.db = personPlacesPromise; }

    // Priority-ordered search so "Jerusalem" surfaces Jerusalem itself before
    // "Beautiful Gate (in Jerusalem)", etc.
    //   0 — openbible_name is exactly the query
    //   1 — unique_name starts with "query_"  (canonical name prefix)
    //   2 — openbible_name starts with the query
    //   3 — anything else that matches (fallback substring)
    async search(name) {
        const db = await this.db;
        const underscored = name.replace(/\s+/g, '_');
        const namePrefix = `${underscored}_%`;
        const obPrefix = `${name}%`;
        const obSubstr = `%${name}%`;
        return db.all(
            `SELECT id, unique_name, uStrong, openbible_name, lonlat, short_description, ext_description, pleiades, wikidata
             FROM places
             WHERE unique_name LIKE ? COLLATE NOCASE
                OR openbible_name LIKE ? COLLATE NOCASE
             ORDER BY
                CASE
                    WHEN openbible_name = ? COLLATE NOCASE THEN 0
                    WHEN unique_name LIKE ? COLLATE NOCASE THEN 1
                    WHEN openbible_name LIKE ? COLLATE NOCASE THEN 2
                    ELSE 3
                END,
                unique_name
             LIMIT 25`,
            [namePrefix, obSubstr, name, namePrefix, obPrefix]
        );
    }
}

class DictionaryWrapper {
    constructor() { this.db = dictionaryPromise; }

    async search(term) {
        const db = await this.db;

        const exactResults = await db.all(
            `SELECT e.id, e.term, e.definition, s.name AS source_name
             FROM dictionary_entries e
             JOIN dictionary_sources s ON s.id = e.source_id
             WHERE e.term = ? COLLATE NOCASE
             ORDER BY s.id`,
            [term]
        );

        if (exactResults.length > 0) {
            return { results: exactResults, matchType: 'exact' };
        }

        const fallbackResults = await db.all(
            `SELECT e.id, e.term, e.definition, s.name AS source_name
             FROM dictionary_entries e
             JOIN dictionary_sources s ON s.id = e.source_id
             WHERE e.definition LIKE ? COLLATE NOCASE
             ORDER BY LENGTH(e.definition) ASC, s.id
             LIMIT 25`,
            [`%${term}%`]
        );

        return { results: fallbackResults, matchType: 'definition' };
    }
}

class CrossRefWrapper {
    constructor() { this.db = crossRefPromise; }

    // `limit` is optional: the AI tool passes a small cap so a verse with many
    // TSK refs doesn't pull the whole set into memory just to use the first 15.
    // Slash callers (/crossref) omit it — they paginate through every ref.
    async getForVerse(canonicalBookName, chapter, verse, limit = null) {
        const db = await this.db;
        const sourceBook = toTSKSource(canonicalBookName);
        const cap = Number.isInteger(limit) && limit > 0 ? ` LIMIT ${limit}` : '';
        return db.all(
            `SELECT target_book, target_chapter, target_verse_start, target_verse_end
             FROM cross_references
             WHERE source_book = ? AND source_chapter = ? AND source_verse = ?
             ORDER BY id${cap}`,
            [sourceBook, chapter, verse]
        );
    }
}

class CategoriesWrapper {
    constructor() { this.db = categoriesPromise; }

    // `limit` is optional: the AI tool passes a cap (a major topic like "love"
    // indexes thousands of refs, but the tool only surfaces ~12). /topicalindex
    // omits it — it paginates the full set, so it needs every row.
    async getRefsForTopic(topicName, limit = null) {
        const db = await this.db;
        const cap = Number.isInteger(limit) && limit > 0 ? ` LIMIT ${limit}` : '';
        return db.all(
            `SELECT cr.book, cr.chapter, cr.verse, cr.start_verse, cr.end_verse
             FROM category_references cr
             JOIN categories c ON c.id = cr.category_id
             WHERE LOWER(c.name) = LOWER(?)
             ORDER BY cr.id${cap}`,
            [topicName]
        );
    }

    async totalCategoryCount() {
        const db = await this.db;
        const row = await db.get(`SELECT COUNT(*) AS cnt FROM categories`);
        return row?.cnt ?? 0;
    }

    // Fuzzy topic-name search for suggestion fallbacks. getRefsForTopic requires
    // an exact (case-insensitive) name match; when an AI tool-call passes a topic
    // that doesn't match exactly, this surfaces the closest indexed names so the
    // model can retry with a real one. Shortest names first (closest to the bare
    // topic, e.g. "Pride" before "The Spirit Of Pride").
    async searchTopics(partial, limit = 12) {
        const db = await this.db;
        const rows = await db.all(
            `SELECT DISTINCT name FROM categories
             WHERE LOWER(name) LIKE LOWER(?)
             ORDER BY LENGTH(name) ASC, name
             LIMIT ?`,
            [`%${partial}%`, limit]
        );
        return rows.map(r => r.name);
    }
}

class CommentaryWrapper {
    constructor() { this.db = commentaryPromise; }

    async searchProfiles(subject) {
        const db = await this.db;

        const exactResults = await db.all(
            `SELECT p.id, p.subject, p.content, p.commentaryId,
                    p.referenceBook, p.referenceChapter, p.referenceVerse,
                    p.referenceEndChapter, p.referenceEndVerse,
                    c.name AS commentaryName
             FROM CommentaryProfile p
             JOIN Commentary c ON c.id = p.commentaryId
             WHERE LOWER(p.subject) = LOWER(?)
             ORDER BY p.subject`,
            [subject]
        );

        if (exactResults.length > 0) {
            return { results: exactResults, matchType: 'exact' };
        }

        const fuzzyResults = await db.all(
            `SELECT p.id, p.subject, p.content, p.commentaryId,
                    p.referenceBook, p.referenceChapter, p.referenceVerse,
                    p.referenceEndChapter, p.referenceEndVerse,
                    c.name AS commentaryName
             FROM CommentaryProfile p
             JOIN Commentary c ON c.id = p.commentaryId
             WHERE LOWER(p.subject) LIKE LOWER(?)
             ORDER BY LENGTH(p.subject) ASC, p.subject
             LIMIT 25`,
            [`%${subject}%`]
        );

        return { results: fuzzyResults, matchType: 'fuzzy' };
    }

    async getVerseCommentary(commentaryId, bookCodes, chapter, verse) {
        const db = await this.db;
        const codes = Array.isArray(bookCodes) ? bookCodes : [bookCodes];
        if (codes.length === 0) return null;
        const placeholders = codes.map(() => '?').join(',');
        return db.get(
            `SELECT text FROM CommentaryChapterVerse
             WHERE commentaryId = ? AND bookId IN (${placeholders})
             AND chapterNumber = ? AND number = ?
             LIMIT 1`,
            [commentaryId, ...codes, chapter, verse]
        );
    }

    // Like getVerseCommentary, but when no exact verse-level entry exists, falls
    // back to the commentary block that COVERS the verse — the entry with the
    // greatest start-verse <= the target in that chapter. Necessary because some
    // commentators are passage-grouped rather than verse-by-verse: Matthew Henry's
    // entire note on Philippians 4:1-9 is keyed only at verse 1, so an exact lookup
    // for 4:6 misses entirely and silently falls back to a different commentator.
    // Returns { text, coveredFrom } — coveredFrom is the block's start verse (equals
    // the requested verse on an exact hit) so callers can label a passage note
    // accurately — or null if the commentator has nothing at/ before the verse.
    async getVerseCommentaryCovering(commentaryId, bookCodes, chapter, verse) {
        const db = await this.db;
        const codes = Array.isArray(bookCodes) ? bookCodes : [bookCodes];
        if (codes.length === 0) return null;
        const placeholders = codes.map(() => '?').join(',');
        const row = await db.get(
            `SELECT text, number FROM CommentaryChapterVerse
             WHERE commentaryId = ? AND bookId IN (${placeholders})
             AND chapterNumber = ? AND number <= ?
             ORDER BY number DESC
             LIMIT 1`,
            [commentaryId, ...codes, chapter, verse]
        );
        if (!row?.text) return null;
        return { text: row.text, coveredFrom: row.number };
    }

    /**
     * The right lookup for a commentator, chosen automatically.
     *
     * Passage-grouped commentators get the covering block; verse-by-verse ones
     * stay exact, where a miss is a genuine gap rather than a keying artefact.
     *
     * Exists because that choice used to live in aiChat.js, so /commentary, the
     * openverse button and the context menu all issued exact-only lookups and
     * silently found nothing for Henry or Keil on any verse that wasn't the
     * first of its block — which is most verses.
     */
    async getCommentaryForVerse(commentaryId, bookCodes, chapter, verse) {
        return PASSAGE_GROUPED_COMMENTATORS.has(commentaryId)
            ? this.getVerseCommentaryCovering(commentaryId, bookCodes, chapter, verse)
            : this.getVerseCommentary(commentaryId, bookCodes, chapter, verse);
    }

    async getChapterCommentary(commentaryId, bookCodes, chapter) {
        const db = await this.db;
        const codes = Array.isArray(bookCodes) ? bookCodes : [bookCodes];
        if (codes.length === 0) return null;
        const placeholders = codes.map(() => '?').join(',');
        return db.get(
            `SELECT introduction FROM CommentaryChapter
             WHERE commentaryId = ? AND bookId IN (${placeholders})
             AND number = ?
             LIMIT 1`,
            [commentaryId, ...codes, chapter]
        );
    }

    // How many of the six commentators have content for a given verse?
    // Powers the reaction-expansion stat line without doing one query per
    // commentator — a single COUNT(DISTINCT commentaryId) is ~O(ms) against
    // the indexed bookId/chapterNumber/number columns.
    async countCommentatorsForVerse(bookCodes, chapter, verse) {
        const db = await this.db;
        const codes = Array.isArray(bookCodes) ? bookCodes : [bookCodes];
        if (codes.length === 0) return 0;
        const placeholders = codes.map(() => '?').join(',');
        const row = await db.get(
            `SELECT COUNT(DISTINCT commentaryId) AS cnt FROM CommentaryChapterVerse
             WHERE bookId IN (${placeholders}) AND chapterNumber = ? AND number = ?`,
            [...codes, chapter, verse]
        );
        return row?.cnt ?? 0;
    }
}

/**
 * Brenton's English Septuagint (1851, public domain), built by src/buildLxx.js.
 *
 * Stored against MASORETIC coordinates, so callers pass the same
 * (bookId, chapter, verse) every other wrapper takes and never think about the
 * Septuagint's own numbering. Psalm 51:10 returns what the LXX prints at its
 * Psalm 50:12, and `lxx_ref` carries that address back for display — readers
 * studying the LXX want to see it, and hiding it would make the card look wrong
 * to anyone who knows.
 *
 * Two things callers must handle rather than ignore:
 *   - `approx` marks chapters where the Greek is arranged differently enough
 *     that the build could not corroborate a verse-for-verse line-up (the
 *     tabernacle account in Exodus 36-39, parts of Job and 3 Kingdoms).
 *   - A MISSING row is a real answer, not an error. The Greek genuinely lacks
 *     some Hebrew verses — Jeremiah 46:1 has no counterpart because the LXX
 *     has no such heading.
 */
class LxxWrapper {
    constructor() { this.db = lxxPromise; }

    // By Masoretic coordinates, the way every other lookup in the bot works.
    async getVerses(bookId, chapter, startVerse, endVerse) {
        const db = await this.db;
        return db.all(
            `SELECT chapter, verse, lxx_ref, approx, text
             FROM lxx
             WHERE book_id = ? AND chapter = ? AND verse BETWEEN ? AND ?
             ORDER BY verse`,
            [bookId, chapter, startVerse, endVerse]
        );
    }

    async getChapter(bookId, chapter) {
        const db = await this.db;
        return db.all(
            `SELECT chapter, verse, lxx_ref, approx, text
             FROM lxx
             WHERE book_id = ? AND chapter = ?
             ORDER BY verse`,
            [bookId, chapter]
        );
    }

    /**
     * Resolve a book name that has no Masoretic counterpart — Sirach, Tobit,
     * the Maccabees. Kept OUT of bookNames.js on purpose: those aliases feed
     * passive scripture detection, and teaching it to recognise "Tobit 4:15"
     * would have the bot react to references it cannot show from bible.db.
     */
    async resolveDeuteroBook(name) {
        const db = await this.db;
        const key = String(name ?? '').trim().toLowerCase();
        if (!key) return null;
        const row = await db.get(
            `SELECT b.code, b.name FROM lxx_alias a JOIN lxx_books b ON b.code = a.code WHERE a.alias = ?`,
            [key]
        );
        if (row) return row;
        // Awaited before the coalesce: `db.get(...) ?? null` would test the
        // PROMISE for nullishness, which it never is, and hand back undefined.
        const byName = await db.get(`SELECT code, name FROM lxx_books WHERE name = ? COLLATE NOCASE`, [name]);
        return byName ?? null;
    }

    // By the Septuagint's own address, for deuterocanonical books and for
    // anyone who asks in LXX numbering directly.
    async getByCode(code, chapter, startVerse, endVerse) {
        const db = await this.db;
        return db.all(
            `SELECT lxx_chapter AS chapter, lxx_verse AS verse, lxx_ref, approx, text
             FROM lxx
             WHERE lxx_book = ? AND lxx_chapter = ? AND lxx_verse BETWEEN ? AND ?
             ORDER BY lxx_verse`,
            [code, chapter, startVerse, endVerse]
        );
    }

    async listDeuteroBooks() {
        const db = await this.db;
        return db.all(`SELECT code, name FROM lxx_books WHERE canon = 'deutero' ORDER BY rowid`);
    }
}

export const lxxWrapper = new LxxWrapper();

/**
 * The BSB's translator footnotes ("Hebrew does not include the brother of"),
 * which bible.db's plain verse text omits. Built by src/buildBsbFootnotes.js.
 * Returns [] when the file is absent, so callers never branch on it.
 */
class BsbFootnotesWrapper {
    constructor() { this.db = bsbFootnotesPromise; }

    async getNotes(bookId, chapter, startVerse, endVerse = startVerse) {
        const db = await this.db;
        if (!db) return [];
        return db.all(
            `SELECT verse, text FROM bsb_footnotes
             WHERE book_id = ? AND chapter = ? AND verse BETWEEN ? AND ?
             ORDER BY verse, seq`,
            [bookId, chapter, startVerse, endVerse]
        );
    }
}

export const bsbFootnotesWrapper = new BsbFootnotesWrapper();

export const HALEY_CITATION = 'John W. Haley, An Examination of the Alleged Discrepancies of the Bible (1874)';
export const TORREY_CITATION = 'R. A. Torrey, Difficulties and Alleged Errors and Contradictions in the Bible (1907)';
export const difficultyCitation = source => (source === 'torrey' ? TORREY_CITATION : HALEY_CITATION);
export const difficultyAuthor = source => (source === 'torrey' ? 'Torrey' : 'Haley');

/**
 * The part of a Haley entry that is about ONE verse. Haley bundles related
 * cases - the Ahaziah entry runs on through forty regnal-year reconciliations -
 * so the opening of a long entry is often about something else. References
 * are stored in the body in modern form ("2 Kings 15:1"), so the passage can
 * be found by its chapter:verse and cut at sentence boundaries around it.
 */
/**
 * Where the body mentions chapter:verse - including inside a verse LIST.
 * Torrey writes "Gen. 4:16, 17" and Haley "14:2, 17, 23"; a search for the
 * literal "4:17" finds neither, and the excerpt then fell back to the opening
 * of the entry, cutting off the sentence that carried the argument.
 */
export function findVerseMention(body, chapter, verse) {
    const LIST = new RegExp(`\\b${chapter}:\\s*(\\d+(?:\\s*[-–]\\s*\\d+)?(?:\\s*,\\s*\\d+(?:\\s*[-–]\\s*\\d+)?)*)`, 'g');
    for (const m of body.matchAll(LIST)) {
        for (const part of m[1].split(',')) {
            const [a, b] = part.split(/[-–]/).map(x => Number.parseInt(x, 10));
            if (verse >= a && verse <= (Number.isFinite(b) ? b : a)) return m.index;
        }
    }
    return -1;
}

export function difficultyExcerpt(body, chapter, verse, limit = 700) {
    if (!body || body.length <= limit) return body ?? '';
    const at = verse != null ? findVerseMention(body, chapter, verse) : -1;
    if (at < 0) return `${body.slice(0, limit - 1).replace(/\s+\S*$/, '')}…`;
    let from = Math.max(0, at - Math.floor(limit / 3));
    const sentenceStart = body.lastIndexOf('. ', at);
    if (sentenceStart >= from - 200 && sentenceStart >= 0) from = sentenceStart + 2;
    const slice = body.slice(from, from + limit);
    return `${from > 0 ? '…' : ''}${slice.replace(/\s+\S*$/, '')}…`;
}

class DifficultiesWrapper {
    constructor() { this.db = difficultiesPromise; }

    /**
     * Entries whose references cover this verse. PRIMARY first - an entry
     * whose title and quoted texts are this verse is ABOUT it; one that cites
     * it in passing is not - then shorter reference lists, which are more
     * focused. Pass primaryOnly for automatic grounding, where a passing
     * mention would be noise on every verse Haley ever cited.
     */
    async getForVerse(bookId, chapter, verse, { primaryOnly = false, limit = 2 } = {}) {
        const db = await this.db;
        if (!db) return [];
        return db.all(
            `SELECT e.id, e.source, e.title, e.section, e.body, e.page, MAX(r.is_primary) AS is_primary,
                    (SELECT COUNT(*) FROM difficulty_refs x WHERE x.entry_id = e.id) AS ref_count
             FROM difficulty_refs r JOIN difficulty_entries e ON e.id = r.entry_id
             WHERE r.book_id = ? AND r.chapter = ?
               AND (? IS NULL OR r.start_verse IS NULL OR (r.start_verse <= ? AND r.end_verse >= ?))
               ${primaryOnly ? 'AND r.is_primary = 1' : ''}
             GROUP BY e.id
             ORDER BY is_primary DESC, ref_count ASC
             LIMIT ?`,
            // A chapter-only reference ("Judges 11") matches the whole chapter.
            // It used to be checked as verse 1, and Torrey's Jephthah chapter
            // cites 11:31 and 11:37-39, so "Judges 11" found nothing.
            [bookId, chapter, verse ?? null, verse ?? null, verse ?? null, limit]
        );
    }

    /**
     * Every chunk of one Torrey chapter, in order. Torrey writes ARGUMENTS, and
     * the chunking is ours, not his: one chunk of the Cain chapter stops just
     * before "Cain doubtless had his wife before going to the Land of Nod",
     * the sentence that carries the point, and the model filled the gap by
     * inverting Genesis 4. So a Torrey hit is answered with its chapter.
     */
    async getChapterParts(source, section) {
        const db = await this.db;
        if (!db || !section) return [];
        return db.all(
            'SELECT id, source, title, section, body, page FROM difficulty_entries WHERE source = ? AND section = ? ORDER BY id',
            [source, section]
        );
    }

    /**
     * Keyword search, weighted by how RARE each word is in the book (IDF): in
     * "how did Judas die", "judas" is in a handful of entries and "die" in
     * dozens, so a flat count ranked Aaron's death above Judas's. Title hits
     * count three times. The whole book is ~1 MB, so it is indexed in memory
     * once, on first use.
     */
    async search(query, limit = 3) {
        const docs = await this.#docs();
        if (!docs.length) return [];
        const terms = [...new Set((String(query).toLowerCase().match(/[a-z]{3,}/g) ?? []))]
            .filter(t => !STOPWORDS.has(t)).slice(0, 8);
        if (terms.length === 0) return [];
        const hit = (text, t) => new RegExp(`\\b${t}`).test(text);
        const idf = Object.fromEntries(terms.map(t => {
            const df = docs.filter(d => hit(d.lowTitle, t) || hit(d.lowBody, t)).length;
            return [t, df ? Math.log(1 + docs.length / df) : 0];
        }));
        return docs
            .map(d => ({ ...d, score: terms.reduce((sum, t) => sum + idf[t] * ((hit(d.lowTitle, t) ? 3 : 0) + (hit(d.lowBody, t) ? 1 : 0)), 0) }))
            .filter(d => d.score > 0)
            .sort((x, y) => y.score - x.score || x.body.length - y.body.length)
            .slice(0, limit)
            .map(d => ({ id: d.id, source: d.source, title: d.title, section: d.section, body: d.body, page: d.page, score: d.score }));
    }

    async #docs() {
        if (!this.docsPromise) {
            this.docsPromise = this.db.then(db => (db
                ? db.all('SELECT id, source, title, section, body, page FROM difficulty_entries')
                : []))
                .then(rows => rows.map(r => ({ ...r, lowTitle: r.title.toLowerCase(), lowBody: r.body.toLowerCase() })))
                .catch(() => { this.docsPromise = null; return []; });
        }
        return this.docsPromise;
    }
}

const STOPWORDS = new Set(['the', 'and', 'bible', 'contradiction', 'contradictions', 'contradict', 'does', 'did', 'was', 'who', 'why', 'how', 'what', 'with', 'for', 'say', 'says', 'said', 'about', 'discrepancy', 'discrepancies', 'versus', 'between', 'this', 'that']);

/**
 * Choose among entries that all treat a verse as primary. A verse can sit in
 * more than one of Haley's cases - 2 Kings 8:26 is both "Ahaziah's age, 22 or
 * 42" and "Ahaziah's grandfather, Omri or Ahab" - and nothing about the verse
 * can decide between them. The question can: pick the entry whose title
 * shares the most words, and numbers, with what the person actually wrote.
 * Falls back to the given order when nothing overlaps.
 */
export function pickDifficulty(rows, text) {
    if (!rows?.length) return null;
    const NUMBER_WORDS = { twenty: 20, thirty: 30, forty: 40, fifty: 50, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10 };
    const tokens = s => {
        const low = String(s ?? '').toLowerCase();
        const set = new Set((low.match(/[a-z]{3,}/g) ?? []).filter(w => !STOPWORDS.has(w)));
        for (const n of low.match(/\d+/g) ?? []) set.add(n);
        // "twenty-two" in Haley's titles against "22" in a modern question
        for (const [, tens, unit] of low.matchAll(/(twenty|thirty|forty|fifty)-(two|three|four|five|six|seven|eight|nine)/g)) {
            set.add(String(NUMBER_WORDS[tens] + NUMBER_WORDS[unit]));
        }
        return set;
    };
    const asked = tokens(text);
    let best = rows[0], bestScore = 0;
    for (const r of rows) {
        const t = tokens(r.title);
        const score = [...t].filter(w => asked.has(w)).length;
        if (score > bestScore) { best = r; bestScore = score; }
    }
    return best;
}

export const difficultiesWrapper = new DifficultiesWrapper();
export const fathersWrapper = new FathersWrapper();
export const personsWrapper = new PersonsWrapper();
export const placesWrapper = new PlacesWrapper();
export const dictionaryWrapper = new DictionaryWrapper();
export const crossRefWrapper = new CrossRefWrapper();
export const categoriesWrapper = new CategoriesWrapper();
export const commentaryWrapper = new CommentaryWrapper();
