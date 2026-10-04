import {
    SlashCommandBuilder,
    ContainerBuilder,
    SectionBuilder,
    TextDisplayBuilder,
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    MessageFlags,
    ApplicationIntegrationType,
    InteractionContextType
} from 'discord.js';
import axios from 'axios';
import swearWordFilter, { escapeMarkdown } from '../utils/filter.js';
import { bibleWrapper, coerceTranslation } from '../utils/bibleHelper.js';
import { numbersToBook, bookAbbreviations, getBookId } from '../utils/bookNames.js';
import { accentColor, footerLine } from '../utils/theme.js';
import { attachPageCollector } from '../utils/paginationHelper.js';
import { checkAckStatus, buildAckDisclosureV2, buildLegalNoticeV2, disclosureOptionsFor } from '../utils/aiAck.js';
import logger from '../utils/logger.js';
import { reportError } from '../utils/errorReporting.js';

export const VERSES_PER_PAGE = 5;
const PAGINATION_TIMEOUT_MS = 900_000;
const OPENAI_MODEL = 'gpt-5.6-luna';
// Budget shares with hidden reasoning tokens on the GPT-5 family, so it is
// sized well above the JSON array this actually needs to emit.
const OPENAI_MAX_TOKENS = 2000;
const OPENAI_TIMEOUT_MS = 15_000;
const VERSE_TEXT_TRUNCATE = 300;
const RATE_LIMIT = { limit: 10, windowSeconds: 3600 };

