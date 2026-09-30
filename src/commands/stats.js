import { SlashCommandBuilder, EmbedBuilder, MessageFlags, ApplicationIntegrationType, InteractionContextType } from 'discord.js';
import logger from '../utils/logger.js';
import { reportError } from '../utils/errorReporting.js';
import { accentColor, footerText } from '../utils/theme.js';
import 'dotenv/config';

function formatUptime(ms) {
    const totalSeconds = Math.floor(ms / 1000);
    const days = Math.floor(totalSeconds / 86400);
    const hours = Math.floor((totalSeconds % 86400) / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    const seconds = totalSeconds % 60;

    let uptimeString = '';
    if (days > 0) uptimeString += `${days}d `;
    if (hours > 0) uptimeString += `${hours}h `;
    if (minutes > 0) uptimeString += `${minutes}m `;
    uptimeString += `${seconds}s`;

    return uptimeString.trim() || '0s';
}

export default {
    data: new SlashCommandBuilder()
        .setName('stats')
        .setDescription('Displays bot and server statistics.')
        .setIntegrationTypes(ApplicationIntegrationType.GuildInstall, ApplicationIntegrationType.UserInstall)
        .setContexts(InteractionContextType.Guild, InteractionContextType.BotDM, InteractionContextType.PrivateChannel),
    async execute(interaction) {
        try {
            const client = interaction.client;

            const wsPing = client.ws.ping;
            const uptime = formatUptime(client.uptime);
            const memoryUsage = (process.memoryUsage().heapUsed / 1024 / 1024).toFixed(2);

            const shardCount = client.ws.shards?.size || 1;
            const guildCount = client.guilds.cache.size;
            const userCount = client.users.cache.size;

            const embed = new EmbedBuilder()
                .setTitle('📊 Bot Statistics')
                .setColor(accentColor())
                .setURL(process.env.WEBSITE)
                .setDescription(`Here are the current stats for ${client.user.username}:`)
                .addFields(
                    { name: '💓 Ping', value: `~${wsPing}ms`, inline: true },
                    { name: '✅ Uptime', value: uptime, inline: true },
                    { name: '💾 Memory', value: `${memoryUsage} MB`, inline: true },
                    { name: '🌐 Guilds', value: guildCount.toString(), inline: true },
                    { name: '👤 Cached Users', value: userCount.toString(), inline: true },
                    { name: '🧩 Shards', value: shardCount.toString(), inline: true }
                )
                .setTimestamp()
                .setFooter({
                    text: footerText(),
                    iconURL: process.env.EMBEDICONURL
                });

            await interaction.reply({ embeds: [embed] });
        } catch (error) {
            reportError(error, { area: 'command', handler: 'stats' });
            logger.error(`[Stats Command] Error: ${error.message}`, error.stack);
            try {
                await interaction.reply({
                    content: '❌ Sorry, there was an error fetching the stats.',
                    flags: MessageFlags.Ephemeral
                });
            } catch (replyError) {
                if (replyError.code !== 10062 && replyError.code !== 40060) {
                    logger.error(`[Stats Command] Failed to send error reply: ${replyError}`);
                }
            }
        }
    }
};
