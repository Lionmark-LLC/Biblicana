import {
    EmbedBuilder,
    ContainerBuilder,
    SectionBuilder,
    TextDisplayBuilder,
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    StringSelectMenuBuilder,
    MessageFlags
} from 'discord.js';
import { bibleWrapper } from '../../utils/bibleHelper.js';
import { getVersification } from '../../utils/versification.js';
import { numbersToBook, getBookId, toOSIS3Codes, toCommentaryVariants } from '../../utils/bookNames.js';
import { commentaryWrapper, crossRefWrapper, fathersWrapper, pickMarqueeFather, COMMENTATORS } from '../../utils/studyHelper.js';
import { renderInterlinearEphemeral } from '../../utils/interlinearRenderer.js';
import { renderParallelEphemeral } from '../../utils/parallelRenderer.js';
import { renderBibleEphemeral } from '../../utils/bibleRenderer.js';
import { accentColor, footerLine, footerText } from '../../utils/theme.js';
import { attachPageCollector, buildPageNavRow, isExpiredInteractionError } from '../../utils/paginationHelper.js';
import splitString from '../../utils/splitString.js';
import logger from '../../utils/logger.js';
import { reportError } from '../../utils/errorReporting.js';
import 'dotenv/config';

const COMMENTARY_MAX_CHARS = 3800;
const XREF_MAX_FETCH = 50;
const XREF_PER_PAGE = 8;
const COLLECTOR_TIMEOUT_MS = 600_000;

// Fallback order for /bible's [Commentary] button. Adam Clarke first (our
// default), then the others. Keil is filtered out for NT books at the call
// site (he only covers OT); Tyndale has no chapter-level intros.
const COMMENTARY_FALLBACK_ORDER = [
    'adam-clarke',
    'jamieson-fausset-brown',
    'john-gill',
    'matthew-henry',
    'keil-delitzsch',
    'tyndale'
];

async function userTranslation(database, userId) {
    try {
        const userPref = await database.getUserValue(userId);
        if (userPref?.translation) return userPref.translation;
    } catch (dbError) {
        reportError(dbError, { area: 'button', handler: 'openverse' });
        logger.error(`[OpenVerse Button] Failed to get user preference: ${dbError.message}`);
    }
    return 'BSB';
}

function baseEmbedColor() {
    return process.env.EMBEDCOLOR ? parseInt(process.env.EMBEDCOLOR, 16) : 0x0099FF;
}

function standardFooter(extra = '') {
    const suffix = extra ? ` | ${extra}` : '';
    return {
        text: `${footerText()}${suffix}`.trim(),
        iconURL: process.env.EMBEDICONURL
    };
}

// --- Interlinear ----------------------------------------------------------

async function handleInterlinear({ interaction, bookId, chapter, verse, translation }) {
    await renderInterlinearEphemeral({ interaction, bookId, chapter, verse, translation });
}

async function handleBible({ interaction, bookId, chapter, startVerse, endVerse, translation }) {
    await renderBibleEphemeral({ interaction, bookId, chapter, startVerse, endVerse, translation });
}

// Opens a full chapter as a verse range (1..200). bibleRenderer truncates long
// chapter bodies — typical chapters are 20-50 verses and fit comfortably.
async function handleChapter({ interaction, bookId, chapter, translation }) {
    await renderBibleEphemeral({
        interaction,
        bookId,
        chapter,
        startVerse: 1,
        endVerse: 200,
        translation
    });
}

// --- Commentary (with fallback chain + commentator dropdown) -------------

function buildChapterCommentaryEmbed({ commentator, pages, pageIdx, bookName, chapter }) {
    const totalPages = pages.length;
    const pageInfo = totalPages > 1 ? ` · Page ${pageIdx + 1}/${totalPages}` : '';
    return new EmbedBuilder()
        .setColor(baseEmbedColor())
        .setTitle(`📚 ${commentator.label}: ${bookName} ${chapter} (chapter intro)${pageInfo}`)
        .setDescription(pages[pageIdx] ?? '')
        .setURL(process.env.WEBSITE)
        .setFooter(standardFooter(commentator.label));
}