async function fetchAndParseVerseReferences(topic) {
    const prompt = `You are a Bible verse finder. Please find5 to 10 relevant verses about "${topic}" and respond ONLY with a JSON array in this exact format: [{"book": "abbreviated_name", "chapter": "chapter_number", "startVerse": "verse_number", "endVerse": "verse_number"}]. Use only these abbreviated names: gen, exo, lev, num, deu, jos, jdg, rut, 1sa, 2sa, 1ki, 2ki, 1ch, 2ch, ezr, neh, est, job, psa, pro, ecc, sos, isa, jer, lam, eze, dan, hos, joe, amo, oba, jon, mic, nah, hab, zep, hag, zec, mal, mat, mar, luk, joh, act, rom, 1co, 2co, gal, eph, php, col, 1th, 2th, 1ti, 2ti, tit, phm, heb, jam, 1pe, 2pe, 1jo, 2jo, 3jo, jde, rev. If no relevant verses are found, return an empty JSON array []. Do not include any text before or after the JSON array.`;

    const apiResponse = await axios.post('https://api.openai.com/v1/chat/completions', {
        model: OPENAI_MODEL,
        messages: [{ role: 'user', content: prompt }],
        // GPT-5 family: max_tokens is rejected for max_completion_tokens, and
        // temperature only accepts the default (1). Strict JSON output makes
        // reasoning unnecessary here.
        max_completion_tokens: OPENAI_MAX_TOKENS,
        reasoning_effort: 'none'
    }, {
        headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${process.env.OPENAIKEY}`
        },
        timeout: OPENAI_TIMEOUT_MS
    });

    const content = apiResponse?.data?.choices?.[0]?.message?.content;
    if (!content) throw new Error('Received an invalid response structure from the AI.');

    const parsed = JSON.parse(content.trim());
    if (!Array.isArray(parsed)) throw new Error('AI response was not an array.');
    return parsed;
}

async function resolveVerses(parsedVerses, translation) {
    const resolved = [];
    for (const ref of parsedVerses) {
        // OpenAI occasionally returns the code with surrounding whitespace
        // (" psa") — trim before lookup. Fall back to the full resolver in case
        // the model returns a name/abbreviation outside the prompted shortCodes.
        const book = ref.book?.toLowerCase().trim();
        const bookId = bookAbbreviations.get(book) ?? getBookId(book, { silent: true });
        const chapter = parseInt(ref.chapter);
        const startVerse = parseInt(ref.startVerse);
        const endVerse = parseInt(ref.endVerse) || startVerse;

        if (!bookId || isNaN(chapter) || chapter <= 0 || isNaN(startVerse) || startVerse <= 0 || isNaN(endVerse) || endVerse < startVerse) {
            logger.warn(`[Find Command] Invalid AI ref: ${JSON.stringify(ref)}`);
            continue;
        }

        try {
            const data = await bibleWrapper.getVerses(bookId, chapter, startVerse, endVerse);
            if (!data || data.length === 0) continue;

            const text = data.map((v, idx) => {
                const num = idx + startVerse;
                const t = v[translation];
                if (!t) return `[${translation} unavailable]`;
                return (idx > 0 ? ` **${num}** ` : '') + t;
            }).join('');

            if (!text) continue;

            const bookName = numbersToBook.get(bookId);
            const rangeLabel = endVerse !== startVerse
                ? `${bookName} ${chapter}:${startVerse}-${endVerse}`
                : `${bookName} ${chapter}:${startVerse}`;
            const truncatedText = text.length > VERSE_TEXT_TRUNCATE
                ? text.substring(0, VERSE_TEXT_TRUNCATE - 1) + '…'
                : text;

            resolved.push({
                bookId, bookName, chapter, startVerse, endVerse,
                rangeLabel,
                text: truncatedText
            });
        } catch (err) {
            reportError(err, { area: 'command', handler: 'find' });
            logger.error(`[Find Command] Error fetching ${book} ${chapter}:${startVerse}-${endVerse}: ${err.message}`);
        }
    }
    return resolved;
}

export function buildFindPage({ verses, pageIdx, totalPages, topic, translation, disableNav = false }) {
    const start = pageIdx * VERSES_PER_PAGE;
    const end = Math.min(start + VERSES_PER_PAGE, verses.length);
    const pageVerses = verses.slice(start, end);
    const pageInfo = totalPages > 1 ? ` · Page ${pageIdx + 1}/${totalPages}` : '';

    const container = new ContainerBuilder()
        .setAccentColor(accentColor())
        .addTextDisplayComponents(new TextDisplayBuilder().setContent(`## 🔍 Verses about "${escapeMarkdown(topic)}"${pageInfo}`))
        .addTextDisplayComponents(new TextDisplayBuilder().setContent(`*AI-suggested passages. Tap Open on any verse for full exploration.*`));

    const components = [container];

    pageVerses.forEach((v, localIdx) => {
        const globalIdx = start + localIdx;
        const section = new SectionBuilder()
            .addTextDisplayComponents(new TextDisplayBuilder().setContent(`**${v.rangeLabel}** — ${v.text}`))
            .setButtonAccessory(
                new ButtonBuilder()
                    .setCustomId(`openverse:bible:${v.bookId}:${v.chapter}:${v.startVerse}:${v.endVerse}:${globalIdx}`)
                    .setLabel('Open')
                    .setEmoji({ name: '📖' })
                    .setStyle(ButtonStyle.Secondary)
            );
        components.push(section);
    });

    components.push(new TextDisplayBuilder().setContent(
        footerLine(`Translation: ${translation.toUpperCase()}`)
    ));

    // Bottom row: pagination (if multi-page) + AI disclaimer button.
    // The disclaimer button (customId 'bias_alert') is handled globally by
    // src/components/buttons/bias.js — no local collector needed for it.
    const rowButtons = [];
    if (totalPages > 1) {
        rowButtons.push(
            new ButtonBuilder()
                .setCustomId('page_back')
                .setEmoji({ name: '◀️' })
                .setLabel('Previous')
                .setStyle(ButtonStyle.Secondary)
                .setDisabled(disableNav || pageIdx === 0),
            new ButtonBuilder()
                .setCustomId('page_next')
                .setEmoji({ name: '▶️' })
                .setLabel('Next')
                .setStyle(ButtonStyle.Secondary)
                .setDisabled(disableNav || pageIdx === totalPages - 1)
        );
    }
    rowButtons.push(
        new ButtonBuilder()
            .setCustomId('bias_alert')
            .setEmoji({ name: '💡' })
            .setLabel('Disclaimer')
            .setStyle(ButtonStyle.Secondary)
    );
    components.push(new ActionRowBuilder().addComponents(...rowButtons));

    return components;
}

export default {
    data: new SlashCommandBuilder()
        .setName('find')
        .setDescription('Find a specific verse related to a topic')
        .setIntegrationTypes(ApplicationIntegrationType.GuildInstall, ApplicationIntegrationType.UserInstall)
        .setContexts(InteractionContextType.Guild, InteractionContextType.BotDM, InteractionContextType.PrivateChannel)
        .addStringOption(option => option.setName('topic').setDescription('The topic you want to find a verse for').setRequired(true).setMinLength(3).setMaxLength(250))
        .addStringOption(option =>
            option.setName('translation')
                .setDescription('The translation you want to use')
                .addChoices(
                    { name: 'BSB', value: 'BSB' },
                    { name: 'KJV', value: 'KJV' },
                    { name: 'ASV', value: 'ASV' },
                    { name: "AKJV", value: "AKJV" },
                    { name: "CPDV", value: "CPDV" },
                    { name: "DBT", value: "DBT" },
                    { name: "DRB", value: "DRB" },
                    { name: "ERV", value: "ERV" },
                    { name: "JPS/WEY", value: "JPSWEY" },
                    { name: "NHEB", value: "NHEB" },
                    { name: "SLT", value: "SLT" },
                    { name: "WBT", value: "WBT" },
                    { name: "WEB", value: "WEB" },
                    { name: "YLT", value: "YLT" },
                )),

    async execute(interaction, database) {
        await interaction.deferReply({ flags: MessageFlags.IsComponentsV2 });

        try {
            // First-use Terms acknowledgment gate. Sits above rate-limit and
            // OpenAI: unacked users don't burn their /find quota and don't
            // hit OpenAI until they've seen and clicked the disclosure.
            const ack = await checkAckStatus(database, interaction.user.id);
            if (!ack.valid) {
                await interaction.editReply({
                    flags: MessageFlags.IsComponentsV2,
                    components: buildAckDisclosureV2(interaction.user.id, disclosureOptionsFor(ack))
                });
                return;
            }

            const rl = await database.checkRateLimit('find', interaction.user.id, RATE_LIMIT);
            if (!rl.allowed) {
                const mins = Math.ceil(rl.retryAfterSeconds / 60);
                return interaction.editReply({
                    flags: MessageFlags.IsComponentsV2,
                    components: [new TextDisplayBuilder().setContent(
                        `⏳ You've used /find ${rl.count} times recently. Please try again in ~${mins} minute${mins === 1 ? '' : 's'}.`
                    )]
                });
            }

            const topic = swearWordFilter(interaction.options.getString('topic'));
            const defaultTranslation = await database.getUserValue(interaction.user.id);
            const translation = coerceTranslation(
                interaction.options.getString('translation') || defaultTranslation?.translation
            );
            logger.info(`[Find Command] User ${interaction.user.id} topic: "${topic}" (${translation})`);

            let parsedVerses;
            try {
                parsedVerses = await fetchAndParseVerseReferences(topic);
            } catch (err) {
                reportError(err, { area: 'command', handler: 'find' });
                logger.error(`[Find Command] AI fetch error: ${err.message}`);
                return interaction.editReply({
                    flags: MessageFlags.IsComponentsV2,
                    components: [new TextDisplayBuilder().setContent(
                        `⚠️ Couldn't process AI response for "${topic}". ${err.message}`
                    )]
                });
            }

            if (!parsedVerses || parsedVerses.length === 0) {
                return interaction.editReply({
                    flags: MessageFlags.IsComponentsV2,
                    components: [new TextDisplayBuilder().setContent(
                        `ℹ️ I couldn't find any specific verses directly related to "${topic}". Try rephrasing.`
                    )]
                });
            }

            const verses = await resolveVerses(parsedVerses, translation);
            if (verses.length === 0) {
                return interaction.editReply({
                    flags: MessageFlags.IsComponentsV2,
                    components: [new TextDisplayBuilder().setContent(
                        `⚠️ The AI suggested verses for "${topic}" but I couldn't retrieve text for any of them.`
                    )]
                });
            }

            const totalPages = Math.ceil(verses.length / VERSES_PER_PAGE);
            const message = await interaction.editReply({
                flags: MessageFlags.IsComponentsV2,
                components: buildFindPage({ verses, pageIdx: 0, totalPages, topic, translation })
            });

            // A policy notice, if any, follows the result as an ephemeral
            // message. Sent only now: a follow-up before the deferred reply is
            // edited can take the place of the "thinking" placeholder.
            if (ack.notices?.length) {
                try {
                    await interaction.followUp({
                        flags: MessageFlags.IsComponentsV2 | MessageFlags.Ephemeral,
                        components: buildLegalNoticeV2(interaction.user.id, ack.notices),
                    });
                } catch (noticeErr) {
                    logger.warn(`[Find Command] Could not send legal notice: ${noticeErr.message}`);
                }
            }

            if (totalPages <= 1) return;

            attachPageCollector({
                interaction, message, totalPages,
                logLabel: '[Find Command]',
                timeoutMs: PAGINATION_TIMEOUT_MS,
                render: (pageIdx, { disableNav }) =>
                    buildFindPage({ verses, pageIdx, totalPages, topic, translation, disableNav })
            });
        } catch (error) {
            reportError(error, { area: 'command', handler: 'find' });
            logger.error(`[Find Command] Unhandled error: ${error.message}`, error.stack);
            try {
                await interaction.editReply({
                    flags: MessageFlags.IsComponentsV2,
                    components: [new TextDisplayBuilder().setContent(
                        `⚠️ An unexpected error occurred while processing your request.`
                    )]
                });
            } catch (replyError) {
                logger.error(`[Find Command] Failed to send error reply: ${replyError}`);
            }
        }
    }
};
