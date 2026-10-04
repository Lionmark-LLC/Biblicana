import { MessageFlags, ContainerBuilder, TextDisplayBuilder } from 'discord.js';
import { checkAckStatus, markAiTermsAcked, buildAckDisclosureV2, disclosureOptionsFor } from '../../utils/aiAck.js';
import { accentColor } from '../../utils/theme.js';
import logger from '../../utils/logger.js';
import { reportError } from '../../utils/errorReporting.js';

// "Got it" on a policy notice (aiAck.js, buildLegalNotice*): records a new
// acknowledgment timestamp, the click the Privacy Policy describes, so the
// notice stops showing.
//
// It never satisfies a MATERIAL version (Kenneth, 2026-10-03): that needs an
// Acknowledge on the full disclosure after the version's effective time. A
// notice button can outlive the state it was shown in, so the decision is
// re-checked here; while the user is blocked, the click saves nothing and
// they get the disclosure instead.
//
// customId format: `legal_notice_ok:<userId>`
export default {
    id: 'legal_notice_ok',
    async execute(interaction, database) {
        try {
            const [, encodedUserId] = interaction.customId.split(':');
            if (encodedUserId && interaction.user.id !== encodedUserId) {
                await interaction.reply({
                    content: 'This notice is for a different user.',
                    flags: MessageFlags.Ephemeral,
                });
                return;
            }

            const status = await checkAckStatus(database, interaction.user.id);
            if (status.reason === 'error') {
                await interaction.reply({ content: 'Couldn\'t save that right now — please try again in a moment.', flags: MessageFlags.Ephemeral });
                return;
            }
            if (!status.valid) {
                await interaction.reply({
                    flags: MessageFlags.Ephemeral | MessageFlags.IsComponentsV2,
                    components: buildAckDisclosureV2(interaction.user.id, disclosureOptionsFor(status)),
                });
                return;
            }

            if (!(await markAiTermsAcked(database, interaction.user.id))) {
                await interaction.reply({ content: 'Couldn\'t save that right now — please try again in a moment.', flags: MessageFlags.Ephemeral });
                return;
            }

            const isV2 = interaction.message?.flags?.has(MessageFlags.IsComponentsV2) ?? false;
            if (isV2) {
                await interaction.update({
                    components: [new ContainerBuilder().setAccentColor(accentColor())
                        .addTextDisplayComponents(new TextDisplayBuilder().setContent('Noted. Thanks for reading the update.'))],
                });
            } else {
                await interaction.update({ content: `${interaction.message?.content ?? ''}\n-# Noted.`, components: [] });
            }
        } catch (error) {
            reportError(error, { area: 'button', handler: 'legalNotice' });
            logger.error(`[LegalNotice] Failed to handle Got it: ${error.message}`);
        }
    },
};
