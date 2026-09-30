import {
    ContextMenuCommandBuilder,
    ApplicationCommandType,
    ApplicationIntegrationType,
    InteractionContextType,
    ContainerBuilder,
    TextDisplayBuilder,
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    MessageFlags,
} from 'discord.js';
import { parseScriptureRefs } from '../utils/scriptureRefs.js';
import { getVersification } from '../utils/versification.js';
import { toOSIS3Codes } from '../utils/bookNames.js';
import { commentaryWrapper, COMMENTATORS } from '../utils/studyHelper.js';
import { accentColor, footerLine } from '../utils/theme.js';
import logger from '../utils/logger.js';
import { reportError } from '../utils/errorReporting.js';

const PREVIEW_LIMIT = 3500;
const DEFAULT_COMMENTATOR = 'adam-clarke';

// Message context-menu: right-click any message → Apps → "Show commentary".
// Pulls the first verse-level scripture reference, fetches Adam Clarke's
// commentary, renders a compact one-shot preview with a button that deep-
// links to the full /commentary flow (where the user can switch commentator).
export default {
    data: new ContextMenuCommandBuilder()
        .setName('Show commentary')
        .setType(ApplicationCommandType.Message)
        .setIntegrationTypes(ApplicationIntegrationType.GuildInstall, ApplicationIntegrationType.UserInstall)
        .setContexts(InteractionContextType.Guild, InteractionContextType.BotDM, InteractionContextType.PrivateChannel),

    async execute(interaction) {
        const target = interaction.targetMessage;
        const searchText = [
            target.content || '',
            ...(target.embeds || []).flatMap(e => [e.title, e.description, ...(e.fields || []).flatMap(f => [f.name, f.value])].filter(Boolean)),
        ].join(' ');

        const refs = parseScriptureRefs(searchText);
        const versification = await getVersification();
        const validRefs = versification.filter(refs);
        const verseRef = validRefs.find(r => r.startVerse != null);
        if (!verseRef) {
            return interaction.reply({
                content: '🔍 Need a valid verse-level reference (like "Rom. 8:28") to look up commentary. That message has none I could parse.',
                flags: MessageFlags.Ephemeral,
            });
        }

        await interaction.deferReply({ flags: MessageFlags.Ephemeral | MessageFlags.IsComponentsV2 });

        try {
            const bookCodes = toOSIS3Codes(verseRef.bookId);
            const row = await commentaryWrapper.getCommentaryForVerse(
                DEFAULT_COMMENTATOR, bookCodes, verseRef.chapter, verseRef.startVerse
            );

            if (!row?.text) {
                return interaction.editReply({
                    flags: MessageFlags.IsComponentsV2 | MessageFlags.Ephemeral,
                    components: [new ContainerBuilder()
                        .setAccentColor(accentColor())
                        .addTextDisplayComponents(new TextDisplayBuilder().setContent(
                            `## ✍️ No commentary found for ${verseRef.bookName} ${verseRef.chapter}:${verseRef.startVerse}`
                        ))
                        .addTextDisplayComponents(new TextDisplayBuilder().setContent(
                            `Adam Clarke has nothing on this verse. Try \`/commentary\` to check other commentators (Gill, Henry, JFB, Keil, Tyndale).`
                        ))],
                });
            }

            const commentator = COMMENTATORS.find(c => c.id === DEFAULT_COMMENTATOR);
            const refLabel = `${verseRef.bookName} ${verseRef.chapter}:${verseRef.startVerse}`;
            const preview = row.text.length > PREVIEW_LIMIT
                ? row.text.slice(0, PREVIEW_LIMIT - 1) + '…'
                : row.text;
            const truncated = row.text.length > PREVIEW_LIMIT;

            const container = new ContainerBuilder()
                .setAccentColor(accentColor())
                .addTextDisplayComponents(new TextDisplayBuilder().setContent(
                    `## 📚 ${commentator.label} on ${refLabel}`
                ))
                .addTextDisplayComponents(new TextDisplayBuilder().setContent(preview))
                .addTextDisplayComponents(new TextDisplayBuilder().setContent(
                    footerLine(truncated
                        ? 'Preview truncated · /commentary for full text + other commentators'
                        : commentator.label)
                ));

            // Button to escalate into the full commentary flow for more pages / switch commentators.
            const actionRow = new ActionRowBuilder().addComponents(
                new ButtonBuilder()
                    .setCustomId(`openverse:commentary:${verseRef.bookId}:${verseRef.chapter}:${verseRef.startVerse}`)
                    .setLabel('Open full commentary')
                    .setEmoji({ name: '📚' })
                    .setStyle(ButtonStyle.Primary)
            );

            await interaction.editReply({
                flags: MessageFlags.IsComponentsV2 | MessageFlags.Ephemeral,
                components: [container, actionRow],
            });
        } catch (err) {
            reportError(err, { area: 'command', handler: 'ctxShowCommentary' });
            logger.error(`[CtxCommentary] Failed: ${err.message}`);
            try {
                // Must stay a V2 components edit. The reply was deferred with
                // IsComponentsV2, and V2 vs `content` are mutually exclusive —
                // the previous `content` version was silently rejected by
                // Discord and swallowed by this catch, leaving the user staring
                // at a "thinking..." spinner forever whenever this path ran.
                await interaction.editReply({
                    flags: MessageFlags.IsComponentsV2 | MessageFlags.Ephemeral,
                    components: [new TextDisplayBuilder().setContent('⚠️ Could not load commentary right now.')],
                });
            } catch { /* expired */ }
        }
    },
};