// Chapter-level commentary path. Tyndale has no chapter intros (skip); Keil is
// OT-only. Fall through remaining commentators in order and also expose a
// SelectMenu so the user can swap commentators without leaving the reply.
async function handleChapterCommentary({ interaction, bookId, bookCodes, chapter, bookName }) {
    const isNT = bookId > 39;
    const availableIds = [
        'adam-clarke',
        'jamieson-fausset-brown',
        'john-gill',
        'matthew-henry',
        'keil-delitzsch'
    ].filter(id => !(id === 'keil-delitzsch' && isNT));

    let found = null;
    for (const id of availableIds) {
        const row = await commentaryWrapper.getChapterCommentary(id, bookCodes, chapter);
        if (row?.introduction) {
            found = { commentatorId: id, text: row.introduction };
            break;
        }
    }

    if (!found) {
        return interaction.reply({
            content: `No chapter-level introduction available for ${bookName} ${chapter} from any commentator.`,
            flags: MessageFlags.Ephemeral
        });
    }

    const available = COMMENTATORS.filter(c => availableIds.includes(c.id));
    let currentId = found.commentatorId;
    let pages = splitString(found.text, COMMENTARY_MAX_CHARS);
    let pageIdx = 0;

    const renderEmbed = () => buildChapterCommentaryEmbed({
        commentator: COMMENTATORS.find(c => c.id === currentId),
        pages, pageIdx, bookName, chapter
    });
    const renderComponents = ({ disabled = false } = {}) => {
        const rows = [buildCommentarySelect({ availableCommentators: available, currentId, disabled })];
        if (pages.length > 1) {
            rows.push(buildPageNavRow({ pageIdx, totalPages: pages.length, disabled }));
        }
        return rows;
    };

    await interaction.reply({
        embeds: [renderEmbed()],
        components: renderComponents(),
        flags: MessageFlags.Ephemeral
    });

    try {
        const message = await interaction.fetchReply();
        const filter = i => i.user.id === interaction.user.id &&
            (i.customId === 'cmtr_select' || i.customId === 'page_back' || i.customId === 'page_next');
        const collector = message.createMessageComponentCollector({ filter, time: COLLECTOR_TIMEOUT_MS });

        collector.on('collect', async i => {
            try {
                await i.deferUpdate();
                if (i.customId === 'cmtr_select') {
                    const pickedId = i.values[0];
                    const picked = COMMENTATORS.find(c => c.id === pickedId);
                    if (!picked) return;

                    const row = await commentaryWrapper.getChapterCommentary(pickedId, bookCodes, chapter);
                    if (!row?.introduction) {
                        const noDataEmbed = new EmbedBuilder()
                            .setColor(baseEmbedColor())
                            .setTitle(`📚 ${picked.label}: ${bookName} ${chapter} (chapter intro)`)
                            .setDescription(`*${picked.label} doesn't have a chapter-level introduction for **${bookName} ${chapter}**. Pick another commentator from the dropdown.*`)
                            .setURL(process.env.WEBSITE)
                            .setFooter(standardFooter(picked.label));
                        await i.editReply({
                            embeds: [noDataEmbed],
                            components: [buildCommentarySelect({ availableCommentators: available, currentId: pickedId })]
                        });
                        return;
                    }

                    currentId = pickedId;
                    pages = splitString(row.introduction, COMMENTARY_MAX_CHARS);
                    pageIdx = 0;
                } else if (i.customId === 'page_back') {
                    pageIdx = Math.max(0, pageIdx - 1);
                } else if (i.customId === 'page_next') {
                    pageIdx = Math.min(pages.length - 1, pageIdx + 1);
                }

                await i.editReply({ embeds: [renderEmbed()], components: renderComponents() });
            } catch (err) {
                reportError(err, { area: 'button', handler: 'openverse' });
                logger.error(`[OpenVerse ChapterCommentary] Collector error: ${err.message}`);
            }
        });

        collector.on('end', async () => {
            try {
                await interaction.editReply({ components: renderComponents({ disabled: true }) });
            } catch (err) {
                if (!isExpiredInteractionError(err)) {
                    reportError(err, { area: 'button', handler: 'openverse' });
                    logger.error(`[OpenVerse ChapterCommentary] End error: ${err.message}`);
                }
            }
        });
    } catch (err) {
        reportError(err, { area: 'button', handler: 'openverse' });
        logger.error(`[OpenVerse ChapterCommentary] Setup error: ${err.message}`);
    }
}

