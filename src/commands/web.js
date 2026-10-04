import {
    SlashCommandBuilder,
    ContainerBuilder,
    TextDisplayBuilder,
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    MessageFlags,
    ApplicationIntegrationType,
    InteractionContextType
} from 'discord.js';
import axios from 'axios';
import logger from '../utils/logger.js';
import { reportError } from '../utils/errorReporting.js';
import splitString from '../utils/splitString.js';
import { accentColor, footerLine } from '../utils/theme.js';
import { attachPageCollector, buildPageNavRow } from '../utils/paginationHelper.js';
import { checkAckStatus, buildAckDisclosureV2, buildLegalNoticeV2, disclosureOptionsFor } from '../utils/aiAck.js';
import { searchAllowedWeb, buildWebSourceMap } from '../utils/webSearch.js';
import { stripModelMarkup } from '../utils/filter.js';
import 'dotenv/config';

const INTENT_MODEL = 'gpt-5.6-luna';
// Was 10, which was safe when max_tokens counted only visible output. On the
// GPT-5 family the budget also covers hidden reasoning tokens, so a tiny value
// risks an empty completion. reasoning_effort:'none' should keep reasoning at
// zero, but the headroom costs nothing on a one-word answer.
const INTENT_MAX_TOKENS = 64;
const INTENT_TIMEOUT_MS = 10_000;
const SUMMARY_MAX_TOKENS = 4000;   // raised: this budget now shares with reasoning tokens
const SEARCH_TIMEOUT_MS = 60_000;   // search + generation in one call; slower than a bare completion
const MAX_CHARS_PER_PAGE = 3500;
const MAX_BUTTON_LABEL = 80;
const RATE_LIMIT = { limit: 10, windowSeconds: 3600 };

// ALLOWED_DOMAINS now lives in utils/webSearch.js — the AI chat's search_web
// tool searches the same list, and a trust boundary defined in two places is a
// trust boundary that drifts.

// System-level instructions for the search-and-answer call. Previously this
// summarised a pre-fetched result set; the model now does its own retrieval,
// so the "base your answer EXCLUSIVELY on the provided Sources" framing becomes
// "only on what you retrieved".
const WEB_ANSWER_INSTRUCTIONS = `You are a thorough Christian apologetics research assistant providing factual, evidence-based info from a Protestant perspective.

Guidelines:
- Salvation is through Christ alone (John 14:6). Scripture is the ultimate authority. Avoid non-biblical traditions. Redirect non-Protestant views respectfully to biblical sources. Emphasize unity in Christ.
- Target 500–800 words written primarily as flowing prose paragraphs. Do NOT default to bullet points. Target roughly 75% prose, 25% bullets at most.
- Bullets are only appropriate for: (a) lists of three or more genuinely parallel enumerable items (e.g., three pieces of archaeological evidence), or (b) contrasting distinct viewpoints side-by-side. Any time you'd write a bullet point for a single fact or a narrative step, write a prose sentence instead.
- Format: Start with a single '## Title Derived from User Query'. Use '### Subsection Heading' only when the answer has 2+ genuinely distinct major parts. Otherwise write as continuous paragraphs under the title.

Sourcing requirements:
- You MUST search the web before answering. Base the answer exclusively on what you retrieve. Do not add outside knowledge. If the retrieved material doesn't cover an aspect, say so explicitly.
- Cite every claim inline using ONLY the bare domain in parentheses — e.g. (gotquestions.org), (ccel.org). Never invent a domain, and never cite one you did not actually retrieve from. These markers are turned into clickable links, so an invented one becomes a broken link.
- Some sources represent Catholic or Orthodox teaching. When drawing on those, attribute the view to that tradition rather than presenting it as the Protestant position.`;

// waitForRateLimit / the client-side rate-limit bookkeeping went away with
// Tavily. OpenAI's own rate limiting governs the single search call now, and
// the per-user quota is still enforced by database.checkRateLimit below.

