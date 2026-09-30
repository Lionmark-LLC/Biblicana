import {
    SlashCommandBuilder,
    EmbedBuilder,
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    AttachmentBuilder,
    MessageFlags,
    ApplicationIntegrationType,
    InteractionContextType
} from 'discord.js';
import axios from 'axios';
import { getBookId, numbersToBook } from '../utils/bookNames.js';
import { resolveSingleChapterRef } from '../utils/scriptureRefs.js';
import logger from '../utils/logger.js';
import { reportError } from '../utils/errorReporting.js';
import swearWordFilter from '../utils/filter.js';
import { fetchIQBible } from '../utils/rapidApi.js';
import { accentColor, footerText } from '../utils/theme.js';
import 'dotenv/config';

const HARDCODED_VERSION = 'kjv';
const AUDIO_DOWNLOAD_TIMEOUT_MS = 30_000;
const AUDIO_MAX_BYTES = 25 * 1024 * 1024; // Discord's base attachment cap

async function fetchAudioNarration(bookId, chapter, version) {
    const params = {
        bookId: bookId.toString().padStart(2, '0'),
        chapterId: chapter.toString().padStart(3, '0'),
        versionId: version
    };
    logger.info(`[Audio Command] Fetching audio:`, params);
    return fetchIQBible('GetAudioNarration', params);
}

// V1 (legacy) message shape — V2's IsComponentsV2 flag disables inline
// rendering of plain file attachments, which is what breaks the desktop
// audio player. Sticking with EmbedBuilder + ActionRow here keeps the
// inline audio behavior that Discord auto-generates for audio attachments.
function buildAudioResponse({ bookId, bookName, chapter, audioUrl }) {
    const embed = new EmbedBuilder()
        .setColor(accentColor())
        .setTitle(`🔊 ${bookName} ${chapter} — Audio Narration (KJV)`)
        .setDescription(
            `Listen to ${bookName} chapter ${chapter} narrated in the King James Version.\n\n` +
            `💻 Audio player appears inline on desktop. 📱 Mobile users: tap **Download MP3** below.`
        )
        .setFooter({
            text: `${footerText()} | MP3 format`,
            iconURL: process.env.EMBEDICONURL
        });

    const inAppRow = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
            .setCustomId(`openverse:chapter:${bookId}:${chapter}:1`)
            .setLabel('Open chapter')
            .setEmoji({ name: '📖' })
            .setStyle(ButtonStyle.Secondary),
        new ButtonBuilder()
            // verse=0 sentinel tells the commentary handler to pull the chapter introduction
            .setCustomId(`openverse:commentary:${bookId}:${chapter}:0`)
            .setLabel('Chapter Commentary')
            .setEmoji({ name: '📚' })
            .setStyle(ButtonStyle.Secondary)
    );

    const linkRow = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
            .setLabel('Download MP3')
            .setEmoji({ name: '⬇️' })
            .setStyle(ButtonStyle.Link)
            .setURL(audioUrl)
    );

    return { embed, components: [inAppRow, linkRow] };
}