async function fetchCommentaryWithFallback({ bookId, chapter, verse, preferredId = 'adam-clarke' }) {
    const bookCodes = toOSIS3Codes(bookId);
    if (bookCodes.length === 0) return null;

    const isNT = bookId > 39;
    // Preferred first, then the rest in canonical fallback order (deduped).
    const order = [preferredId, ...COMMENTARY_FALLBACK_ORDER.filter(id => id !== preferredId)];

    for (const id of order) {
        if (id === 'keil-delitzsch' && isNT) continue;
        const row = await commentaryWrapper.getCommentaryForVerse(id, bookCodes, chapter, verse);
        if (row?.text) return { commentatorId: id, text: row.text };
    }
    return null;
}

// Renders one page of an already-split commentary. `pages` comes from
// splitString(text, COMMENTARY_MAX_CHARS) so long commentary (e.g. Clarke on
// Matthew 5:1) paginates inline rather than truncating. The fallback note shows
// only on page 0 — it refers to the initial commentator pick and shouldn't
// repeat across pages or eat the later pages' character budget.
function buildCommentaryEmbed({ commentator, pages, pageIdx, bookName, chapter, verse, wasFallback = false, preferredLabel = null }) {
    const totalPages = pages.length;
    const pageInfo = totalPages > 1 ? ` · Page ${pageIdx + 1}/${totalPages}` : '';
    const body = pages[pageIdx] ?? '';
    const description = (wasFallback && preferredLabel && pageIdx === 0)
        ? `*${preferredLabel} had no commentary on this verse — showing ${commentator.label} instead. Switch commentators below.*\n\n${body}`
        : body;

    return new EmbedBuilder()
        .setColor(baseEmbedColor())
        .setTitle(`📚 ${commentator.label}: ${bookName} ${chapter}:${verse}${pageInfo}`)
        .setDescription(description)
        .setURL(process.env.WEBSITE)
        .setFooter(standardFooter(commentator.label));
}

function buildCommentarySelect({ availableCommentators, currentId, disabled = false }) {
    return new ActionRowBuilder().addComponents(
        new StringSelectMenuBuilder()
            .setCustomId('cmtr_select')
            .setPlaceholder('Switch commentator')
            .setDisabled(disabled)
            .addOptions(availableCommentators.map(c => ({
                label: c.label,
                value: c.id,
                default: c.id === currentId
            })))
    );
}

