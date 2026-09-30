import { EmbedBuilder, MessageFlags } from 'discord.js';
import { footerText } from '../../utils/theme.js';
import 'dotenv/config';

export default {
    id: "bias_alert",
    async execute(interaction) {
        try {
            const embedColor = process.env.EMBEDCOLOR ? parseInt(process.env.EMBEDCOLOR, 16) : 0xFFA500;

            const embed = new EmbedBuilder()
                .setTitle('⚠️ AI Response Disclaimer')
                .setDescription(
                    [
                        "Biblicana's AI features — **chat** (via @mentions or replies), **/find**, and **/web** — are powered by language models.",
                        '',
                        'Responses are **grounded in Biblicana\'s own commentary database** (Church Fathers and classical commentators) when you reference a specific verse, giving them more weight than a generic chatbot\'s answer. Even so, the model may occasionally:',
                        '• Miss theological nuance',
                        '• Paraphrase loosely rather than quote precisely',
                        '• Touch on secondary matters where sincere believers disagree',
                        '',
                        '**Always verify** important claims against Scripture itself and trusted teachers. Biblicana is a study companion — not a final theological authority.',
                    ].join('\n')
                )
                .setColor(embedColor)
                .setFooter({
                    text: footerText(),
                    iconURL: process.env.EMBEDICONURL
                });

            await interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
        } catch (error) {
            try {
                if (!interaction.replied) {
                    await interaction.reply({ content: 'Could not display disclaimer due to an error.', flags: MessageFlags.Ephemeral });
                }
            } catch (nestedError) {
                console.error('Error during fallback reply:', nestedError);
            }
        }
    }
};
