import {
    Events,
    PermissionFlagsBits,
    ContainerBuilder,
    TextDisplayBuilder,
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    StringSelectMenuBuilder,
    StringSelectMenuOptionBuilder,
    MessageFlags,
} from 'discord.js';
import { parseScriptureRefs } from '../utils/scriptureRefs.js';
import { getVersification, missingReferenceLine } from '../utils/versification.js';
import { bibleWrapper } from '../utils/bibleHelper.js';
import { toCommentaryVariants, toOSIS3Codes } from '../utils/bookNames.js';
import { fathersWrapper, crossRefWrapper, commentaryWrapper, pickMarqueeFather } from '../utils/studyHelper.js';
import { accentColor, footerLine } from '../utils/theme.js';
import { autopostLimitFor, passageCustomId } from '../utils/passiveDetection.js';
import logger from '../utils/logger.js';
import { reportError } from '../utils/errorReporting.js';

const MARKER_EMOJI = '📖';

// In-memory dedupe: messageIds we've already posted a reaction-expansion
// reply under. Prevents spam if multiple users click 📖 on the same message.
// Lost on restart; post-restart duplicates are acceptable edge cases.
const respondedMessages = new Map();
const RESPONDED_TTL_MS = 24 * 60 * 60 * 1000;

function markResponded(messageId) {
    respondedMessages.set(messageId, Date.now());
    if (respondedMessages.size > 2000) {
        const cutoff = Date.now() - RESPONDED_TTL_MS;
        for (const [id, ts] of respondedMessages) {
            if (ts < cutoff) respondedMessages.delete(id);
        }
    }
}

function alreadyResponded(messageId) {
    const ts = respondedMessages.get(messageId);
    if (!ts) return false;
    if (Date.now() - ts > RESPONDED_TTL_MS) {
        respondedMessages.delete(messageId);
        return false;
    }
    return true;
}

// This card owns its whole message - it is a reply to the reacted message and
// shares space with nothing - so it gets the same budget a lone autopost card
// gets, from the same helper. It used to carry its own copy of the old flat
// 450, which is why the reaction path stayed cramped after the cards were
// widened.
//
// Deliberately always the FULL budget rather than the guild's Compact setting:
// clicking the book emoji is an explicit request to see the passage, and
// Compact exists to stop UNSOLICITED posts dominating a busy channel.
const VERSE_DISPLAY_TRUNCATE = autopostLimitFor(1, 'full');

// Matches CHAPTER_VERSE_CEILING in passiveDetection: Psalm 119 has 176 verses,
// and the query is a BETWEEN, so overshooting simply returns fewer rows.
const CHAPTER_VERSE_CEILING = 200;

// Discord's StringSelectMenu hard cap. The same number the channel pager uses,
// and for the same reason: above it the menu could no longer list everything.
const MAX_REFS_IN_PICKER = 25;

function refLabel(ref) {
    if (ref.startVerse == null) return `${ref.bookName} ${ref.chapter}`;
    if (ref.endVerse !== ref.startVerse) {
        return `${ref.bookName} ${ref.chapter}:${ref.startVerse}-${ref.endVerse}`;
    }
    return `${ref.bookName} ${ref.chapter}:${ref.startVerse}`;
}