async function handleCommentary({ interaction, bookId, chapter, verse, bookName }) {
    const bookCodes = toOSIS3Codes(bookId);
    if (bookCodes.length === 0) {
        return interaction.reply({
            content: `Commentary isn't supported for ${bookName}.`,
            flags: MessageFlags.Ephemeral
        });
    }

    // verse=0 sentinel means "chapter-level commentary" (used by /audio and
    // future callers that want the chapter introduction rather than a verse note).
    const isChapterLevel = verse === 0;
    if (isChapterLevel) {
        return handleChapterCommentary({ interaction, bookId, bookCodes, chapter, bookName });
    }

    const result = await fetchCommentaryWithFallback({ bookId, chapter, verse });
    if (!result) {
        return interaction.reply({
            content: `No commentary available on ${bookName} ${chapter}:${verse} from any of the 6 commentators.`,
            flags: MessageFlags.Ephemeral
        });
    }

    const preferredId = COMMENTARY_FALLBACK_ORDER[0]; // Adam Clarke
    const preferred = COMMENTATORS.find(c => c.id === preferredId);
    const initialWasFallback = result.commentatorId !== preferredId;

    const isNT = bookId > 39;
    const available = COMMENTATORS.filter(c => !(c.id === 'keil-delitzsch' && isNT));

    // Mutable view state, driven by the single collector below. Switching
    // commentator re-splits the new text and resets to page 0; the nav buttons
    // walk pageIdx. The fallback note only shows while still on the auto-picked
    // fallback commentator (clears once the user switches manually).
    let currentId = result.commentatorId;
    let pages = splitString(result.text, COMMENTARY_MAX_CHARS);
    let pageIdx = 0;

    const renderEmbed = () => buildCommentaryEmbed({
        commentator: COMMENTATORS.find(c => c.id === currentId),
        pages, pageIdx, bookName, chapter, verse,
        wasFallback: currentId === result.commentatorId && initialWasFallback,
        preferredLabel: preferred?.label
    });
    const renderComponents = ({ disabled = false } = {}) => {
        const rows = [buildCommentarySelect({ availableCommentators: available, currentId, disabled })];
        if (pages.length > 1) {
            rows.push(buildPageNavRow({ pageIdx, totalPages: pages.length, disabled }));
        }
        return rows;
    };

    await interaction.reply({
        embeds: [renderEmbed()],
        components: renderComponents(),
        flags: MessageFlags.Ephemeral
    });

    try {
        const message = await interaction.fetchReply();
        // One collector for BOTH the commentator dropdown and the page-nav
        // buttons — so no componentType restriction (that would drop button
        // clicks and was the original reason long commentary had no working nav).
        const filter = i => i.user.id === interaction.user.id &&
            (i.customId === 'cmtr_select' || i.customId === 'page_back' || i.customId === 'page_next');
        const collector = message.createMessageComponentCollector({ filter, time: COLLECTOR_TIMEOUT_MS });

        collector.on('collect', async i => {
            try {
                await i.deferUpdate();
                if (i.customId === 'cmtr_select') {
                    const pickedId = i.values[0];
                    const picked = COMMENTATORS.find(c => c.id === pickedId);
                    if (!picked) return;

                    const row = await commentaryWrapper.getCommentaryForVerse(pickedId, bookCodes, chapter, verse);
                    if (!row?.text) {
                        const noDataEmbed = new EmbedBuilder()
                            .setColor(baseEmbedColor())
                            .setTitle(`📚 ${picked.label}: ${bookName} ${chapter}:${verse}`)
                            .setDescription(`*${picked.label} doesn't have commentary on **${bookName} ${chapter}:${verse}**. Pick another commentator from the dropdown.*`)
                            .setURL(process.env.WEBSITE)
                            .setFooter(standardFooter(picked.label));
                        await i.editReply({
                            embeds: [noDataEmbed],
                            components: [buildCommentarySelect({ availableCommentators: available, currentId: pickedId })]
                        });
                        return;
                    }

                    currentId = pickedId;
                    pages = splitString(row.text, COMMENTARY_MAX_CHARS);
                    pageIdx = 0;
                } else if (i.customId === 'page_back') {
                    pageIdx = Math.max(0, pageIdx - 1);
                } else if (i.customId === 'page_next') {
                    pageIdx = Math.min(pages.length - 1, pageIdx + 1);
                }

                await i.editReply({ embeds: [renderEmbed()], components: renderComponents() });
            } catch (err) {
                reportError(err, { area: 'button', handler: 'openverse' });
                logger.error(`[OpenVerse Commentary] Collector error: ${err.message}`);
            }
        });

        collector.on('end', async () => {
            try {
                await interaction.editReply({ components: renderComponents({ disabled: true }) });
            } catch (err) {
                if (!isExpiredInteractionError(err)) {
                    reportError(err, { area: 'button', handler: 'openverse' });
                    logger.error(`[OpenVerse Commentary] End error: ${err.message}`);
                }
            }
        });
    } catch (err) {
        reportError(err, { area: 'button', handler: 'openverse' });
        logger.error(`[OpenVerse Commentary] Setup error: ${err.message}`);
    }
}

// --- Crossref (paginated) -------------------------------------------------

