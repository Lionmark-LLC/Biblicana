import {
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    ContainerBuilder,
    TextDisplayBuilder,
} from 'discord.js';
import { accentColor, PRIVACY_URL, TERMS_URL } from './theme.js';
import logger from './logger.js';
import { getLegalVersions, decideAck, DOCUMENT_TITLES } from './legalVersions.js';

// Per-user acknowledgment gate for AI chat, /find and /web.
//
// Discord's privileged-intents + off-platform-data story hinges on per-user
// assent, not just admin install-time assent. An admin toggling AI chat on for
// a server doesn't legally commit every user in that server to sending message
// text to OpenAI. This gate fills the gap: the first time a user triggers one
// of these features they see a disclosure with an Acknowledge button, and the
// click stores a timestamp on their user record.
//
// What counts as current comes from Neon since 2026-10-03, not a constant:
// published versions of the Terms and Privacy Policy, each with a change
// level (src/utils/legalVersions.js decides; blueberean-site's legal/ holds
// the text; `pnpm run legal:publish` copies a version into Neon after the site
// serves it). Editorial changes never re-prompt; a notice shows its summary
// once, with Got it, alongside the normal reply; a material change re-prompts,
// and the disclosure says what changed.
//
// History of the old TERMS_MIN_ACK_DATE dial, kept for the record:
//   2026-04-17 — initial launch of the per-user AI-chat ack gate.
//   2026-08-03 — /web moved from Tavily to OpenAI's built-in web search, and
//     AI chat gained web search (a new processing activity, so a re-ack).
//   2026-09-29 — Privacy Policy disclosed Sentry (a new processor) and
//     Cloudflare as website host. This is Privacy v1's effective time, and
//     FALLBACK_REQUIRED_AT in legalVersions.js, so nothing changed at switchover.

/**
 * Check the user's acknowledgment against the published versions.
 *
 *   { valid: true,  ackedAt, requiredAt, notices }        — good to go; show
 *                                                           any notices after
 *                                                           the normal reply
 *   { valid: false, reason: 'never',  requiredAt, changes: [] }
 *   { valid: false, reason: 'stale',  ackedAt, requiredAt, changes }
 *   { valid: false, reason: 'error',  requiredAt: null, changes: [] }
 *                                                         — DB failure; fail closed
 *
 * `changes` (stale) is what the disclosure lists under "What changed".
 */