// Pull verse text + study-tool stats in parallel. Each query is ~O(ms) on
// local SQLite; Promise.all bounds wall-clock by the slowest (usually fathers
// because its query joins father_meta). Returns a shape friendly to the
// renderer — null / 0 fields mean "skip that stat line segment".
async function fetchExpansionData(ref, translation) {
    // A chapter-only reference ("Psalm 23") used to return NOTHING here, so
    // reacting to it produced a card with a heading, five buttons and no
    // scripture at all. That is a worse answer than the opening of the chapter
    // the reader actually asked about, and it is what people see when they
    // react to another Bible bot's post, whose heading is usually a chapter.
    //
    // The STATS stay off for a chapter: commentator counts and cross-references
    // are per-verse lookups, so anchoring them to verse 1 would advertise
    // numbers that describe one verse while the card names a whole chapter.
    if (ref.startVerse == null) {
        const rows = await bibleWrapper
            .getVerses(ref.bookId, ref.chapter, 1, CHAPTER_VERSE_CEILING)
            .catch(() => []);
        const verses = rows
            .map(r => ({ number: r.verse, text: r[translation] || r.BSB || r.KJV }))
            .filter(v => Boolean(v.text));
        const full = verses.map(v => `**${v.number}** ${v.text}`).join(' ');
        const truncated = full.length > VERSE_DISPLAY_TRUNCATE;
        return {
            verseText: truncated ? full.slice(0, VERSE_DISPLAY_TRUNCATE - 1) + '…' : full,
            truncated,
            commentatorCount: 0, fathersCount: 0, topFather: null, xrefCount: 0,
        };
    }

    const [verseRows, fathers, xrefs, commentatorCount] = await Promise.all([
        bibleWrapper.getVerses(ref.bookId, ref.chapter, ref.startVerse, ref.endVerse ?? ref.startVerse)
            .catch(() => []),
        fathersWrapper.getByPassage(toCommentaryVariants(ref.bookName), ref.chapter, ref.startVerse)
            .catch(() => []),
        crossRefWrapper.getForVerse(ref.bookName, ref.chapter, ref.startVerse)
            .catch(() => []),
        commentaryWrapper.countCommentatorsForVerse(toOSIS3Codes(ref.bookId), ref.chapter, ref.startVerse)
            .catch(() => 0),
    ]);

    let verseText = verseRows
        .map(r => r[translation] || r.BSB || r.KJV)
        .filter(Boolean)
        .join(' ');
    const truncated = verseText.length > VERSE_DISPLAY_TRUNCATE;
    if (truncated) {
        verseText = verseText.slice(0, VERSE_DISPLAY_TRUNCATE - 1) + '…';
    }

    return {
        verseText,
        truncated,
        commentatorCount,
        fathersCount: fathers.length,
        // Marquee-first pick over alphabetical default. If a big-name Father
        // wrote on this verse (Augustine, Chrysostom, Aquinas, etc.), surface
        // them rather than whoever happens to come first in ASCII order.
        topFather: pickMarqueeFather(fathers),
        xrefCount: xrefs.length,
    };
}

// Address of one reference, carried in a select OPTION VALUE rather than the
// customId. A customId is capped at 100 chars and could never hold 25
// references, which is why the channel pager keeps its list in Redis; a select
// gives each option its own 100-char value, so this stays stateless.
export function reactionRefValue(ref) {
    return `${ref.bookId}:${ref.chapter}:${ref.startVerse ?? 0}:${ref.endVerse ?? 0}`;
}

