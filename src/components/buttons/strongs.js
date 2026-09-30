import { EmbedBuilder, MessageFlags } from 'discord.js';
import { strongsWrapper } from '../../utils/bibleHelper.js';
import logger from '../../utils/logger.js';
import { reportError } from '../../utils/errorReporting.js';
import { footerText } from '../../utils/theme.js';
import 'dotenv/config';

const HEBREW_COLOR = 0x3498DB;
const GREEK_COLOR = 0x9B59B6;
const MAX_DEFINITION_LENGTH = 3800;

export default {
    id: 'strongs',
    async execute(interaction) {
        // customId format: `strongs:<lexicon>:<strongsId>[:<occurrenceIdx>]`
        // The optional occurrence index disambiguates repeated words in the same verse
        // and is not used by this handler — the lookup is keyed on lexicon+strongsId alone.
        const parts = interaction.customId.split(':');
        if (parts.length < 3 || parts.length > 4) {
            logger.warn(`[Strongs Button] Malformed customId: ${interaction.customId}`);
            return interaction.reply({ content: 'Invalid lookup.', flags: MessageFlags.Ephemeral });
        }

        const [, lexicon, strongsId] = parts;
        if (lexicon !== 'Hebrew' && lexicon !== 'Greek') {
            return interaction.reply({ content: 'Invalid lexicon.', flags: MessageFlags.Ephemeral });
        }

        try {
            const data = await strongsWrapper.getStrongsId(lexicon, strongsId);
            if (!data || !data.strongs) {
                return interaction.reply({
                    content: `No entry found for ${strongsId} in the ${lexicon} lexicon.`,
                    flags: MessageFlags.Ephemeral
                });
            }

            const translit = lexicon === 'Greek'
                ? (data.translit || data.xlit || 'N/A')
                : (data.xlit || data.translit || 'N/A');

            const definition = lexicon === 'Greek'
                ? (data.definition || data.strong_def || 'No definition available.')
                : (data.strong_def || 'No definition available.');

            const truncatedDef = definition.length > MAX_DEFINITION_LENGTH
                ? definition.substring(0, MAX_DEFINITION_LENGTH - 3) + '...'
                : definition;

            const embed = new EmbedBuilder()
                .setColor(lexicon === 'Greek' ? GREEK_COLOR : HEBREW_COLOR)
                .setTitle(`📖 ${strongsId}${data.unicode ? ` — ${data.unicode}` : ''}`)
                .setDescription([
                    `**Transliteration:** ${translit}`,
                    '',
                    `**Definition:**`,
                    truncatedDef
                ].join('\n'))
                .setFooter({
                    text: `${footerText()} | ${lexicon} Lexicon`,
                    iconURL: process.env.EMBEDICONURL
                });

            await interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
        } catch (error) {
            reportError(error, { area: 'button', handler: 'strongs' });
            logger.error(`[Strongs Button] Error fetching ${lexicon}/${strongsId}: ${error.message}`);
            try {
                await interaction.reply({
                    content: 'Error fetching definition. Please try again later.',
                    flags: MessageFlags.Ephemeral
                });
            } catch (replyError) {
                logger.error(`[Strongs Button] Failed to send error reply: ${replyError.message}`);
            }
        }
    }
};