export default {
    data: new SlashCommandBuilder()
        .setName('audio')
        .setDescription('Get audio narration for a Bible chapter (KJV only)')
        .setIntegrationTypes(ApplicationIntegrationType.GuildInstall, ApplicationIntegrationType.UserInstall)
        .setContexts(InteractionContextType.Guild, InteractionContextType.BotDM, InteractionContextType.PrivateChannel)
        .addStringOption(option =>
            option.setName('book')
                .setDescription('The book name or abbreviation')
                .setRequired(true))
        .addStringOption(option =>
            option.setName('chapter')
                .setDescription('The chapter number')
                .setRequired(true)),

    async execute(interaction) {
        const rawBookInput = interaction.options.getString('book');
        const chapterInput = interaction.options.getString('chapter');

        const rawBook = swearWordFilter(rawBookInput.trim());
        if (!rawBook) {
            return interaction.reply({ content: 'Please provide a valid book name.', flags: MessageFlags.Ephemeral });
        }

        let chapter = parseInt(chapterInput);
        if (isNaN(chapter) || chapter < 1) {
            return interaction.reply({ content: 'Please provide a valid chapter number (1 or greater).', flags: MessageFlags.Ephemeral });
        }

        const bookId = getBookId(rawBook);
        const bookName = numbersToBook.get(bookId);
        if (!bookId || !bookName) {
            return interaction.reply({
                content: `I couldn't find the book "${rawBookInput}". Please check the spelling or use common abbreviations.`,
                flags: MessageFlags.Ephemeral
            });
        }

        // A one-chapter book has only chapter 1, whatever number was typed.
        // The verse half of the shorthand is deliberately dropped: this command
        // works a chapter at a time.
        ({ chapter } = resolveSingleChapterRef(bookId, chapter));

        await interaction.deferReply();

        try {
            const response = await fetchAudioNarration(bookId, chapter, HARDCODED_VERSION);
            const audioUrl = response?.data?.fileName;

            if (!audioUrl || typeof audioUrl !== 'string') {
                logger.warn(`[Audio Command] No valid fileName in API response for ${bookName} ${chapter}`);
                return interaction.editReply({
                    content: `❌ No audio narration found for ${bookName} chapter ${chapter} (KJV). It might not be available.`
                });
            }

            try {
                new URL(audioUrl);
            } catch (urlError) {
                reportError(urlError, { area: 'command', handler: 'audio' });
                logger.error(`[Audio Command] Invalid audio URL: ${audioUrl}`);
                return interaction.editReply({
                    content: `❌ Received an invalid audio link from the source.`
                });
            }

            // Download the MP3 ourselves via axios and pass the buffer to
            // AttachmentBuilder. When you pass a URL string, discord.js fetches
            // it using its bundled undici, which is unstable on Node <18.17
            // (our prod droplet runs 18.13) and terminates mid-fetch. Going
            // through axios (Node's native http) avoids that path entirely.
            let audioBuffer;
            try {
                const audioResponse = await axios.get(audioUrl, {
                    responseType: 'arraybuffer',
                    timeout: AUDIO_DOWNLOAD_TIMEOUT_MS,
                    maxContentLength: AUDIO_MAX_BYTES,
                    maxBodyLength: AUDIO_MAX_BYTES
                });
                audioBuffer = Buffer.from(audioResponse.data);
                logger.info(`[Audio Command] Downloaded ${bookName} ${chapter}: ${audioBuffer.length} bytes`);
            } catch (downloadError) {
                reportError(downloadError, { area: 'command', handler: 'audio' });
                logger.error(`[Audio Command] Download failed for ${bookName} ${chapter}: ${downloadError.message}`);
                return interaction.editReply({
                    content: `❌ The audio source was reachable but the MP3 download failed. The external audio server may be having issues — try again in a moment.`
                });
            }

            const audioAttachment = new AttachmentBuilder(audioBuffer, {
                name: `${bookName.replace(/ /g, '_')}_${chapter}_${HARDCODED_VERSION}.mp3`,
                description: `Audio narration for ${bookName} chapter ${chapter}`
            });

            const { embed, components } = buildAudioResponse({ bookId, bookName, chapter, audioUrl });

            await interaction.editReply({
                embeds: [embed],
                components,
                files: [audioAttachment]
            });
            logger.info(`[Audio Command] Sent audio for ${bookName} ${chapter}`);
        } catch (error) {
            const bookDisplay = bookName || rawBookInput || 'the specified book';
            const chapterDisplay = chapter || chapterInput || 'the specified chapter';
            reportError(error, { area: 'command', handler: 'audio' });
            logger.error(`[Audio Command] Error for ${bookDisplay} ${chapterDisplay}: ${error.message}`, error.stack);

            let userErrorMessage = 'Sorry, there was an error processing your request. Please try again later.';
            if (error.message?.includes('status 404') || error.message?.includes('Verse not found')) {
                userErrorMessage = `No audio narration available for ${bookDisplay} chapter ${chapterDisplay} (KJV).`;
            } else if (error.code === 'ECONNABORTED' || error.message?.includes('timed out')) {
                userErrorMessage = 'The request to the audio source timed out. Please try again later.';
            }

            try {
                await interaction.editReply({ content: `❌ ${userErrorMessage}` });
            } catch (replyError) {
                if (replyError.code !== 10062 && replyError.code !== 40060) {
                    logger.error(`[Audio Command] Failed to send error reply: ${replyError}`);
                }
            }
        }
    }
};
