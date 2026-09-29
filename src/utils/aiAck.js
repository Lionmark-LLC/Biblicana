import {
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    ContainerBuilder,
    TextDisplayBuilder,
} from 'discord.js';
import { accentColor, PRIVACY_URL, TERMS_URL } from './theme.js';
import logger from './logger.js';

// Per-user AI-chat acknowledgment gate.
//
// Discord's privileged-intents + off-platform-data story hinges on per-user
// assent, not just admin install-time assent. An admin toggling AI chat on for
// a server doesn't legally commit every user in that server to sending message
// text to OpenAI. This gate fills the gap: first time a given user triggers
// AI chat (any guild channel / scope), they see a one-time
// disclosure with an Acknowledge button. Clicking sets a timestamp on the
// user record; they never see it again — unless TERMS_MIN_ACK_DATE is bumped.

// ── Terms-version dial ────────────────────────────────────────────────────
//
// ISO 8601 cutoff. Any stored aiTermsAcknowledgedAt earlier than this is
// treated as stale — the user will see the first-use disclosure again on
// their next AI-chat interaction, and the re-ack overwrites their timestamp.
//
// WHEN TO BUMP: material changes to the Privacy Policy or Terms of Service
// — new data flows, new third-party processors, new retention policies,
// expanded data use. Cosmetic edits don't require bumping.
//
// HOW TO BUMP: set this to an ISO timestamp at or shortly before the new
// policy's effective time (UTC). Deploy the bump in the same commit that
// updates the actual policy text at blueberean.com/privacy + /terms so the
// disclosure link surfaces the updated content.
//
// Compared lex-string-to-string (ISO 8601 sorts correctly that way — no
// need to parse to Date).
//
// History:
//   2026-04-17 — v1: initial launch of the per-user AI-chat ack gate.
//   2026-08-03 — v2: /web moved from Tavily to OpenAI's built-in web search,
//     and AI chat gained the ability to trigger a web search when the local
//     library can't answer.
//
//     The Tavily removal alone would NOT justify a re-ack — dropping a
//     recipient narrows sharing versus what users already agreed to. The bump
//     is for the addition: an @mention previously produced text generation
//     only, and now may cause an outbound search. Same processor, new
//     processing activity, and the Art. 6(1)(a) consent basis leans on the
//     disclosure being accurate about what actually happens.
//   2026-09-29 — v3: Privacy Policy now discloses Sentry (bot error reports,
//     traces and profiles, sending since 2026-09-25) and Cloudflare as the
//     website host in place of Vercel. Sentry is a new processor, which is
//     material; the host swap alone would not have been. Policy went live
//     via blueberean-site@5f28424.
export const TERMS_MIN_ACK_DATE = '2026-09-29T00:00:00.000Z';

/**
 * Check whether the user has a valid ack for the current Terms version.
 *
 * Returns an object:
 *   { valid: true,  ackedAt: '<ISO>' }             — acked, current, good to go
 *   { valid: false, reason: 'never' }               — no stored ack at all
 *   { valid: false, reason: 'stale', ackedAt: '…' } — acked, but pre-cutoff
 *   { valid: false, reason: 'error' }               — DB failure; fail-closed
 *
 * The reason field lets the caller tailor the disclosure copy — returning
 * users who are being re-prompted due to a policy bump get a "we've updated
 * our terms since you last agreed" message rather than the first-time
 * "before we chat" greeting.
 */
export async function checkAckStatus(database, userId) {
    try {
        const user = await database.getUserValue(userId);
        const ackedAt = user?.aiTermsAcknowledgedAt;
        if (!ackedAt) return { valid: false, reason: 'never' };
        // Stale ack (predates current terms version): treat as unacked.
        if (ackedAt < TERMS_MIN_ACK_DATE) {
            logger.debug(`[AiAck] Stale ack for user=${userId}: ${ackedAt} < ${TERMS_MIN_ACK_DATE}, re-prompting`);
            return { valid: false, reason: 'stale', ackedAt };
        }
        return { valid: true, ackedAt };
    } catch (err) {
        logger.debug(`[AiAck] Read failed for user=${userId}: ${err.message}`);
        return { valid: false, reason: 'error' };
    }
}

/**
 * Persist the user's acknowledgment. Creates the user record if it doesn't
 * yet exist, with the schema's translation default populated so the record
 * is well-formed (not just {id, aiTermsAcknowledgedAt}).
 */
export async function markAiTermsAcked(database, userId) {
    try {
        const existing = await database.getUserValue(userId);
        const merged = {
            id: userId,
            translation: 'BSB',
            ...(existing ?? {}),
            aiTermsAcknowledgedAt: new Date().toISOString(),
        };
        return await database.setUserValue(userId, merged);
    } catch (err) {
        logger.error(`[AiAck] Save failed for user=${userId}: ${err.message}`);
        return false;
    }
}

// Button customId format: aichat_ack:<userId>. The userId is encoded so the
// handler can verify the clicker matches the intended recipient without an
// extra DB round-trip.
function ackButtonRow(userId) {
    return new ActionRowBuilder().addComponents(
        new ButtonBuilder()
            .setCustomId(`aichat_ack:${userId}`)
            .setLabel('Acknowledge & continue')
            .setStyle(ButtonStyle.Primary)
    );
}