export async function buildExpansionReply(ref, translation, siblings = []) {
    const anchorVerse = ref.startVerse ?? 1;
    const data = await fetchExpansionData(ref, translation);

    const statSegments = [];
    if (data.commentatorCount > 0) {
        statSegments.push(`📚 ${data.commentatorCount} commentator${data.commentatorCount === 1 ? '' : 's'}`);
    }
    if (data.topFather) {
        const remainder = data.fathersCount - 1;
        statSegments.push(remainder > 0
            ? `📜 ${data.topFather} + ${remainder} other Father${remainder === 1 ? '' : 's'}`
            : `📜 ${data.topFather}`);
    }
    if (data.xrefCount > 0) {
        statSegments.push(`🔗 ${data.xrefCount} cross-reference${data.xrefCount === 1 ? '' : 's'}`);
    }

    const container = new ContainerBuilder()
        .setAccentColor(accentColor())
        .addTextDisplayComponents(new TextDisplayBuilder().setContent(
            `## 📖 ${refLabel(ref)}${data.verseText ? ` · ${translation}` : ''}`
        ));

    if (data.verseText) {
        container.addTextDisplayComponents(new TextDisplayBuilder().setContent(data.verseText));
    }

    if (statSegments.length > 0) {
        container.addTextDisplayComponents(new TextDisplayBuilder().setContent(
            `-# ${statSegments.join(' · ')}`
        ));
    }

    container.addTextDisplayComponents(new TextDisplayBuilder().setContent(
        footerLine('Tap a button for the full study view · ephemeral')
    ));

    // Five buttons: openverse chain + Fathers. 5 is the Discord action-row
    // button cap; if we ever want a sixth action (topical index, prophecy
    // link), we'll need a second action row or a StringSelectMenu instead.
    const actionRow = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
            .setCustomId(`openverse:interlinear:${ref.bookId}:${ref.chapter}:${anchorVerse}`)
            .setLabel('Interlinear').setEmoji({ name: '📖' }).setStyle(ButtonStyle.Secondary),
        new ButtonBuilder()
            .setCustomId(`openverse:commentary:${ref.bookId}:${ref.chapter}:${anchorVerse}`)
            .setLabel('Commentary').setEmoji({ name: '📚' }).setStyle(ButtonStyle.Secondary),
        new ButtonBuilder()
            .setCustomId(`openverse:xref:${ref.bookId}:${ref.chapter}:${anchorVerse}`)
            .setLabel('Cross-refs').setEmoji({ name: '🔗' }).setStyle(ButtonStyle.Secondary),
        new ButtonBuilder()
            .setCustomId(`openverse:parallel:${ref.bookId}:${ref.chapter}:${anchorVerse}`)
            .setLabel('Parallel').setEmoji({ name: '📑' }).setStyle(ButtonStyle.Secondary),
        new ButtonBuilder()
            .setCustomId(`openverse:fathers:${ref.bookId}:${ref.chapter}:${anchorVerse}`)
            .setLabel('Fathers').setEmoji({ name: '📜' }).setStyle(ButtonStyle.Secondary),
    );
    // Read full needs its OWN row: the row above is already at Discord's
    // five-button ceiling, which is why this could not simply be appended the
    // way it was on the autopost cards.
    const components = [container, actionRow];

    // A reacted message often quotes SEVERAL passages - another Bible bot
    // posting two embeds at once is the common shape. Only the first was ever
    // shown and the rest were dropped without a word, so a reader could see a
    // verse quoted above and have no idea the card had skipped it.
    //
    // Selecting opens a PRIVATE card rather than moving this one. Anyone can
    // add a reaction, so there is no owner to hand the public post to, and the
    // owner/shared arbitration the channel pager needs does not map here.
    if (siblings.length > 1) {
        components.push(new ActionRowBuilder().addComponents(
            new StringSelectMenuBuilder()
                .setCustomId('reactionref')
                .setPlaceholder(`Jump to a reference (${siblings.length} in that message)`)
                .addOptions(siblings.slice(0, MAX_REFS_IN_PICKER).map(r =>
                    new StringSelectMenuOptionBuilder()
                        .setValue(reactionRefValue(r))
                        .setLabel(refLabel(r))
                        .setDefault(reactionRefValue(r) === reactionRefValue(ref))
                ))
        ));
    }
    if (data.truncated) {
        components.push(new ActionRowBuilder().addComponents(
            new ButtonBuilder()
                .setCustomId(passageCustomId(ref))
                .setLabel('Read full')
                .setEmoji({ name: '📜' })
                .setStyle(ButtonStyle.Primary)
        ));
    }

    return { flags: MessageFlags.IsComponentsV2, components };
}

// Recursively pull `.content` strings from V2 Components (TextDisplay nodes
// nested in Containers / Sections). V2 messages leave `message.content` and
// `message.embeds` both empty — the text lives only in the component tree,
// so without this traversal any bot-posted V2 message looks like empty text
// to the parser. Duck-types both plain-object (raw REST response) and
// discord.js class-instance shapes (`.data` wrap).
function extractComponentText(components) {
    if (!components) return [];
    const items = Array.isArray(components) ? components : Array.from(components.values?.() ?? []);
    const out = [];
    for (const c of items) {
        const type = c?.type ?? c?.data?.type;
        const content = c?.content ?? c?.data?.content;
        // Type 10 = TextDisplay; Type 4 = legacy TextInput (modals only, but
        // has content too so no harm in catching it).
        if ((type === 10 || type === 4) && typeof content === 'string') out.push(content);
        const nested = c?.components ?? c?.data?.components;
        if (nested) out.push(...extractComponentText(nested));
    }
    return out;
}