function truncateLabel(text, max = MAX_BUTTON_LABEL) {
    if (!text) return 'Source';
    return text.length > max ? text.substring(0, max - 1) + '…' : text;
}

function buildWebAnswerPage({ query, chunks, pageIdx, totalPages, usedSources, disableNav = false }) {
    const pageInfo = totalPages > 1 ? ` · Page ${pageIdx + 1}/${totalPages}` : '';
    const pageSuffix = totalPages > 1 ? ` · Page ${pageIdx + 1}/${totalPages}` : '';

    const container = new ContainerBuilder()
        .setAccentColor(accentColor())
        .addTextDisplayComponents(new TextDisplayBuilder().setContent(`## 🌐 ${truncateLabel(query, 180)}${pageInfo}`))
        .addTextDisplayComponents(new TextDisplayBuilder().setContent(chunks[pageIdx]))
        .addTextDisplayComponents(new TextDisplayBuilder().setContent(
            footerLine(`AI-assisted answer from web sources${pageSuffix}`)
        ));

    const components = [container];

    // Sources become link buttons. Discord allows 5 components per row, and the
    // citation list is sliced to match.
    if (usedSources.length > 0) {
        const linkRow = new ActionRowBuilder().addComponents(
            ...usedSources.slice(0, 5).map(({ name, info }) => {
                const label = truncateLabel(info.title || name, 35);
                return new ButtonBuilder()
                    .setLabel(label)
                    .setStyle(ButtonStyle.Link)
                    .setURL(info.url);
            })
        );
        components.push(linkRow);
    }

    if (totalPages > 1) {
        components.push(buildPageNavRow({ pageIdx, totalPages, disabled: disableNav }));
    }

    return components;
}