function buildXrefPage({ processed, sourceLabel, sourceText, translation, pageIdx, totalPages, totalRefCount, disableNav = false }) {
    const start = pageIdx * XREF_PER_PAGE;
    const pageRefs = processed.slice(start, start + XREF_PER_PAGE);
    const pageInfo = totalPages > 1 ? ` · Page ${pageIdx + 1}/${totalPages}` : '';

    const container = new ContainerBuilder()
        .setAccentColor(accentColor())
        .addTextDisplayComponents(new TextDisplayBuilder().setContent(
            `## 🔗 Cross References — ${sourceLabel}${pageInfo}`
        ))
        .addTextDisplayComponents(new TextDisplayBuilder().setContent(
            `**${translation.toUpperCase()}:** ${sourceText}`
        ));

    pageRefs.forEach((ref, localIdx) => {
        const globalIdx = start + localIdx;
        container.addSectionComponents(
            new SectionBuilder()
                .addTextDisplayComponents(new TextDisplayBuilder().setContent(`**${ref.label}** — ${ref.text}`))
                .setButtonAccessory(
                    new ButtonBuilder()
                        .setCustomId(`openverse:bible:${ref.bookId}:${ref.chapter}:${ref.startVerse}:${ref.endVerse}:x${globalIdx}`)
                        .setLabel('Open')
                        .setEmoji({ name: '📖' })
                        .setStyle(ButtonStyle.Secondary)
                )
        );
    });

    const shownSuffix = totalRefCount > processed.length
        ? ` | ${processed.length} of ${totalRefCount} shown`
        : '';
    container.addTextDisplayComponents(new TextDisplayBuilder().setContent(
        footerLine(`Translation: ${translation.toUpperCase()}${shownSuffix}`)
    ));

    const components = [container];
    if (totalPages > 1) {
        components.push(buildPageNavRow({ pageIdx, totalPages, disabled: disableNav }));
    }
    return components;
}

async function handleCrossref({ interaction, bookId, chapter, verse, bookName, translation }) {
    // Same shape as /crossref command — Section-per-ref with [📖 Open] buttons
    // that chain back into openverse:bible so the user can drill into any ref.
    const [refsResult, sourceResult] = await Promise.allSettled([
        crossRefWrapper.getForVerse(bookName, chapter, verse),
        bibleWrapper.getVerses(bookId, chapter, verse, verse)
    ]);

    if (refsResult.status === 'rejected' || !refsResult.value || refsResult.value.length === 0) {
        return interaction.reply({
            content: `No cross-references found for ${bookName} ${chapter}:${verse}.`,
            flags: MessageFlags.Ephemeral
        });
    }

    const refs = refsResult.value;
    const sourceText = (sourceResult.status === 'fulfilled' && sourceResult.value?.[0])
        ? (sourceResult.value[0][translation] || sourceResult.value[0].BSB || '')
        : '';
    const sourceLabel = `${bookName} ${chapter}:${verse}`;

    const fetchable = refs.slice(0, XREF_MAX_FETCH);

    const processed = (await Promise.allSettled(fetchable.map(async ref => {
        const refBookId = getBookId(ref.target_book);
        const refBookName = refBookId ? numbersToBook.get(refBookId) : null;
        if (!refBookId || !refBookName) return null;

        const endVerse = ref.target_verse_end || ref.target_verse_start;
        const data = await bibleWrapper.getVerses(refBookId, ref.target_chapter, ref.target_verse_start, endVerse);
        if (!data || data.length === 0) return null;

        const text = data.map(v => v[translation] || v.BSB).filter(Boolean).join(' ');
        if (!text) return null;

        const rangeLabel = endVerse > ref.target_verse_start
            ? `${refBookName} ${ref.target_chapter}:${ref.target_verse_start}-${endVerse}`
            : `${refBookName} ${ref.target_chapter}:${ref.target_verse_start}`;
        return {
            label: rangeLabel,
            text: text.length > 300 ? text.substring(0, 299) + '…' : text,
            bookId: refBookId,
            chapter: ref.target_chapter,
            startVerse: ref.target_verse_start,
            endVerse
        };
    })))
        .filter(r => r.status === 'fulfilled' && r.value)
        .map(r => r.value);

    if (processed.length === 0) {
        return interaction.reply({
            content: `Cross-references found but couldn't retrieve verse text in ${translation.toUpperCase()}.`,
            flags: MessageFlags.Ephemeral
        });
    }

    const totalPages = Math.ceil(processed.length / XREF_PER_PAGE);

    await interaction.reply({
        flags: MessageFlags.IsComponentsV2 | MessageFlags.Ephemeral,
        components: buildXrefPage({
            processed, sourceLabel, sourceText, translation,
            pageIdx: 0, totalPages, totalRefCount: refs.length
        })
    });

    if (totalPages <= 1) return;

    const message = await interaction.fetchReply();
    attachPageCollector({
        interaction, message, totalPages,
        logLabel: '[OpenVerse Xref]',
        render: (pageIdx, { disableNav }) =>
            buildXrefPage({
                processed, sourceLabel, sourceText, translation,
                pageIdx, totalPages, totalRefCount: refs.length, disableNav
            })
    });
}