// Extract searchable text from a message — content, embed text, AND V2
// component text. Needed so 📖 clicks work on BibleBot-style embed messages,
// plain user messages, and V2-formatted bot messages (including Biblicana's
// own autopost replies and welcome cards).
function extractSearchText(message) {
    const parts = [message.content || ''];
    for (const embed of message.embeds || []) {
        if (embed.title) parts.push(embed.title);
        if (embed.description) parts.push(embed.description);
        if (embed.author?.name) parts.push(embed.author.name);
        for (const field of embed.fields || []) {
            if (field.name) parts.push(field.name);
            if (field.value) parts.push(field.value);
        }
    }
    parts.push(...extractComponentText(message.components));
    return parts.join(' ');
}

// Reaction-click handler for the 📖 marker. When a user reacts with 📖 to a
// message containing a scripture reference, post a threaded reply under it
// with the openverse action row — gives one-click access to the full study
// tools without requiring the clicker to know the slash commands.
//
// Triggers on any user's 📖 reaction, not just on messages Biblicana marked.
// That means users in `silent` mode guilds cannot summon expansion via
// reaction — we respect admin intent. Other modes all allow it.
export default {
    name: Events.MessageReactionAdd,
    async execute(reaction, user, database) {
        try {
            // Fast-path rejects: cheapest checks first, no logging. Most
            // reactions across a busy guild are non-📖 or bot-authored, and
            // this handler runs on every single one.
            if (user.bot) return;
            if (reaction.emoji?.name !== MARKER_EMOJI) return;

            // Partial handling: fetch full reaction + message if needed.
            // Debug-level on failure keeps quiet in prod but available in dev.
            if (reaction.partial) {
                try { await reaction.fetch(); } catch (err) {
                    return logger.debug(`[PassiveReaction] partial reaction fetch failed: ${err.message}`);
                }
            }
            const message = reaction.message;
            if (message.partial) {
                try { await message.fetch(); } catch (err) {
                    return logger.debug(`[PassiveReaction] partial message fetch failed: ${err.message}`);
                }
            }

            if (!message.guild) return;
            if (alreadyResponded(message.id)) return;

            // Note: silent-mode guilds are NOT blocked here anymore — a user
            // clicking 📖 is explicit solicitation, which silent mode doesn't
            // preclude. Silent still blocks unsolicited passive detection in
            // src/events/messageCreate.js, which is the right scope for it.
            const me = message.guild.members.me;
            if (!me) return;
            if (!message.channel.permissionsFor(me)?.has(PermissionFlagsBits.SendMessages)) return;

            const parsed = parseScriptureRefs(extractSearchText(message));
            if (parsed.length === 0) return;

            const versification = await getVersification();
            const refs = versification.filter(parsed);

            markResponded(message.id);

            // Nothing in the message exists. Unlike autopost this was ASKED
            // for - someone pressed the reaction - so silence would read as the
            // bot being broken. One line saying why, and no study buttons: the
            // card this used to post offered commentary on "Romans 17:1".
            if (refs.length === 0) {
                const missing = parsed[0];
                logger.info(`[PassiveReaction] no such reference ${refLabel(missing)} guild=${message.guild.id} clicker=${user.id}`);
                await message.reply({
                    content: missingReferenceLine(versification, missing),
                    allowedMentions: { repliedUser: false },
                });
                return;
            }

            const ref = refs.find(r => r.startVerse != null) ?? refs[0];
            logger.info(`[PassiveReaction] posting ref=${refLabel(ref)} guild=${message.guild.id} clicker=${user.id}`);

            // Resolve the clicker's preferred translation so the verse text
            // matches what they'd get via /bible or /randomverse.
            let translation = 'BSB';
            try {
                const pref = await database.getUserValue(user.id);
                if (pref?.translation) translation = pref.translation;
            } catch { /* default */ }

            const reply = await buildExpansionReply(ref, translation, refs);
            await message.reply({
                ...reply,
                allowedMentions: { repliedUser: false },
            });
        } catch (err) {
            reportError(err, { area: 'event', handler: 'messageReactionAdd' });
            logger.error(`[PassiveReaction] Unhandled: ${err.message}`);
        }
    },
};