export default {
    data: new SlashCommandBuilder()
        .setName('web')
        .setDescription('Search trusted Christian sources and get AI-powered answers with citations')
        .setIntegrationTypes(ApplicationIntegrationType.GuildInstall, ApplicationIntegrationType.UserInstall)
        .setContexts(InteractionContextType.Guild, InteractionContextType.BotDM, InteractionContextType.PrivateChannel)
        .addStringOption(option =>
            option.setName('query')
                .setDescription('What would you like to know?')
                .setRequired(true)
                .setMinLength(3)
                .setMaxLength(250)),

    async execute(interaction, database) {
        await interaction.deferReply({ flags: MessageFlags.IsComponentsV2 });

        try {
            // First-use Terms acknowledgment gate. Sits above rate-limit,
            // the intent check, and the web search — unacked users don't
            // burn quota or hit external APIs until they've clicked through.
            const ack = await checkAckStatus(database, interaction.user.id);
            if (!ack.valid) {
                await interaction.editReply({
                    flags: MessageFlags.IsComponentsV2,
                    components: buildAckDisclosureV2(interaction.user.id, disclosureOptionsFor(ack))
                });
                return;
            }

            const rl = await database.checkRateLimit('web', interaction.user.id, RATE_LIMIT);
            if (!rl.allowed) {
                const mins = Math.ceil(rl.retryAfterSeconds / 60);
                return interaction.editReply({
                    flags: MessageFlags.IsComponentsV2,
                    components: [new TextDisplayBuilder().setContent(
                        `⏳ You've used /web ${rl.count} times recently. Please try again in ~${mins} minute${mins === 1 ? '' : 's'}.`
                    )]
                });
            }

            const query = interaction.options.getString('query');
            logger.info(`[Web Command] Processing query: "${query}"`);

            // Intent check — does this question align with Christian teaching context?
            // Starts in an "unknown" state so an OpenAI outage or timeout falls
            // through to the explicit "couldn't verify" branch below rather than
            // bypassing the doctrinal filter.
            let shouldAnswer = false;
            let intentVerified = false;
            try {
                const intent_check = await axios.post('https://api.openai.com/v1/chat/completions', {
                    model: INTENT_MODEL,
                    messages: [
                        {
                            role: 'system',
                            content: `You are a Christian content filter focused on facilitating respectful dialogue. Your task is to determine if a question:
1. Seeks genuine understanding about: Christianity, biblical topics, moral/ethical issues, scientific topics from a Christian perspective, historical/archaeological discussions related to faith, challenging questions about faith/science, honest inquiries about apparent contradictions, different Christian interpretations of Genesis/creation.
2. Return "true" if: the question seeks genuine understanding, shows respect for faith while questioning, explores scientific/historical evidence, discusses different Christian viewpoints, asks about reconciling faith/science.
3. Return "false" ONLY if: promotes hate/intentionally mocks faith, seeks validation for clearly unethical activities, shows clear hostile intent towards Christianity, uses deliberately inflammatory language, tries to promote one sect or denomination as the only true one.
Err on the side of "true" for sincere questions, even if challenging. Respond ONLY with the single word "true" or the single word "false". Do not add any other text or punctuation.`
                        },
                        { role: 'user', content: query }
                    ],
                    max_completion_tokens: INTENT_MAX_TOKENS,
                    // Critical for this call: max_completion_tokens includes
                    // hidden reasoning tokens, so with reasoning enabled a
                    // small budget is consumed entirely by reasoning and the
                    // model returns EMPTY content — which would have read as
                    // the content filter silently refusing every query.
                    reasoning_effort: 'none',
                    // temperature omitted — this model family only accepts the
                    // default (1). The prompt is tightly constrained to a single
                    // word, so determinism comes from the prompt, not the knob.
                }, {
                    headers: {
                        'Authorization': `Bearer ${process.env.OPENAIKEY}`,
                        'Content-Type': 'application/json'
                    },
                    timeout: INTENT_TIMEOUT_MS
                });
                const intentResponse = intent_check.data.choices[0]?.message?.content?.trim().toLowerCase();
                shouldAnswer = intentResponse === 'true';
                intentVerified = true;
            } catch (intentError) {
                reportError(intentError, { area: 'command', handler: 'web' });
                logger.error(`[Web Command] Intent check failed: ${intentError.message}`);
            }

            if (!intentVerified) {
                return interaction.editReply({
                    flags: MessageFlags.IsComponentsV2,
                    components: [new TextDisplayBuilder().setContent(
                        `⚠️ I couldn't verify your question against the content filter right now. Please try again in a moment.`
                    )]
                });
            }

            if (!shouldAnswer) {
                return interaction.editReply({
                    flags: MessageFlags.IsComponentsV2,
                    components: [new TextDisplayBuilder().setContent(
                        `I can only answer questions that align with Christian teachings and biblical wisdom. Please rephrase your question or ask something else.`
                    )]
                });
            }

            // Search + answer in ONE call. Previously this hit Tavily and then
            // made a second OpenAI call to summarise the results; the built-in
            // web_search tool does the retrieval itself, and — unlike Tavily —
            // enforces the domain allowlist server-side, so nothing outside
            // ALLOWED_DOMAINS can reach the answer.
            //
            // Responses API, not Chat Completions: filters.allowed_domains is
            // only supported there.
            let answerText = '';
            let annotations = [];
            let retrievedSources = [];
            try {
                const result = await searchAllowedWeb({
                    query: `Query: "${query}"\n\nSearch the allowed sources and write a thorough, evidence-focused answer (500–800 words, primarily prose; bullets only for genuine 3+ item enumerations).\n\nIncorporate where the sources support it: historical evidence and dates, archaeological findings, biblical references, specific names and places, verifiable facts, and multiple viewpoints when the sources present them — but weave these into prose rather than bulleting them.\n\nCite every claim with a bare domain in parentheses.`,
                    instructions: WEB_ANSWER_INSTRUCTIONS,
                    maxOutputTokens: SUMMARY_MAX_TOKENS,
                    timeoutMs: SEARCH_TIMEOUT_MS,
                });

                // Same model as AI chat, so the same entity-markup leak applies
                // here. Strip before the citation regex runs, or a token like
                // entity["book","X","y"] can interfere with (domain.com) matching.
                answerText = stripModelMarkup(result.text);
                if (answerText !== result.text) {
                    logger.warn(`[Web Command] Stripped model-internal markup from answer (${result.text.length} → ${answerText.length} chars)`);
                }
                annotations = result.annotations;
                retrievedSources = result.retrieved;

                logger.info(`[Web Command] web_search completed — ${result.searchCallCount} search call(s), ${annotations.length} inline citation(s), ${retrievedSources.length} retrieved source(s), ${answerText.length} chars`);

                if (!answerText) throw new Error('The model returned an empty answer.');
            } catch (searchError) {
                const detail = searchError.response?.data?.error?.message || searchError.message;
                logger.error(`[Web Command] web_search failed: ${detail}`);
                throw new Error('Failed to search and generate an answer.');
            }

            // Hostname-keyed, matching the (domain.com) citation markers the
            // instructions ask for. Prefers inline citations, falls back to
            // everything retrieved — see buildWebSourceMap.
            const sourceMap = buildWebSourceMap({ annotations, retrieved: retrievedSources });

            // NOTE: deliberately NOT bailing out when sourceMap is empty. The
            // old Tavily code bailed on "no search results", which is a real
            // dead end; "no parseable citations" is not the same condition and
            // must never discard a good answer. Worst case the answer renders
            // without link buttons.
            if (sourceMap.size === 0) {
                logger.warn(`[Web Command] Answer produced with no attributable sources for query: "${query}"`);
            }

            // Process citation markdown — replace (sourcename) with [(sourcename)](url).
            const usedSourceNames = new Set();
            let finalAnswer = answerText.replace(/\(([\w.-]+(?:-\d+)?)\)/g, (match, sourceName) => {
                if (sourceMap.has(sourceName)) {
                    usedSourceNames.add(sourceName);
                    const sourceInfo = sourceMap.get(sourceName);
                    return `[(${sourceName})](${sourceInfo.url})`;
                }
                return match;
            });

            const usedSources = Array.from(usedSourceNames).sort().map(name => ({
                name,
                info: sourceMap.get(name)
            }));

            // Paginate if the answer exceeds one page. splitString breaks at
            // word/paragraph boundaries so markdown citations stay intact.
            const chunks = splitString(finalAnswer, MAX_CHARS_PER_PAGE);
            const totalPages = chunks.length;

            const message = await interaction.editReply({
                flags: MessageFlags.IsComponentsV2,
                components: buildWebAnswerPage({ query, chunks, pageIdx: 0, totalPages, usedSources })
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
                    logger.warn(`[Web Command] Could not send legal notice: ${noticeErr.message}`);
                }
            }

            if (totalPages <= 1) return;

            attachPageCollector({
                interaction, message, totalPages,
                logLabel: '[Web Command]',
                render: (pageIdx, { disableNav }) =>
                    buildWebAnswerPage({ query, chunks, pageIdx, totalPages, usedSources, disableNav })
            });
        } catch (error) {
            reportError(error, { area: 'command', handler: 'web' });
            logger.error(`[Web Command] Unhandled error: ${error.message}`, error.stack);
            try {
                await interaction.editReply({
                    flags: MessageFlags.IsComponentsV2,
                    components: [new TextDisplayBuilder().setContent(
                        `❌ Sorry, an unexpected error occurred while processing your web search: ${error.message}`
                    )]
                });
            } catch (replyError) {
                if (replyError.code !== 10062 && replyError.code !== 40060) {
                    logger.error(`[Web Command] Failed to send error reply: ${replyError}`);
                }
            }
        }
    }
};