// --- Parallel (single page, all translations local) ----------------------

async function handleParallel({ interaction, bookId, chapter, verse, translation }) {
    await renderParallelEphemeral({ interaction, bookId, chapter, verse, primaryTranslation: translation });
}

// --- Church Fathers (one-shot ephemeral first-Father preview) -------------
// Full paginated view lives in /fathers; this button is a quick look that
// leads with whoever the extrabiblical_data.sqlite query returns first
// alphabetically (canonically starts with "Augustine of Hippo" / "Ambrose"
// for most well-commented verses). Users wanting the full list are nudged
// toward /fathers.
const FATHERS_PREVIEW_LIMIT = 2500;

const FATHERS_DROPDOWN_CAP = 25;              // Discord select-menu hard cap
const FATHERS_COLLECTOR_TIMEOUT_MS = 1_800_000; // 30 min — matches /commentary

async function handleFathers({ interaction, chapter, verse, bookName }) {
    const bookVariants = toCommentaryVariants(bookName);
    const rows = await fathersWrapper.getByPassage(bookVariants, chapter, verse);
    if (!rows || rows.length === 0) {
        return interaction.reply({
            content: `No Church Fathers commentary found for ${bookName} ${chapter}:${verse}.`,
            flags: MessageFlags.Ephemeral,
        });
    }

    // Group rows by father_name. Augustine (and others) may have multiple
    // entries on a single verse — we want one dropdown option per Father.
    const byName = new Map();
    for (const r of rows) {
        if (!byName.has(r.father_name)) byName.set(r.father_name, []);
        byName.get(r.father_name).push(r);
    }

    // Marquee-prioritized ordering: the lead Father matches whatever the
    // reaction-expansion stat line advertised. Remaining Fathers keep their
    // alphabetical order from the SQL.
    const leadName = pickMarqueeFather(rows);
    const orderedNames = [...byName.keys()];
    if (leadName) {
        const idx = orderedNames.indexOf(leadName);
        if (idx > 0) { orderedNames.splice(idx, 1); orderedNames.unshift(leadName); }
    }
    const cappedNames = orderedNames.slice(0, FATHERS_DROPDOWN_CAP);
    const truncatedFathers = orderedNames.length > FATHERS_DROPDOWN_CAP;

    // State maintained in closure. pageIdx is a flat index across ALL pages
    // of the currently-selected Father's entries (e.g., Augustine's 2 entries
    // of 3 pages each = 6 total positions, Prev/Next walks linearly).
    let selectedName = leadName ?? cappedNames[0];
    let pageIdx = 0;

    // Lazy per-Father pagination cache so Prev/Next doesn't re-split.
    const pagesCache = new Map();
    const pagesFor = (name) => {
        if (!pagesCache.has(name)) {
            const rows = byName.get(name) ?? [];
            const pages = [];
            rows.forEach((entry, entryIdx) => {
                const chunks = splitString(entry.txt || '*No commentary text available.*', FATHERS_PREVIEW_LIMIT);
                chunks.forEach((text, pageInEntryIdx) => {
                    pages.push({ entry, entryIdx, pageInEntryIdx, pagesInEntry: chunks.length, text });
                });
            });
            pagesCache.set(name, pages);
        }
        return pagesCache.get(name);
    };

    const renderView = ({ disabled = false } = {}) => {
        const pages = pagesFor(selectedName);
        const clampedIdx = Math.max(0, Math.min(pageIdx, pages.length - 1));
        const current = pages[clampedIdx];
        const entry = current.entry;
        const entryCount = (byName.get(selectedName) ?? []).length;

        let suffix = '';
        if (entryCount > 1) suffix += ` · entry ${current.entryIdx + 1}/${entryCount}`;
        if (current.pagesInEntry > 1) suffix += ` · page ${current.pageInEntryIdx + 1}/${current.pagesInEntry}`;

        const truncNote = truncatedFathers
            ? `\n-# Showing top ${FATHERS_DROPDOWN_CAP} of ${orderedNames.length} Fathers. Full list: \`/fathers\`.`
            : '';

        const container = new ContainerBuilder()
            .setAccentColor(accentColor())
            .addTextDisplayComponents(new TextDisplayBuilder().setContent(
                `## 📜 ${selectedName} on ${bookName} ${chapter}:${verse}${suffix}`
            ))
            .addTextDisplayComponents(new TextDisplayBuilder().setContent(current.text + truncNote))
            .addTextDisplayComponents(new TextDisplayBuilder().setContent(
                footerLine(entry.source_title || 'Church Fathers')
            ));

        const components = [container];

        // Nav row: visible when the Father has >1 total page (across entries).
        if (pages.length > 1) {
            components.push(new ActionRowBuilder().addComponents(
                new ButtonBuilder()
                    .setCustomId('fathers_prev')
                    .setLabel('Previous')
                    .setEmoji({ name: '◀️' })
                    .setStyle(ButtonStyle.Secondary)
                    .setDisabled(disabled || clampedIdx === 0),
                new ButtonBuilder()
                    .setCustomId('fathers_next')
                    .setLabel('Next')
                    .setEmoji({ name: '▶️' })
                    .setStyle(ButtonStyle.Secondary)
                    .setDisabled(disabled || clampedIdx === pages.length - 1),
            ));
        }

        // Switch-Father select: only when there's more than one Father.
        if (cappedNames.length > 1) {
            const select = new StringSelectMenuBuilder()
                .setCustomId('fathers_select')
                .setPlaceholder('Switch Father')
                .setDisabled(disabled)
                .addOptions(cappedNames.map(name => {
                    const count = byName.get(name).length;
                    return {
                        label: name.slice(0, 100),
                        value: name.slice(0, 100),
                        description: count > 1 ? `${count} entries on this verse` : undefined,
                        default: name === selectedName,
                    };
                }));
            components.push(new ActionRowBuilder().addComponents(select));
        }

        return components;
    };

    await interaction.reply({
        flags: MessageFlags.IsComponentsV2 | MessageFlags.Ephemeral,
        components: renderView(),
    });

    // Only attach a collector if there's actually something to switch between
    // (multiple Fathers OR a Father with multiple pages).
    const leadPages = pagesFor(selectedName).length;
    if (cappedNames.length <= 1 && leadPages <= 1) return;

    const reply = await interaction.fetchReply();
    const filter = i => i.user.id === interaction.user.id
        && (i.customId === 'fathers_select' || i.customId === 'fathers_prev' || i.customId === 'fathers_next');
    const collector = reply.createMessageComponentCollector({ filter, time: FATHERS_COLLECTOR_TIMEOUT_MS });

    collector.on('collect', async i => {
        try {
            await i.deferUpdate();
            if (i.customId === 'fathers_select') {
                const picked = i.values[0];
                if (byName.has(picked)) {
                    selectedName = picked;
                    pageIdx = 0;
                }
            } else if (i.customId === 'fathers_prev') {
                pageIdx = Math.max(0, pageIdx - 1);
            } else if (i.customId === 'fathers_next') {
                const max = pagesFor(selectedName).length - 1;
                pageIdx = Math.min(max, pageIdx + 1);
            }
            await i.editReply({
                flags: MessageFlags.IsComponentsV2 | MessageFlags.Ephemeral,
                components: renderView(),
            });
        } catch (err) {
            reportError(err, { area: 'button', handler: 'openverse' });
            logger.error(`[OpenVerse Fathers] Collector error: ${err.message}`);
        }
    });

    collector.on('end', async () => {
        try {
            // Re-render with all interactive components disabled so stale
            // controls don't look clickable after the 30-min window.
            await interaction.editReply({
                flags: MessageFlags.IsComponentsV2 | MessageFlags.Ephemeral,
                components: renderView({ disabled: true }),
            });
        } catch (err) {
            if (!isExpiredInteractionError(err)) {
                reportError(err, { area: 'button', handler: 'openverse' });
                logger.error(`[OpenVerse Fathers] End error: ${err.message}`);
            }
        }
    });
}