// Feature-specific mechanics bullets. The same ack covers AI chat, /find, and
// /web, but the data-flow summary differs: AI chat retains a rolling 10-turn
// conversation history and honors /forget; /find and /web are one-shot queries
// with no retained memory. Split into two variants so users invoking /find or
// /web don't see AI-chat-specific controls (/forget, memory TTL) that don't
// apply to the feature they just ran.
const MECHANICS_BULLETS_AICHAT = [
    '• Your message is sent to OpenAI to generate each reply.',
    '• The last ~10 turns are remembered for 1 hour, then auto-deleted.',
    '• `/forget` erases your memory immediately, anytime.',
    `• Details: [Privacy Policy](${PRIVACY_URL}) · [Terms of Service](${TERMS_URL})`,
];

const MECHANICS_BULLETS_SLASH = [
    // Tavily was removed when /web moved to OpenAI's built-in web_search tool.
    // The query now reaches only OpenAI, and its searches are confined to a
    // curated allowlist of Christian reference sites (see ALLOWED_DOMAINS in
    // web.js). This is strictly FEWER third parties than users previously
    // agreed to, so TERMS_MIN_ACK_DATE is deliberately NOT bumped — forcing a
    // re-acknowledgment would be noise for a change that only narrows data
    // sharing. Bump it only if a change ever widens what is shared.
    '• Your query is sent to OpenAI to generate a response (for `/web`, OpenAI also searches a fixed list of Christian reference sites).',
    '• No conversation memory is kept — each `/find` or `/web` invocation is one-shot.',
    '• This acknowledgment also covers AI chat (mention or reply).',
    `• Details: [Privacy Policy](${PRIVACY_URL}) · [Terms of Service](${TERMS_URL})`,
];

// Render an ISO timestamp as a simple YYYY-MM-DD for the "you last agreed on
// <date>" line. Discord does have <t:...:D> timestamp tags but those are
// locale-rendered per-viewer and feel heavy for what's just a reassurance
// breadcrumb. Plain YYYY-MM-DD is unambiguous and tight.
function shortDate(isoString) {
    if (!isoString || typeof isoString !== 'string') return null;
    return isoString.slice(0, 10);
}

// Text-only renderer. The two payload builders below wrap this differently
// depending on whether we're rendering into a plain-text message (AI chat)
// or a Components V2 container (slash-command editReply).
function renderDisclosureText({ kind = 'first_time', lastAckedAt = null, source = 'aichat' } = {}) {
    const bullets = source === 'slash' ? MECHANICS_BULLETS_SLASH : MECHANICS_BULLETS_AICHAT;
    if (kind === 'updated') {
        const lastDate = shortDate(lastAckedAt);
        const leadLine = lastDate
            ? `**We've updated our Privacy Policy and Terms** since your last agreement on ${lastDate}.`
            : `**We've updated our Privacy Policy and Terms** since your last agreement.`;
        return [
            leadLine,
            'Quick refresher on how this feature works:',
            ...bullets,
            '',
            '-# Click below to continue under the updated terms.',
        ].join('\n');
    }
    // 'first_time' (default)
    return [
        '**Before we continue — quick heads-up on how this works:**',
        ...bullets,
        '',
        '-# This shows once per user. Click below to continue.',
    ].join('\n');
}

/**
 * Build a PLAIN-TEXT disclosure payload for AI chat message replies.
 * Returns { content, components } — directly passable to message.reply().
 *
 * Use this when replying to a user message (AI chat handler), which is not
 * wrapped in a V2 container and is meant to feel like a chat message.
 *
 * @param {string} userId - encoded into the ack button's customId for clicker
 *   verification.
 * @param {object} [options]
 * @param {'first_time'|'updated'} [options.kind='first_time']
 * @param {string} [options.lastAckedAt] - ISO timestamp of prior ack
 */
export function buildAckDisclosurePayload(userId, options = {}) {
    return {
        content: renderDisclosureText({ ...options, source: 'aichat' }),
        components: [ackButtonRow(userId)],
    };
}

/**
 * Build a Components V2 disclosure for slash-command contexts (/find, /web).
 * Returns an array of V2 components — passable to interaction.editReply().
 *
 * Used when the interaction was deferred with MessageFlags.IsComponentsV2.
 * V2-flagged messages don't accept `content:`, so we wrap the same disclosure
 * text in a ContainerBuilder for visual consistency with the rest of the
 * command's output.
 */
export function buildAckDisclosureV2(userId, options = {}) {
    const container = new ContainerBuilder()
        .setAccentColor(accentColor())
        .addTextDisplayComponents(new TextDisplayBuilder().setContent(renderDisclosureText({ ...options, source: 'slash' })));
    return [container, ackButtonRow(userId)];
}

/**
 * Build the post-ack "acknowledged" state for a V2 slash-command message.
 * Tells the user to re-run their command. Use this from the button handler
 * when it detects the disclosure was rendered as a V2 container (slash cmd
 * origin) rather than a plain message (AI chat origin).
 */
export function buildAckConfirmedV2() {
    const container = new ContainerBuilder()
        .setAccentColor(accentColor())
        .addTextDisplayComponents(new TextDisplayBuilder().setContent(
            [
                '## ✓ Acknowledged',
                'Thanks — this notice won\'t appear again. Please re-run your command to get your results.',
                '',
                '-# Use `/forget` to erase AI-chat memory anytime, or `/support` for questions.',
            ].join('\n')
        ));
    return [container];
}