export async function checkAckStatus(database, userId, { now = Date.now() } = {}) {
    let ackedAt;
    try {
        const user = await database.getUserValue(userId);
        ackedAt = user?.aiTermsAcknowledgedAt || null;
    } catch (err) {
        logger.debug(`[AiAck] Read failed for user=${userId}: ${err.message}`);
        return { valid: false, reason: 'error', requiredAt: null, changes: [] };
    }
    const { versions } = await getLegalVersions(database, { now });
    const decision = decideAck({ ackedAt, versions, now });
    if (decision.reason === 'stale') {
        logger.debug(`[AiAck] Stale ack for user=${userId}: ${ackedAt} < ${decision.requiredAt}, re-prompting`);
    }
    return decision;
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

// Button customId format: aichat_ack:<userId>:<requiredMs>. The userId lets
// the handler check the clicker without a DB round-trip. requiredMs is the
// effective time (epoch ms) of the newest material version the disclosure was
// shown for: a disclosure left on screen across a new material version must
// not satisfy it, so the handler refreshes instead of saving
// (parseAckCustomId, isAckButtonCurrent).
function ackButtonRow(userId, requiredAt) {
    const requiredMs = requiredAt ? Date.parse(requiredAt) : '';
    return new ActionRowBuilder().addComponents(
        new ButtonBuilder()
            .setCustomId(`aichat_ack:${userId}:${requiredMs}`)
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
    // agreed to, so it did not force a re-acknowledgment, which would be noise
    // for a change that only narrows data sharing. The same reasoning picks a
    // change level today: only a change that widens what is shared is material.
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
// "What changed" lines for an updated-terms disclosure, newest first, added
// only while they fit `budget` characters (a plain AI-chat message is capped
// at 2,000; a V2 text display at 4,000).
function whatChangedLines(changes, budget) {
    const lines = [];
    let used = 0;
    for (const c of changes ?? []) {
        const line = `• **${DOCUMENT_TITLES[c.document] ?? c.document}** (version ${c.version}, ${shortDate(c.effectiveAt)}): ${c.summary}`;
        if (used + line.length + 1 > budget) break;
        lines.push(line);
        used += line.length + 1;
    }
    return lines.length ? ['**What changed:**', ...lines] : [];
}

const PLAIN_LIMIT = 2000;
const V2_LIMIT = 4000;

function renderDisclosureText({ kind = 'first_time', lastAckedAt = null, source = 'aichat', changes = [] } = {}) {
    const bullets = source === 'slash' ? MECHANICS_BULLETS_SLASH : MECHANICS_BULLETS_AICHAT;
    if (kind === 'updated') {
        const lastDate = shortDate(lastAckedAt);
        const leadLine = lastDate
            ? `**We've updated our Privacy Policy and Terms** since your last agreement on ${lastDate}.`
            : `**We've updated our Privacy Policy and Terms** since your last agreement.`;
        const head = [leadLine];
        const tail = ['Quick refresher on how this feature works:', ...bullets, '', '-# Click below to continue under the updated terms.'];
        const fixed = [...head, ...tail].join('\n').length;
        const limit = source === 'slash' ? V2_LIMIT : PLAIN_LIMIT;
        const changed = whatChangedLines(changes, limit - fixed - 40);
        return [...head, ...(changed.length ? [...changed, ''] : []), ...tail].join('\n');
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
 * @param {Array} [options.changes] - checkAckStatus's `changes`, listed as "What changed"
 * @param {string} [options.requiredAt] - checkAckStatus's `requiredAt`, encoded in the button
 */
export function buildAckDisclosurePayload(userId, options = {}) {
    return {
        content: renderDisclosureText({ ...options, source: 'aichat' }),
        components: [ackButtonRow(userId, options.requiredAt)],
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
    return [container, ackButtonRow(userId, options.requiredAt)];
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

// The disclosure options for a failed checkAckStatus, shared by the three
// gated features so they cannot drift.
export function disclosureOptionsFor(ack) {
    return {
        kind: ack.reason === 'stale' ? 'updated' : 'first_time',
        lastAckedAt: ack.ackedAt ?? null,
        changes: ack.changes ?? [],
        requiredAt: ack.requiredAt ?? null,
    };
}

/** Split `aichat_ack:<userId>:<requiredMs>`; a missing requirement (buttons from before 2026-10-03) reads as null. */
export function parseAckCustomId(customId) {
    const [, userId, requiredMs] = String(customId).split(':');
    const n = Number(requiredMs);
    return { userId: userId || null, requiredMs: requiredMs && Number.isFinite(n) ? n : null };
}

/**
 * Whether an Acknowledge click may be saved: the disclosure must have been
 * shown for the current requirement. Buttons from before 2026-10-03 carry
 * none and are treated as shown for the 2026-09-29 floor.
 */
export function isAckButtonCurrent(requiredMs, currentRequiredAt, floorAt) {
    const shownFor = requiredMs ?? Date.parse(floorAt);
    return shownFor >= Date.parse(currentRequiredAt);
}

// ── Notices (non-blocking) ──────────────────────────────────────────────
//
// A notice rides along with the normal reply and never blocks it. "Got it"
// (customId legal_notice_ok:<userId>) records a new acknowledgment timestamp,
// which is the click the Privacy Policy describes; the handler refuses while a
// material version is in effect and unacknowledged.

function noticeLines(notices) {
    return (notices ?? []).map(n => {
        const title = DOCUMENT_TITLES[n.document] ?? n.document;
        return n.upcoming
            ? `• **${title}** changes on ${shortDate(n.effectiveAt)}: ${n.summary}`
            : `• **${title}** was updated (version ${n.version}): ${n.summary}`;
    });
}

function noticeText(notices) {
    const upcoming = (notices ?? []).some(n => n.upcoming);
    return [
        upcoming ? '**Heads-up: our terms are changing.**' : '**We updated our terms.**',
        ...noticeLines(notices),
        `-# [Privacy Policy](${PRIVACY_URL}) · [Terms of Service](${TERMS_URL})`,
    ].join('\n');
}

function noticeButtonRow(userId) {
    return new ActionRowBuilder().addComponents(
        new ButtonBuilder()
            .setCustomId(`legal_notice_ok:${userId}`)
            .setLabel('Got it')
            .setStyle(ButtonStyle.Secondary)
    );
}

/** Plain-text notice for AI chat, sent as its own reply after the answer. */
export function buildLegalNoticePayload(userId, notices) {
    return { content: noticeText(notices), components: [noticeButtonRow(userId)] };
}

/** Components V2 notice for /find and /web, sent as an ephemeral follow-up after the result. */
export function buildLegalNoticeV2(userId, notices) {
    const container = new ContainerBuilder()
        .setAccentColor(accentColor())
        .addTextDisplayComponents(new TextDisplayBuilder().setContent(noticeText(notices)));
    return [container, noticeButtonRow(userId)];
}