// --- Dispatcher -----------------------------------------------------------

export default {
    id: 'openverse',
    async execute(interaction, database) {
        // customId format: `openverse:<action>:<bookId>:<chapter>:<startVerse>[:<endVerse>[:<occurrenceIdx>]]`
        // The optional 6th part encodes an end verse for range lookups.
        // The optional 7th part is a free-form uniqueness suffix (used when the
        // same verse ref appears multiple times in one message — e.g., duplicate
        // Messianic prophecy refs in /propheciesofjesus, duplicate commentary
        // contexts in /topic). The handler ignores it.
        const parts = interaction.customId.split(':');
        if (parts.length < 5 || parts.length > 7) {
            logger.warn(`[OpenVerse Button] Malformed customId: ${interaction.customId}`);
            return interaction.reply({ content: 'Invalid action.', flags: MessageFlags.Ephemeral });
        }

        const [, action, bookIdStr, chapterStr, startVerseStr, endVerseStr] = parts;
        const bookId = parseInt(bookIdStr);
        const chapter = parseInt(chapterStr);
        const startVerse = parseInt(startVerseStr);
        const endVerse = endVerseStr ? parseInt(endVerseStr) : startVerse;
        const bookName = numbersToBook.get(bookId);

        if (!bookName || isNaN(chapter) || isNaN(startVerse) || isNaN(endVerse)) {
            return interaction.reply({ content: 'Invalid verse reference.', flags: MessageFlags.Ephemeral });
        }

        // A button can outlive the card that made it valid - an old card from
        // before references were checked, or a replayed customId. The check is
        // synchronous against a table loaded at startup, so it costs nothing
        // ahead of the ack. 'chapter' carries a placeholder verse, so only the
        // chapter is checked for it.
        const versification = await getVersification();
        const target = { bookId, bookName, chapter, startVerse: action === 'chapter' ? null : startVerse };
        if (!versification.exists(target)) {
            logger.info(`[OpenVerse Button] No such reference ${bookName} ${chapter}:${startVerse} action=${action}`);
            return interaction.reply({
                content: versification.describeMissing(target) ?? 'That verse does not exist.',
                flags: MessageFlags.Ephemeral,
            });
        }

        const translation = await userTranslation(database, interaction.user.id);

        try {
            switch (action) {
                case 'bible':
                    return await handleBible({ interaction, bookId, chapter, startVerse, endVerse, translation });
                case 'chapter':
                    return await handleChapter({ interaction, bookId, chapter, translation });
                case 'interlinear':
                    return await handleInterlinear({ interaction, bookId, chapter, verse: startVerse, translation });
                case 'commentary':
                    return await handleCommentary({ interaction, bookId, chapter, verse: startVerse, bookName });
                case 'xref':
                    return await handleCrossref({ interaction, bookId, chapter, verse: startVerse, bookName, translation });
                case 'parallel':
                    return await handleParallel({ interaction, bookId, chapter, verse: startVerse, translation });
                case 'fathers':
                    return await handleFathers({ interaction, bookId, chapter, verse: startVerse, bookName });
                default:
                    return interaction.reply({ content: `Unknown action: ${action}`, flags: MessageFlags.Ephemeral });
            }
        } catch (error) {
            reportError(error, { area: 'button', handler: 'openverse' });
            logger.error(`[OpenVerse Button] Error handling ${action} for ${bookName} ${chapter}:${startVerse}: ${error.message}`, error.stack);
            try {
                if (!interaction.replied && !interaction.deferred) {
                    await interaction.reply({
                        content: `Sorry, couldn't load ${action}. ${error.message}`,
                        flags: MessageFlags.Ephemeral
                    });
                }
            } catch (replyError) {
                logger.error(`[OpenVerse Button] Failed to send error reply: ${replyError.message}`);
            }
        }
    }
};
