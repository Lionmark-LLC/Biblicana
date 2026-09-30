import {
    ContextMenuCommandBuilder,
    ApplicationCommandType,
    ApplicationIntegrationType,
    InteractionContextType,
    MessageFlags,
    TextDisplayBuilder,
} from 'discord.js';
import { parseScriptureRefs } from '../utils/scriptureRefs.js';
import { getVersification, missingReferenceLine } from '../utils/versification.js';
import { renderBibleEphemeral } from '../utils/bibleRenderer.js';
import { respondToInteraction } from '../utils/paginationHelper.js';
import logger from '../utils/logger.js';
import { reportError } from '../utils/errorReporting.js';

// Message context-menu: right-click any message → Apps → "Look up scripture".
// Parses scripture references from the targeted message's content and shows
// the first one via the same ephemeral bible renderer that the /bible command
// uses. Works anywhere the user has Biblicana installed (guild or user install).
export default {
    data: new ContextMenuCommandBuilder()
        .setName('Look up scripture')
        .setType(ApplicationCommandType.Message)
        .setIntegrationTypes(ApplicationIntegrationType.GuildInstall, ApplicationIntegrationType.UserInstall)
        .setContexts(InteractionContextType.Guild, InteractionContextType.BotDM, InteractionContextType.PrivateChannel),

    async execute(interaction, database) {
        const target = interaction.targetMessage;
        // Context-menu commands on bot messages run on the bot's content too,
        // including BibleBot embeds — check embed text in addition to .content.
        const searchText = [
            target.content || '',
            ...(target.embeds || []).flatMap(e => [e.title, e.description, ...(e.fields || []).flatMap(f => [f.name, f.value])].filter(Boolean)),
        ].join(' ');

        const refs = parseScriptureRefs(searchText);
        if (refs.length === 0) {
            return interaction.reply({
                content: '🔍 No scripture references found in that message.',
                flags: MessageFlags.Ephemeral,
            });
        }

        const versification = await getVersification();
        const validRefs = versification.filter(refs);
        if (validRefs.length === 0) {
            // Every reference parsed but none exists ("Romans 17:1"): say why,
            // the way the 📖 reaction does. describeMissing is synchronous.
            const missing = refs.find(r => r.startVerse != null) ?? refs[0];
            return interaction.reply({
                content: `🔍 ${missingReferenceLine(versification, missing)}`,
                flags: MessageFlags.Ephemeral,
            });
        }

        // ACK FIRST. Everything above is synchronous (string assembly + regex
        // parse + versification filter), so this is the last point before I/O — a user preference read
        // followed by a verse fetch. Deferred flags must match what
        // renderBibleEphemeral ultimately sends, since the response shape is
        // locked here and V2/content are mutually exclusive.
        await interaction.deferReply({ flags: MessageFlags.IsComponentsV2 | MessageFlags.Ephemeral });

        // Pick the first ref with a concrete verse; fall back to the first ref
        // at all (chapter-only). renderBibleEphemeral handles both.
        const ref = validRefs.find(r => r.startVerse != null) ?? validRefs[0];

        let translation = 'BSB';
        try {
            const pref = await database.getUserValue(interaction.user.id);
            if (pref?.translation) translation = pref.translation;
        } catch { /* noop */ }

        try {
            await renderBibleEphemeral({
                interaction,
                bookId: ref.bookId,
                chapter: ref.chapter,
                startVerse: ref.startVerse ?? 1,
                endVerse: ref.endVerse ?? null,
                translation,
            });

            if (validRefs.length > 1) {
                const extras = validRefs.slice(1, 4).map(r => r.raw).join(', ');
                await interaction.followUp({
                    content: `-# Also found in that message: ${extras}${validRefs.length > 4 ? ` (+${validRefs.length - 4} more)` : ''} — right-click again or use \`/bible\` to look them up.`,
                    flags: MessageFlags.Ephemeral,
                });
            }
        } catch (err) {
            reportError(err, { area: 'command', handler: 'ctxLookupScripture' });
            logger.error(`[CtxLookup] Render failed: ${err.message}`);
            // The old `!interaction.replied` guard is wrong now that we defer:
            // after deferReply, `replied` is false but `deferred` is true, so a
            // bare reply() here would throw 40060 "already acknowledged".
            // respondToInteraction picks reply vs editReply correctly.
            try {
                await respondToInteraction(interaction, {
                    flags: MessageFlags.IsComponentsV2 | MessageFlags.Ephemeral,
                    components: [new TextDisplayBuilder().setContent('⚠️ Could not load that reference.')],
                });
            } catch { /* expired */ }
        }
    },
};
