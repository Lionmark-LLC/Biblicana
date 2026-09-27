import {
    ContextMenuCommandBuilder,
    ApplicationCommandType,
    ApplicationIntegrationType,
    InteractionContextType,
    MessageFlags,
    TextDisplayBuilder,
} from 'discord.js';
import { parseScriptureRefs } from '../utils/scriptureRefs.js';
import { getVersification } from '../utils/versification.js';
import { renderInterlinearEphemeral } from '../utils/interlinearRenderer.js';
import { respondToInteraction } from '../utils/paginationHelper.js';
import logger from '../utils/logger.js';
import { reportError } from '../utils/errorReporting.js';

// Message context-menu: right-click any message → Apps → "Show interlinear".
// Pulls the first verse-level scripture reference from the message and opens
// the interlinear (Hebrew/Greek + Strongs) view for that verse.
export default {
    data: new ContextMenuCommandBuilder()
        .setName('Show interlinear')
        .setType(ApplicationCommandType.Message)
        .setIntegrationTypes(ApplicationIntegrationType.GuildInstall, ApplicationIntegrationType.UserInstall)
        .setContexts(InteractionContextType.Guild, InteractionContextType.BotDM, InteractionContextType.PrivateChannel),

    async execute(interaction, database) {
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
                content: '🔍 Need a valid verse-level reference (like "John 3:16") for an interlinear view. That message has none I could parse.',
                flags: MessageFlags.Ephemeral,
            });
        }

        // ACK FIRST. Everything above is synchronous (string assembly + regex
        // parse); below is a preference read plus the interlinear fetch, which
        // joins bible.db and strongs.db. Flags must match what
        // renderInterlinearEphemeral sends, since the defer locks the shape.
        await interaction.deferReply({ flags: MessageFlags.IsComponentsV2 | MessageFlags.Ephemeral });

        let translation = 'BSB';
        try {
            const pref = await database.getUserValue(interaction.user.id);
            if (pref?.translation) translation = pref.translation;
        } catch { /* noop */ }

        try {
            await renderInterlinearEphemeral({
                interaction,
                bookId: verseRef.bookId,
                chapter: verseRef.chapter,
                verse: verseRef.startVerse,
                translation,
            });
        } catch (err) {
            reportError(err, { area: 'command', handler: 'ctxShowInterlinear' });
            logger.error(`[CtxInterlinear] Render failed: ${err.message}`);
            // The old `!interaction.replied` guard is wrong now that we defer:
            // after deferReply, `replied` is false but `deferred` is true, so a
            // bare reply() here would throw 40060 "already acknowledged".
            try {
                await respondToInteraction(interaction, {
                    flags: MessageFlags.IsComponentsV2 | MessageFlags.Ephemeral,
                    components: [new TextDisplayBuilder().setContent('⚠️ Could not load the interlinear view.')],
                });
            } catch { /* expired */ }
        }
    },
};
