const { Client, GatewayIntentBits, EmbedBuilder, ChannelType, PermissionFlagsBits, ActionRowBuilder, ButtonBuilder, ButtonStyle, Partials, StringSelectMenuBuilder, ModalBuilder, TextInputBuilder, TextInputStyle } = require('discord.js');
const fs = require('fs');
const path = require('path');

const config = {
    token: 'YOUR_BOT_TOKEN_HERE',
    prefix: '-',
    guildId: '1268098266319421463',
    modmailCategory: 'Call-Center',
    modmailStaffRole: 'Ticket Support',
    logChannel: 'transcripts',
    adminUsers: ['1050844554250702859', '814983247120564234'],
    maxTicketsPerUser: 3,
    autoCloseInactiveAfter: 72,
    requireCategory: true,
    categories: ['General Support', 'Technical Issue', 'Report User', 'Partnership', 'Other'],
    anonymousMode: false,
    rateLimitMessages: 5,
    rateLimitWindow: 60000,
    enableSnippets: true,
    enablePriority: true,
    enableTags: true,
    enableScheduledClose: true,
    enableUserNotes: true,
    enableBlacklist: true,
    webhookLogging: true
};

const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.DirectMessages,
        GatewayIntentBits.GuildMembers,
        GatewayIntentBits.GuildPresences
    ],
    partials: [Partials.Channel, Partials.Message, Partials.User]
});

const modmailSessions = new Map();
const userNotes = new Map();
const snippets = new Map();
const userRateLimits = new Map();
const blacklistedUsers = new Set();
const scheduledClosures = new Map();
const ticketStats = {
    total: 0,
    closed: 0,
    avgResponseTime: 0,
    avgCloseTime: 0
};

const dataDir = path.join(__dirname, 'data');
const transcriptsDir = path.join(__dirname, 'transcripts');

if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir);
if (!fs.existsSync(transcriptsDir)) fs.mkdirSync(transcriptsDir);

const loadData = () => {
    try {
        if (fs.existsSync(path.join(dataDir, 'snippets.json'))) {
            const data = JSON.parse(fs.readFileSync(path.join(dataDir, 'snippets.json')));
            Object.entries(data).forEach(([key, value]) => snippets.set(key, value));
        }
        if (fs.existsSync(path.join(dataDir, 'notes.json'))) {
            const data = JSON.parse(fs.readFileSync(path.join(dataDir, 'notes.json')));
            Object.entries(data).forEach(([key, value]) => userNotes.set(key, value));
        }
        if (fs.existsSync(path.join(dataDir, 'blacklist.json'))) {
            const data = JSON.parse(fs.readFileSync(path.join(dataDir, 'blacklist.json')));
            data.forEach(id => blacklistedUsers.add(id));
        }
        if (fs.existsSync(path.join(dataDir, 'stats.json'))) {
            const data = JSON.parse(fs.readFileSync(path.join(dataDir, 'stats.json')));
            Object.assign(ticketStats, data);
        }
        console.log('✅ Loaded persistent data');
    } catch (error) {
        console.error('Error loading data:', error);
    }
};

const saveData = () => {
    try {
        fs.writeFileSync(
            path.join(dataDir, 'snippets.json'),
            JSON.stringify(Object.fromEntries(snippets), null, 2)
        );
        fs.writeFileSync(
            path.join(dataDir, 'notes.json'),
            JSON.stringify(Object.fromEntries(userNotes), null, 2)
        );
        fs.writeFileSync(
            path.join(dataDir, 'blacklist.json'),
            JSON.stringify(Array.from(blacklistedUsers), null, 2)
        );
        fs.writeFileSync(
            path.join(dataDir, 'stats.json'),
            JSON.stringify(ticketStats, null, 2)
        );
    } catch (error) {
        console.error('Error saving data:', error);
    }
};

// Utility functions
const isAdmin = (userId) => config.adminUsers.includes(userId);

const getLogChannel = (guild) => {
    return guild.channels.cache.find(ch => ch.name === config.logChannel);
};

const checkRateLimit = (userId) => {
    if (!userRateLimits.has(userId)) {
        userRateLimits.set(userId, []);
    }
    
    const now = Date.now();
    const timestamps = userRateLimits.get(userId).filter(t => now - t < config.rateLimitWindow);
    
    if (timestamps.length >= config.rateLimitMessages) {
        return false;
    }
    
    timestamps.push(now);
    userRateLimits.set(userId, timestamps);
    return true;
};

const getUserTicketCount = (userId) => {
    return Array.from(modmailSessions.values()).filter(s => s.userId === userId).length;
};

const formatDuration = (ms) => {
    const hours = Math.floor(ms / 3600000);
    const minutes = Math.floor((ms % 3600000) / 60000);
    return `${hours}h ${minutes}m`;
};

const createModmailChannel = async (guild, user, category = null) => {
    try {
        if (blacklistedUsers.has(user.id)) {
            await user.send('You are currently blocked from creating modmail tickets. Please contact an administrator.').catch(() => {});
            return null;
        }

        if (getUserTicketCount(user.id) >= config.maxTicketsPerUser) {
            await user.send(`You already have ${config.maxTicketsPerUser} open tickets. Please close an existing ticket before opening a new one.`).catch(() => {});
            return null;
        }

        if (modmailSessions.has(user.id)) {
            const session = modmailSessions.get(user.id);
            const existingChannel = guild.channels.cache.get(session.channelId);
            if (existingChannel) {
                return { channel: existingChannel, isNew: false };
            } else {
                modmailSessions.delete(user.id);
            }
        }

        let categoryChannel = guild.channels.cache.find(
            c => c.type === ChannelType.GuildCategory && c.name === config.modmailCategory
        );

        if (!categoryChannel) {
            categoryChannel = await guild.channels.create({
                name: config.modmailCategory,
                type: ChannelType.GuildCategory
            });
        }

        const staffRole = guild.roles.cache.find(r => r.name === config.modmailStaffRole);

        const ticketNumber = ticketStats.total + 1;
        const channel = await guild.channels.create({
            name: `ticket-${ticketNumber}-${user.username.toLowerCase().replace(/[^a-z0-9]/g, '')}`,
            type: ChannelType.GuildText,
            parent: categoryChannel.id,
            topic: `Ticket #${ticketNumber} | User: ${user.tag} (${user.id}) | Category: ${category || 'None'} | Priority: Normal`,
            permissionOverwrites: [
                {
                    id: guild.id,
                    deny: [PermissionFlagsBits.ViewChannel]
                },
                {
                    id: staffRole ? staffRole.id : guild.roles.everyone.id,
                    allow: [
                        PermissionFlagsBits.ViewChannel,
                        PermissionFlagsBits.SendMessages,
                        PermissionFlagsBits.ReadMessageHistory,
                        PermissionFlagsBits.AttachFiles
                    ]
                },
                {
                    id: client.user.id,
                    allow: [
                        PermissionFlagsBits.ViewChannel,
                        PermissionFlagsBits.SendMessages,
                        PermissionFlagsBits.ManageChannels
                    ]
                }
            ]
        });

        const sessionData = {
            userId: user.id,
            channelId: channel.id,
            ticketNumber: ticketNumber,
            claimed: false,
            claimer: null,
            claimerUserId: null,
            category: category || 'General Support',
            priority: 'Normal',
            tags: [],
            createdAt: Date.now(),
            lastActivity: Date.now(),
            messageCount: 0,
            staffResponses: 0,
            firstResponseTime: null
        };
        
        modmailSessions.set(user.id, sessionData);
        ticketStats.total++;
        saveData();

        const notes = userNotes.get(user.id) || [];
        const notesText = notes.length > 0 ? notes.slice(-3).map((n, i) => `${i + 1}. ${n.note} - *${n.staff}* (${new Date(n.timestamp).toLocaleDateString()})`).join('\n') : 'No previous notes';

        const member = guild.members.cache.get(user.id);
        const embed = new EmbedBuilder()
            .setTitle(`Modmail Ticket #${ticketNumber}`)
            .setDescription(`**User:** ${user.tag} (${user})\n**ID:** \`${user.id}\`\n**Category:** ${category || 'General Support'}`)
            .addFields(
                { name: 'Account Created', value: user.createdAt.toDateString(), inline: true },
                { name: 'Status', value: 'Open', inline: true },
                { name: 'Priority', value: 'Normal', inline: true },
                { name: 'Tags', value: 'None', inline: true },
                { name: 'Server Member', value: member ? 'Yes' : 'No', inline: true },
                { name: 'Recent Notes', value: notesText, inline: false }
            )
            .setThumbnail(user.displayAvatarURL({ dynamic: true }))
            .setColor('#00ff00')
            .setTimestamp()
            .setFooter({ text: 'Use -help to see all commands' });

        const row1 = new ActionRowBuilder()
            .addComponents(
                new ButtonBuilder()
                    .setCustomId('modmail_claim')
                    .setLabel('Claim')
                    .setStyle(ButtonStyle.Primary),
                new ButtonBuilder()
                    .setCustomId('modmail_priority')
                    .setLabel('Set Priority')
                    .setStyle(ButtonStyle.Secondary),
                new ButtonBuilder()
                    .setCustomId('modmail_tag')
                    .setLabel('Add Tag')
                    .setStyle(ButtonStyle.Secondary),
                new ButtonBuilder()
                    .setCustomId('modmail_note')
                    .setLabel('Add Note')
                    .setStyle(ButtonStyle.Secondary)
            );

        const row2 = new ActionRowBuilder()
            .addComponents(
                new ButtonBuilder()
                    .setCustomId('modmail_close')
                    .setLabel('Close')
                    .setStyle(ButtonStyle.Danger),
                new ButtonBuilder()
                    .setCustomId('modmail_schedule_close')
                    .setLabel('Schedule Close')
                    .setStyle(ButtonStyle.Secondary),
                new ButtonBuilder()
                    .setCustomId('modmail_transcript')
                    .setLabel('Transcript')
                    .setStyle(ButtonStyle.Secondary),
                new ButtonBuilder()
                    .setCustomId('modmail_info')
                    .setLabel('User Info')
                    .setStyle(ButtonStyle.Secondary)
            );

        await channel.send({ 
            content: staffRole ? `${staffRole}` : '@here New modmail ticket opened!',
            embeds: [embed], 
            components: [row1, row2] 
        });

        const logChannel = getLogChannel(guild);
        if (logChannel) {
            const logEmbed = new EmbedBuilder()
                .setTitle('Modmail Ticket Opened')
                .setDescription(`${user.tag} opened ticket #${ticketNumber}`)
                .addFields(
                    { name: 'Channel', value: `<#${channel.id}>`, inline: true },
                    { name: 'Category', value: category || 'None', inline: true },
                    { name: 'User', value: `${user}`, inline: true }
                )
                .setColor('#00ff00')
                .setTimestamp();
            await logChannel.send({ embeds: [logEmbed] });
        }

        return { channel, isNew: true };

    } catch (error) {
        console.error('Error creating modmail channel:', error);
        return null;
    }
};

const closeModmail = async (channel, closer, reason = 'No reason provided') => {
    try {
        const userId = Array.from(modmailSessions.entries())
            .find(([_, session]) => session.channelId === channel.id)?.[0];

        if (!userId) return false;

        const sessionData = modmailSessions.get(userId);
        const duration = Date.now() - sessionData.createdAt;

        const messages = await channel.messages.fetch({ limit: 100 });
        const transcript = messages.reverse().map(m => 
            `[${m.createdAt.toLocaleString()}] ${m.author.tag}: ${m.content || '[Embed/Attachment]'}`
        ).join('\n');

        const transcriptPath = path.join(transcriptsDir, `ticket-${sessionData.ticketNumber}-${userId}-${Date.now()}.txt`);
        
        const fullTranscript = `
==============================================
MODMAIL TICKET TRANSCRIPT
==============================================
Ticket Number: #${sessionData.ticketNumber}
User: ${(await client.users.fetch(userId)).tag} (${userId})
Category: ${sessionData.category}
Priority: ${sessionData.priority}
Tags: ${sessionData.tags.join(', ') || 'None'}
Opened: ${new Date(sessionData.createdAt).toLocaleString()}
Closed: ${new Date().toLocaleString()}
Duration: ${formatDuration(duration)}
Claimed By: ${sessionData.claimer || 'Unclaimed'}
Closed By: ${closer.tag}
Reason: ${reason}
Messages: ${sessionData.messageCount}
Staff Responses: ${sessionData.staffResponses}
First Response Time: ${sessionData.firstResponseTime ? formatDuration(sessionData.firstResponseTime) : 'N/A'}
==============================================

${transcript}
`;
        
        fs.writeFileSync(transcriptPath, fullTranscript);

        try {
            const user = await client.users.fetch(userId);
            const dmEmbed = new EmbedBuilder()
                .setTitle('Modmail Ticket Closed')
                .setDescription(`Your ticket (#${sessionData.ticketNumber}) has been closed.`)
                .addFields(
                    { name: 'Category', value: sessionData.category, inline: true },
                    { name: 'Duration', value: formatDuration(duration), inline: true },
                    { name: 'Closed By', value: config.anonymousMode ? 'Staff Team' : closer.tag, inline: true },
                    { name: 'Reason', value: reason, inline: false }
                )
                .setColor('#ff0000')
                .setTimestamp()
                .setFooter({ text: 'Thank you for contacting us! Feel free to DM me again if you need help.' });
            
            await user.send({ embeds: [dmEmbed] });
        } catch (error) {
            console.log('Could not DM user about closure');
        }

        ticketStats.closed++;
        if (sessionData.firstResponseTime) {
            const currentAvg = ticketStats.avgResponseTime;
            ticketStats.avgResponseTime = ((currentAvg * (ticketStats.closed - 1)) + sessionData.firstResponseTime) / ticketStats.closed;
        }
        const currentAvgClose = ticketStats.avgCloseTime;
        ticketStats.avgCloseTime = ((currentAvgClose * (ticketStats.closed - 1)) + duration) / ticketStats.closed;
        saveData();

        const logChannel = getLogChannel(channel.guild);
        if (logChannel) {
            const logEmbed = new EmbedBuilder()
                .setTitle(`Ticket #${sessionData.ticketNumber} Closed`)
                .addFields(
                    { name: 'User', value: `<@${userId}>`, inline: true },
                    { name: 'Category', value: sessionData.category, inline: true },
                    { name: 'Priority', value: sessionData.priority, inline: true },
                    { name: 'Duration', value: formatDuration(duration), inline: true },
                    { name: 'Messages', value: sessionData.messageCount.toString(), inline: true },
                    { name: 'Staff Responses', value: sessionData.staffResponses.toString(), inline: true },
                    { name: 'Claimed By', value: sessionData.claimer || 'Unclaimed', inline: true },
                    { name: 'Closed By', value: closer.tag, inline: true },
                    { name: 'Tags', value: sessionData.tags.join(', ') || 'None', inline: true },
                    { name: 'Reason', value: reason, inline: false }
                )
                .setColor('#ff0000')
                .setTimestamp();
            
            await logChannel.send({ 
                embeds: [logEmbed],
                files: [{ attachment: transcriptPath, name: `transcript-${sessionData.ticketNumber}.txt` }]
            });
        }

        if (scheduledClosures.has(channel.id)) {
            clearTimeout(scheduledClosures.get(channel.id));
            scheduledClosures.delete(channel.id);
        }

        modmailSessions.delete(userId);
        await channel.delete();
        return true;

    } catch (error) {
        console.error('Error closing modmail:', error);
        return false;
    }
};

const checkInactiveTickets = () => {
    const now = Date.now();
    const inactiveThreshold = config.autoCloseInactiveAfter * 3600000;

    for (const [userId, session] of modmailSessions.entries()) {
        if (now - session.lastActivity > inactiveThreshold) {
            const guild = client.guilds.cache.get(config.guildId);
            if (guild) {
                const channel = guild.channels.cache.get(session.channelId);
                if (channel) {
                    closeModmail(channel, client.user, 'Automatically closed due to inactivity');
                }
            }
        }
    }
};

client.once('ready', () => {
    console.log(`Enhanced Modmail Bot logged in as ${client.user.tag}`);
    console.log(`Loaded ${snippets.size} snippets`);
    console.log(`Loaded notes for ${userNotes.size} users`);
    console.log(`${blacklistedUsers.size} blacklisted users`);
    console.log(`Total tickets: ${ticketStats.total} | Closed: ${ticketStats.closed}`);
    
    loadData();
    client.user.setActivity('DMs for support', { type: 3 });
    
    setInterval(checkInactiveTickets, 3600000);
});

client.on('messageCreate', async message => {
    if (message.channel.type === ChannelType.DM && !message.author.bot) {
        try {
            if (!checkRateLimit(message.author.id)) {
                return message.reply('You\'re sending messages too quickly. Please slow down.').catch(() => {});
            }

            const guild = client.guilds.cache.get(config.guildId);
            if (!guild) {
                return message.reply('Bot configuration error.');
            }

            if (!modmailSessions.has(message.author.id) && config.requireCategory) {
                const row = new ActionRowBuilder()
                    .addComponents(
                        new StringSelectMenuBuilder()
                            .setCustomId('select_category')
                            .setPlaceholder('Select a category for your ticket')
                            .addOptions(
                                config.categories.map(cat => ({
                                    label: cat,
                                    value: cat
                                }))
                            )
                    );

                return message.reply({
                    content: 'Hello! Please select a category for your ticket:',
                    components: [row]
                });
            }

            const result = await createModmailChannel(guild, message.author);
            if (!result) return;

            const { channel, isNew } = result;
            const session = modmailSessions.get(message.author.id);
            session.lastActivity = Date.now();
            session.messageCount++;

            const embed = new EmbedBuilder()
                .setAuthor({ 
                    name: message.author.tag, 
                    iconURL: message.author.displayAvatarURL({ dynamic: true }) 
                })
                .setDescription(message.content || '*[No text content]*')
                .setColor('#3498db')
                .setTimestamp()
                .setFooter({ text: `User ID: ${message.author.id} | Message ${session.messageCount}` });

            if (message.attachments.size > 0) {
                const attachments = message.attachments.map(att => `[${att.name}](${att.url})`).join('\n');
                embed.addFields({ name: 'Attachments', value: attachments });
            }

            await channel.send({ embeds: [embed] });

            if (isNew) {
                const confirmEmbed = new EmbedBuilder()
                    .setTitle('Ticket Created')
                    .setDescription(`Your ticket (#${session.ticketNumber}) has been created in the **${session.category}** category.\n\nOur staff team will respond as soon as possible!`)
                    .setColor('#00ff00')
                    .setFooter({ text: 'Continue sending messages - they will all be forwarded to staff.' });
                
                await message.reply({ embeds: [confirmEmbed] });
            } else {
                await message.react('✅');
            }

        } catch (error) {
            console.error('Modmail DM error:', error);
            await message.reply('❌ An error occurred. Please try again.').catch(() => {});
        }
        return;
    }

    if (!message.guild || message.author.bot) return;

    const session = Array.from(modmailSessions.entries())
        .find(([_, data]) => data.channelId === message.channel.id);
    
    if (!session) return;

    const [userId, sessionData] = session;

    if (message.content.startsWith(config.prefix)) {
        const args = message.content.slice(config.prefix.length).trim().split(/ +/);
        const command = args.shift().toLowerCase();

        try {
            switch (command) {
                case 'help':
                    const helpEmbed = new EmbedBuilder()
                        .setTitle('📚 Modmail Commands')
                        .setDescription('Here are all available commands:')
                        .addFields(
                            { name: '💬 Messaging', value: '`-r <msg>` Reply to user\n`-ar <msg>` Anonymous reply\n`-snippet <name>` Send snippet', inline: false },
                            { name: '🎫 Ticket Management', value: '`-claim` Claim ticket\n`-unclaim` Unclaim ticket\n`-close [reason]` Close ticket\n`-priority <level>` Set priority\n`-tag <tag>` Add tag\n`-schedule <hours>` Schedule close', inline: false },
                            { name: '📝 User Management', value: '`-note <text>` Add note\n`-notes` View notes\n`-info` User info\n`-blacklist [reason]` Block user\n`-unblacklist` Unblock user', inline: false },
                            { name: '📊 Snippets & Stats', value: '`-snippet-add <name> <text>` Create snippet\n`-snippet-list` List snippets\n`-stats` View statistics', inline: false },
                            { name: '📄 Other', value: '`-transcript` Get transcript\n`-history` View ticket history', inline: false }
                        )
                        .setColor('#9c27b0')
                        .setTimestamp();
                    
                    message.reply({ embeds: [helpEmbed] });
                    break;

                case 'r':
                case 'reply':
                    if (!args.length) {
                        return message.reply('Usage: `-r <message>`');
                    }

                    try {
                        const user = await client.users.fetch(userId);
                        const replyContent = args.join(' ');

                        const dmEmbed = new EmbedBuilder()
                            .setAuthor({ 
                                name: config.anonymousMode ? 'Staff Team' : `${message.author.tag} (Staff)`, 
                                iconURL: config.anonymousMode ? message.guild.iconURL() : message.author.displayAvatarURL({ dynamic: true }) 
                            })
                            .setDescription(replyContent)
                            .setColor('#00ff00')
                            .setTimestamp()
                            .setFooter({ text: 'Reply by sending another message here' });

                        await user.send({ embeds: [dmEmbed] });

                        const confirmEmbed = new EmbedBuilder()
                            .setAuthor({ 
                                name: message.author.tag, 
                                iconURL: message.author.displayAvatarURL({ dynamic: true }) 
                            })
                            .setDescription(replyContent)
                            .setColor('#00ff00')
                            .setTimestamp()
                            .setFooter({ text: '✅ Message sent to user' });

                        await message.channel.send({ embeds: [confirmEmbed] });
                        await message.delete().catch(() => {});

                        if (!sessionData.firstResponseTime) {
                            sessionData.firstResponseTime = Date.now() - sessionData.createdAt;
                        }
                        sessionData.staffResponses++;
                        sessionData.lastActivity = Date.now();

                    } catch (error) {
                        message.reply('Failed to send reply. User may have DMs disabled.');
                    }
                    break;

                case 'ar':
                case 'anon-reply':
                    if (!args.length) {
                        return message.reply('Usage: `-ar <message>`');
                    }

                    try {
                        const user = await client.users.fetch(userId);
                        const replyContent = args.join(' ');

                        const dmEmbed = new EmbedBuilder()
                            .setAuthor({ 
                                name: 'Staff Team', 
                                iconURL: message.guild.iconURL() 
                            })
                            .setDescription(replyContent)
                            .setColor('#00ff00')
                            .setTimestamp();

                        await user.send({ embeds: [dmEmbed] });

                        const confirmEmbed = new EmbedBuilder()
                            .setDescription(`📨 Anonymous reply sent:\n${replyContent}`)
                            .setColor('#00ff00')
                            .setFooter({ text: `Sent by ${message.author.tag}` });

                        await message.channel.send({ embeds: [confirmEmbed] });
                        await message.delete().catch(() => {});

                        sessionData.lastActivity = Date.now();

                    } catch (error) {
                        message.reply('Failed to send anonymous reply.');
                    }
                    break;

                case 'close':
                    const reason = args.join(' ') || 'No reason provided';
                    const closeEmbed = new EmbedBuilder()
                        .setTitle('Closing Ticket...')
                        .setDescription(`Reason: ${reason}`)
                        .setColor('#ff9800');
                    
                    await message.channel.send({ embeds: [closeEmbed] });
                    
                    setTimeout(async () => {
                        await closeModmail(message.channel, message.author, reason);
                    }, 3000);
                    break;

                case 'claim':
                    if (sessionData.claimed) {
                        return message.reply(`Already claimed by ${sessionData.claimer}`);
                    }

                    sessionData.claimed = true;
                    sessionData.claimer = message.author.tag;
                    sessionData.claimerUserId = message.author.id;

                    const claimEmbed = new EmbedBuilder()
                        .setTitle('Ticket Claimed')
                        .setDescription(`${message.author} has claimed this ticket.`)
                        .setColor('#2196f3')
                        .setTimestamp();
                    
                    await message.channel.send({ embeds: [claimEmbed] });
                    
                    await message.channel.setTopic(
                        `Ticket #${sessionData.ticketNumber} | User: ${userId} | Category: ${sessionData.category} | Priority: ${sessionData.priority} | Claimed by: ${message.author.tag}`
                    );
                    break;

                case 'unclaim':
                    if (!sessionData.claimed) {
                        return message.reply('This ticket is not claimed.');
                    }

                    sessionData.claimed = false;
                    sessionData.claimer = null;
                    sessionData.claimerUserId = null;

                    const unclaimEmbed = new EmbedBuilder()
                        .setTitle('Ticket Unclaimed')
                        .setDescription('This ticket is now available for other staff members.')
                        .setColor('#ff9800')
                        .setTimestamp();

                    await message.channel.send({ embeds: [unclaimEmbed] });
                    
                    await message.channel.setTopic(
                        `Ticket #${sessionData.ticketNumber} | User: ${userId} | Category: ${sessionData.category} | Priority: ${sessionData.priority}`
                    );
                    break;

                case 'priority':
                    if (!args.length) {
                        return message.reply('Usage: `-priority <low|normal|high|urgent>`');
                    }

                    const priority = args[0].toLowerCase();
                    const validPriorities = ['low', 'normal', 'high', 'urgent'];
                    
                    if (!validPriorities.includes(priority)) {
                        return message.reply('Invalid priority. Use: low, normal, high, or urgent');
                    }

                    sessionData.priority = priority.charAt(0).toUpperCase() + priority.slice(1);

                    const priorityColors = {
                        low: '#808080',
                        normal: '#00ff00',
                        high: '#ff9800',
                        urgent: '#ff0000'
                    };

                    const priorityEmbed = new EmbedBuilder()
                        .setTitle('Priority Updated')
                        .setDescription(`Ticket priority set to: **${sessionData.priority}**`)
                        .setColor(priorityColors[priority])
                        .setTimestamp();

                    await message.channel.send({ embeds: [priorityEmbed] });
                    
                    await message.channel.setTopic(
                        `Ticket #${sessionData.ticketNumber} | User: ${userId} | Category: ${sessionData.category} | Priority: ${sessionData.priority}`
                    );
                    break;

                case 'tag':
                    if (!args.length) {
                        return message.reply('Usage: `-tag <tag_name>` to add a tag, or `-tag remove <tag_name>` to remove');
                    }

                    if (args[0].toLowerCase() === 'remove') {
                        const tagToRemove = args.slice(1).join(' ');
                        const index = sessionData.tags.indexOf(tagToRemove);
                        if (index > -1) {
                            sessionData.tags.splice(index, 1);
                            message.reply(`Removed tag: **${tagToRemove}**`);
                        } else {
                            message.reply('Tag not found.');
                        }
                    } else {
                        const newTag = args.join(' ');
                        if (!sessionData.tags.includes(newTag)) {
                            sessionData.tags.push(newTag);
                            message.reply(`Added tag: **${newTag}**`);
                        } else {
                            message.reply('Tag already exists.');
                        }
                    }
                    break;

                case 'note':
                    if (!args.length) {
                        return message.reply('Usage: `-note <note_text>`');
                    }

                    const noteText = args.join(' ');
                    if (!userNotes.has(userId)) {
                        userNotes.set(userId, []);
                    }

                    userNotes.get(userId).push({
                        note: noteText,
                        staff: message.author.tag,
                        staffId: message.author.id,
                        timestamp: Date.now(),
                        ticketNumber: sessionData.ticketNumber
                    });

                    saveData();

                    const noteEmbed = new EmbedBuilder()
                        .setTitle('Note Added')
                        .setDescription(noteText)
                        .setFooter({ text: `Added by ${message.author.tag}` })
                        .setColor('#9c27b0')
                        .setTimestamp();

                    await message.channel.send({ embeds: [noteEmbed] });
                    break;

                case 'notes':
                    const notes = userNotes.get(userId) || [];
                    
                    if (notes.length === 0) {
                        return message.reply('No notes found for this user.');
                    }

                    const notesEmbed = new EmbedBuilder()
                        .setTitle('User Notes')
                        .setDescription(`Found ${notes.length} note(s) for this user:`)
                        .setColor('#9c27b0')
                        .setTimestamp();

                    notes.forEach((note, index) => {
                        notesEmbed.addFields({
                            name: `Note #${index + 1} - ${note.staff} (Ticket #${note.ticketNumber})`,
                            value: `${note.note}\n*${new Date(note.timestamp).toLocaleString()}*`,
                            inline: false
                        });
                    });

                    await message.reply({ embeds: [notesEmbed] });
                    break;

                case 'transcript':
                    const messages = await message.channel.messages.fetch({ limit: 100 });
                    const transcript = messages.reverse().map(m => 
                        `[${m.createdAt.toLocaleString()}] ${m.author.tag}: ${m.content || '[Embed/Attachment]'}`
                    ).join('\n');

                    const transcriptBuffer = Buffer.from(transcript, 'utf-8');
                    await message.reply({
                        content: '📄 Current transcript:',
                        files: [{
                            attachment: transcriptBuffer,
                            name: `transcript-${sessionData.ticketNumber}-${Date.now()}.txt`
                        }]
                    });
                    break;

                case 'info':
                    try {
                        const user = await client.users.fetch(userId);
                        const member = message.guild.members.cache.get(userId);
                        const notes = userNotes.get(userId) || [];

                        const infoEmbed = new EmbedBuilder()
                            .setTitle('ℹ️ User Information')
                            .setThumbnail(user.displayAvatarURL({ dynamic: true }))
                            .addFields(
                                { name: 'Username', value: user.tag, inline: true },
                                { name: 'User ID', value: user.id, inline: true },
                                { name: 'Account Created', value: user.createdAt.toDateString(), inline: true },
                                { name: 'Server Member', value: member ? 'Yes' : 'No', inline: true },
                                { name: 'Ticket Number', value: `#${sessionData.ticketNumber}`, inline: true },
                                { name: 'Category', value: sessionData.category, inline: true },
                                { name: 'Priority', value: sessionData.priority, inline: true },
                                { name: 'Status', value: sessionData.claimed ? `Claimed by ${sessionData.claimer}` : 'Unclaimed', inline: true },
                                { name: 'Tags', value: sessionData.tags.join(', ') || 'None', inline: true },
                                { name: 'Messages Sent', value: sessionData.messageCount.toString(), inline: true },
                                { name: 'Staff Responses', value: sessionData.staffResponses.toString(), inline: true },
                                { name: 'Total Notes', value: notes.length.toString(), inline: true }
                            )
                            .setColor('#9c27b0')
                            .setTimestamp();

                        if (member) {
                            infoEmbed.addFields({ 
                                name: 'Joined Server', 
                                value: member.joinedAt.toDateString(), 
                                inline: true 
                            });
                        }

                        await message.reply({ embeds: [infoEmbed] });
                    } catch (error) {
                        message.reply('❌ Failed to fetch user information.');
                    }
                    break;

                case 'snippet':
                    if (!args.length) {
                        return message.reply('Usage: `-snippet <name>` to send a snippet');
                    }

                    const snippetName = args[0].toLowerCase();
                    if (!snippets.has(snippetName)) {
                        return message.reply(`Snippet "${snippetName}" not found. Use \`-snippet-list\` to see all snippets.`);
                    }

                    try {
                        const user = await client.users.fetch(userId);
                        const snippetContent = snippets.get(snippetName);

                        const dmEmbed = new EmbedBuilder()
                            .setAuthor({ 
                                name: config.anonymousMode ? 'Staff Team' : `${message.author.tag} (Staff)`, 
                                iconURL: config.anonymousMode ? message.guild.iconURL() : message.author.displayAvatarURL({ dynamic: true }) 
                            })
                            .setDescription(snippetContent)
                            .setColor('#00ff00')
                            .setTimestamp();

                        await user.send({ embeds: [dmEmbed] });

                        const confirmEmbed = new EmbedBuilder()
                            .setDescription(`📨 Sent snippet: **${snippetName}**\n\n${snippetContent}`)
                            .setColor('#00ff00')
                            .setFooter({ text: `Sent by ${message.author.tag}` });

                        await message.channel.send({ embeds: [confirmEmbed] });
                        await message.delete().catch(() => {});

                        sessionData.lastActivity = Date.now();

                    } catch (error) {
                        message.reply('Failed to send snippet.');
                    }
                    break;

                case 'snippet-add':
                    if (!isAdmin(message.author.id)) {
                        return message.reply('Only admins can add snippets.');
                    }

                    if (args.length < 2) {
                        return message.reply('Usage: `-snippet-add <name> <content>`');
                    }

                    const newSnippetName = args[0].toLowerCase();
                    const newSnippetContent = args.slice(1).join(' ');

                    snippets.set(newSnippetName, newSnippetContent);
                    saveData();

                    message.reply(`Snippet **${newSnippetName}** created!`);
                    break;

                case 'snippet-remove':
                    if (!isAdmin(message.author.id)) {
                        return message.reply('Only admins can remove snippets.');
                    }

                    if (!args.length) {
                        return message.reply('Usage: `-snippet-remove <name>`');
                    }

                    const snippetToRemove = args[0].toLowerCase();
                    if (snippets.has(snippetToRemove)) {
                        snippets.delete(snippetToRemove);
                        saveData();
                        message.reply(`Snippet **${snippetToRemove}** removed.`);
                    } else {
                        message.reply('Snippet not found.');
                    }
                    break;

                case 'snippet-list':
                    if (snippets.size === 0) {
                        return message.reply('No snippets available.');
                    }

                    const snippetList = Array.from(snippets.keys()).join(', ');
                    const snippetEmbed = new EmbedBuilder()
                        .setTitle('📝 Available Snippets')
                        .setDescription(`\`${snippetList}\``)
                        .setFooter({ text: `Use -snippet <name> to send a snippet` })
                        .setColor('#9c27b0');

                    message.reply({ embeds: [snippetEmbed] });
                    break;

                case 'schedule':
                    if (!args.length) {
                        return message.reply('Usage: `-schedule <hours>` (e.g., `-schedule 24`)');
                    }

                    const hours = parseInt(args[0]);
                    if (isNaN(hours) || hours <= 0) {
                        return message.reply('Please provide a valid number of hours.');
                    }

                    const closeTime = hours * 3600000;
                    const closureDate = new Date(Date.now() + closeTime);

                    const timeout = setTimeout(async () => {
                        await closeModmail(message.channel, client.user, 'Scheduled closure');
                    }, closeTime);

                    scheduledClosures.set(message.channel.id, timeout);

                    const scheduleEmbed = new EmbedBuilder()
                        .setTitle('⏰ Closure Scheduled')
                        .setDescription(`This ticket will automatically close in **${hours} hours** (${closureDate.toLocaleString()})`)
                        .setColor('#ff9800')
                        .setTimestamp();

                    await message.channel.send({ embeds: [scheduleEmbed] });
                    break;

                case 'cancel-schedule':
                    if (!scheduledClosures.has(message.channel.id)) {
                        return message.reply('No scheduled closure for this ticket.');
                    }

                    clearTimeout(scheduledClosures.get(message.channel.id));
                    scheduledClosures.delete(message.channel.id);

                    message.reply('Scheduled closure cancelled.');
                    break;

                case 'blacklist':
                    if (!isAdmin(message.author.id)) {
                        return message.reply('Only admins can blacklist users.');
                    }

                    const blacklistReason = args.join(' ') || 'No reason provided';
                    blacklistedUsers.add(userId);
                    saveData();

                    if (!userNotes.has(userId)) {
                        userNotes.set(userId, []);
                    }
                    userNotes.get(userId).push({
                        note: `BLACKLISTED: ${blacklistReason}`,
                        staff: message.author.tag,
                        staffId: message.author.id,
                        timestamp: Date.now(),
                        ticketNumber: sessionData.ticketNumber
                    });
                    saveData();

                    const blacklistEmbed = new EmbedBuilder()
                        .setTitle('User Blacklisted')
                        .setDescription(`User has been blacklisted from creating tickets.`)
                        .addFields({ name: 'Reason', value: blacklistReason })
                        .setColor('#ff0000')
                        .setTimestamp();

                    await message.channel.send({ embeds: [blacklistEmbed] });

                    setTimeout(async () => {
                        await closeModmail(message.channel, message.author, `User blacklisted: ${blacklistReason}`);
                    }, 3000);
                    break;

                case 'unblacklist':
                    if (!isAdmin(message.author.id)) {
                        return message.reply('Only admins can unblacklist users.');
                    }

                    if (!blacklistedUsers.has(userId)) {
                        return message.reply('User is not blacklisted.');
                    }

                    blacklistedUsers.delete(userId);
                    saveData();

                    message.reply('User has been unblacklisted and can now create tickets again.');
                    break;

                case 'stats':
                    const statsEmbed = new EmbedBuilder()
                        .setTitle('📊 Modmail Statistics')
                        .addFields(
                            { name: 'Total Tickets', value: ticketStats.total.toString(), inline: true },
                            { name: 'Closed Tickets', value: ticketStats.closed.toString(), inline: true },
                            { name: 'Open Tickets', value: modmailSessions.size.toString(), inline: true },
                            { name: 'Avg Response Time', value: ticketStats.avgResponseTime > 0 ? formatDuration(ticketStats.avgResponseTime) : 'N/A', inline: true },
                            { name: 'Avg Close Time', value: ticketStats.avgCloseTime > 0 ? formatDuration(ticketStats.avgCloseTime) : 'N/A', inline: true },
                            { name: 'Total Snippets', value: snippets.size.toString(), inline: true },
                            { name: 'Blacklisted Users', value: blacklistedUsers.size.toString(), inline: true },
                            { name: 'Users with Notes', value: userNotes.size.toString(), inline: true }
                        )
                        .setColor('#2196f3')
                        .setTimestamp()
                        .setFooter({ text: 'Statistics since bot started' });

                    message.reply({ embeds: [statsEmbed] });
                    break;

                case 'history':
                    try {
                        const user = await client.users.fetch(userId);
                        const userHistory = userNotes.get(userId) || [];
                        const ticketHistory = userHistory.filter(n => n.ticketNumber);

                        const historyEmbed = new EmbedBuilder()
                            .setTitle(`📜 Ticket History - ${user.tag}`)
                            .setDescription(`Current Ticket: #${sessionData.ticketNumber}`)
                            .setColor('#9c27b0')
                            .setTimestamp();

                        if (ticketHistory.length === 0) {
                            historyEmbed.addFields({ name: 'Previous Tickets', value: 'None' });
                        } else {
                            const uniqueTickets = [...new Set(ticketHistory.map(h => h.ticketNumber))];
                            historyEmbed.addFields({
                                name: 'Previous Tickets',
                                value: uniqueTickets.join(', ') || 'None'
                            });
                        }

                        await message.reply({ embeds: [historyEmbed] });
                    } catch (error) {
                        message.reply('Failed to fetch history.');
                    }
                    break;

                default:
                    break;
            }
        } catch (error) {
            console.error('Command error:', error);
            message.reply('An error occurred while executing that command.');
        }
    }
});

client.on('interactionCreate', async interaction => {
    try {
        if (interaction.isStringSelectMenu() && interaction.customId === 'select_category') {
            const category = interaction.values[0];
            const guild = client.guilds.cache.get(config.guildId);
            
            if (!guild) {
                return interaction.reply({ content: 'Configuration error.', ephemeral: true });
            }

            await interaction.deferReply({ ephemeral: true });

            const result = await createModmailChannel(guild, interaction.user, category);
            
            if (!result) {
                return interaction.editReply({ content: 'Failed to create ticket.' });
            }

            const session = modmailSessions.get(interaction.user.id);
            
            await interaction.editReply({ 
                content: `Ticket #${session.ticketNumber} created in **${category}** category!\n\nPlease send your message now, and our staff team will respond shortly.` 
            });
            return;
        }

        if (!interaction.isButton() && !interaction.isStringSelectMenu() && !interaction.isModalSubmit()) return;

        const session = Array.from(modmailSessions.entries())
            .find(([_, data]) => data.channelId === interaction.channel?.id);

        if (!session && interaction.customId !== 'modmail_close' && !interaction.customId.startsWith('select_')) {
            return interaction.reply({ content: 'Invalid ticket channel.', ephemeral: true }).catch(() => {});
        }

        const [userId, sessionData] = session || [null, null];

        if (interaction.isButton()) {
            switch (interaction.customId) {
                case 'modmail_close':
                    await interaction.reply({ content: 'Closing ticket...', ephemeral: true });
                    setTimeout(async () => {
                        await closeModmail(interaction.channel, interaction.user, 'Closed via button');
                    }, 2000);
                    break;

                case 'modmail_claim':
                    if (sessionData.claimed) {
                        return interaction.reply({ 
                            content: `Already claimed by ${sessionData.claimer}`, 
                            ephemeral: true 
                        });
                    }

                    sessionData.claimed = true;
                    sessionData.claimer = interaction.user.tag;
                    sessionData.claimerUserId = interaction.user.id;

                    const claimEmbed = new EmbedBuilder()
                        .setTitle('Ticket Claimed')
                        .setDescription(`${interaction.user} has claimed this ticket.`)
                        .setColor('#2196f3')
                        .setTimestamp();

                    await interaction.reply({ embeds: [claimEmbed] });
                    
                    await interaction.channel.setTopic(
                        `Ticket #${sessionData.ticketNumber} | User: ${userId} | Category: ${sessionData.category} | Priority: ${sessionData.priority} | Claimed by: ${interaction.user.tag}`
                    );
                    break;

                case 'modmail_priority':
                    const priorityRow = new ActionRowBuilder()
                        .addComponents(
                            new StringSelectMenuBuilder()
                                .setCustomId('set_priority')
                                .setPlaceholder('Select priority level')
                                .addOptions([
                                    { label: 'Low', value: 'low', emoji: '🔵' },
                                    { label: 'Normal', value: 'normal', emoji: '🟢' },
                                    { label: 'High', value: 'high', emoji: '🟠' },
                                    { label: 'Urgent', value: 'urgent', emoji: '🔴' }
                                ])
                        );

                    await interaction.reply({ 
                        content: 'Select priority level:', 
                        components: [priorityRow], 
                        ephemeral: true 
                    });
                    break;

                case 'modmail_tag':
                    const modal = new ModalBuilder()
                        .setCustomId('add_tag_modal')
                        .setTitle('Add Tag to Ticket');

                    const tagInput = new TextInputBuilder()
                        .setCustomId('tag_input')
                        .setLabel('Tag Name')
                        .setStyle(TextInputStyle.Short)
                        .setPlaceholder('e.g., billing, technical, urgent')
                        .setRequired(true)
                        .setMaxLength(50);

                    modal.addComponents(new ActionRowBuilder().addComponents(tagInput));
                    await interaction.showModal(modal);
                    break;

                case 'modmail_note':
                    const noteModal = new ModalBuilder()
                        .setCustomId('add_note_modal')
                        .setTitle('Add Note About User');

                    const noteInput = new TextInputBuilder()
                        .setCustomId('note_input')
                        .setLabel('Note')
                        .setStyle(TextInputStyle.Paragraph)
                        .setPlaceholder('Enter note about this user...')
                        .setRequired(true)
                        .setMaxLength(1000);

                    noteModal.addComponents(new ActionRowBuilder().addComponents(noteInput));
                    await interaction.showModal(noteModal);
                    break;

                case 'modmail_schedule_close':
                    const scheduleRow = new ActionRowBuilder()
                        .addComponents(
                            new StringSelectMenuBuilder()
                                .setCustomId('schedule_close_time')
                                .setPlaceholder('Select time until closure')
                                .addOptions([
                                    { label: '1 hour', value: '1' },
                                    { label: '3 hours', value: '3' },
                                    { label: '6 hours', value: '6' },
                                    { label: '12 hours', value: '12' },
                                    { label: '24 hours', value: '24' },
                                    { label: '48 hours', value: '48' }
                                ])
                        );

                    await interaction.reply({ 
                        content: 'Schedule automatic closure:', 
                        components: [scheduleRow], 
                        ephemeral: true 
                    });
                    break;

                case 'modmail_transcript':
                    await interaction.deferReply({ ephemeral: true });
                    
                    const messages = await interaction.channel.messages.fetch({ limit: 100 });
                    const transcript = messages.reverse().map(m => 
                        `[${m.createdAt.toLocaleString()}] ${m.author.tag}: ${m.content || '[Embed/Attachment]'}`
                    ).join('\n');

                    const transcriptBuffer = Buffer.from(transcript, 'utf-8');
                    await interaction.editReply({
                        content: '📄 Current transcript:',
                        files: [{
                            attachment: transcriptBuffer,
                            name: `transcript-${sessionData.ticketNumber}.txt`
                        }]
                    });
                    break;

                case 'modmail_info':
                    await interaction.deferReply({ ephemeral: true });
                    
                    try {
                        const user = await client.users.fetch(userId);
                        const member = interaction.guild.members.cache.get(userId);
                        const notes = userNotes.get(userId) || [];

                        const infoEmbed = new EmbedBuilder()
                            .setTitle('ℹ️ User Information')
                            .setThumbnail(user.displayAvatarURL({ dynamic: true }))
                            .addFields(
                                { name: 'Username', value: user.tag, inline: true },
                                { name: 'User ID', value: user.id, inline: true },
                                { name: 'Account Created', value: user.createdAt.toDateString(), inline: true },
                                { name: 'Server Member', value: member ? 'Yes' : 'No', inline: true },
                                { name: 'Ticket #', value: sessionData.ticketNumber.toString(), inline: true },
                                { name: 'Category', value: sessionData.category, inline: true },
                                { name: 'Priority', value: sessionData.priority, inline: true },
                                { name: 'Status', value: sessionData.claimed ? `Claimed by ${sessionData.claimer}` : 'Unclaimed', inline: true },
                                { name: 'Tags', value: sessionData.tags.join(', ') || 'None', inline: true },
                                { name: 'Messages', value: sessionData.messageCount.toString(), inline: true },
                                { name: 'Staff Responses', value: sessionData.staffResponses.toString(), inline: true },
                                { name: 'Notes', value: notes.length.toString(), inline: true }
                            )
                            .setColor('#9c27b0')
                            .setTimestamp();

                        await interaction.editReply({ embeds: [infoEmbed] });
                    } catch (error) {
                        await interaction.editReply({ content: '❌ Failed to fetch user info.' });
                    }
                    break;
            }
        }

        if (interaction.isStringSelectMenu() && interaction.customId === 'set_priority') {
            const priority = interaction.values[0];
            const session = Array.from(modmailSessions.entries())
                .find(([_, data]) => data.channelId === interaction.channel.id);

            if (!session) {
                return interaction.reply({ content: '❌ Invalid ticket.', ephemeral: true });
            }

            const [userId, sessionData] = session;
            sessionData.priority = priority.charAt(0).toUpperCase() + priority.slice(1);

            const priorityColors = {
                low: '#808080',
                normal: '#00ff00',
                high: '#ff9800',
                urgent: '#ff0000'
            };

            await interaction.update({ 
                content: `✅ Priority set to **${sessionData.priority}**`, 
                components: [] 
            });

            const priorityEmbed = new EmbedBuilder()
                .setTitle('Priority Updated')
                .setDescription(`${interaction.user} set priority to: **${sessionData.priority}**`)
                .setColor(priorityColors[priority])
                .setTimestamp();

            await interaction.channel.send({ embeds: [priorityEmbed] });

            await interaction.channel.setTopic(
                `Ticket #${sessionData.ticketNumber} | User: ${userId} | Category: ${sessionData.category} | Priority: ${sessionData.priority}`
            );
        }

        if (interaction.isStringSelectMenu() && interaction.customId === 'schedule_close_time') {
            const hours = parseInt(interaction.values[0]);
            const closeTime = hours * 3600000;
            const closureDate = new Date(Date.now() + closeTime);

            const timeout = setTimeout(async () => {
                await closeModmail(interaction.channel, client.user, 'Scheduled closure');
            }, closeTime);

            scheduledClosures.set(interaction.channel.id, timeout);

            await interaction.update({ 
                content: `✅ Ticket will close in **${hours} hours** (${closureDate.toLocaleString()})`, 
                components: [] 
            });

            const scheduleEmbed = new EmbedBuilder()
                .setTitle('⏰ Closure Scheduled')
                .setDescription(`${interaction.user} scheduled closure for **${closureDate.toLocaleString()}**`)
                .setColor('#ff9800')
                .setTimestamp();

            await interaction.channel.send({ embeds: [scheduleEmbed] });
        }

        if (interaction.isModalSubmit()) {
            if (interaction.customId === 'add_tag_modal') {
                const tag = interaction.fields.getTextInputValue('tag_input');
                const session = Array.from(modmailSessions.entries())
                    .find(([_, data]) => data.channelId === interaction.channel.id);

                if (!session) {
                    return interaction.reply({ content: '❌ Invalid ticket.', ephemeral: true });
                }

                const [userId, sessionData] = session;

                if (!sessionData.tags.includes(tag)) {
                    sessionData.tags.push(tag);
                    
                    await interaction.reply({ 
                        content: `✅ Added tag: **${tag}**`, 
                        ephemeral: true 
                    });

                    const tagEmbed = new EmbedBuilder()
                        .setTitle('Tag Added')
                        .setDescription(`${interaction.user} added tag: **${tag}**`)
                        .setColor('#9c27b0')
                        .setTimestamp();

                    await interaction.channel.send({ embeds: [tagEmbed] });
                } else {
                    await interaction.reply({ 
                        content: '❌ Tag already exists.', 
                        ephemeral: true 
                    });
                }
            }

            if (interaction.customId === 'add_note_modal') {
                const noteText = interaction.fields.getTextInputValue('note_input');
                const session = Array.from(modmailSessions.entries())
                    .find(([_, data]) => data.channelId === interaction.channel.id);

                if (!session) {
                    return interaction.reply({ content: '❌ Invalid ticket.', ephemeral: true });
                }

                const [userId, sessionData] = session;

                if (!userNotes.has(userId)) {
                    userNotes.set(userId, []);
                }

                userNotes.get(userId).push({
                    note: noteText,
                    staff: interaction.user.tag,
                    staffId: interaction.user.id,
                    timestamp: Date.now(),
                    ticketNumber: sessionData.ticketNumber
                });

                saveData();

                await interaction.reply({ 
                    content: '✅ Note added successfully!', 
                    ephemeral: true 
                });

                const noteEmbed = new EmbedBuilder()
                    .setTitle('📝 Note Added')
                    .setDescription(noteText)
                    .setFooter({ text: `Added by ${interaction.user.tag}` })
                    .setColor('#9c27b0')
                    .setTimestamp();

                await interaction.channel.send({ embeds: [noteEmbed] });
            }
        }

    } catch (error) {
        console.error('Interaction error:', error);
        if (!interaction.replied && !interaction.deferred) {
            await interaction.reply({ content: 'An error occurred.', ephemeral: true }).catch(() => {});
        }
    }
});

client.on('error', error => {
    console.error('Discord client error:', error);
});

process.on('unhandledRejection', error => {
    console.error('Unhandled promise rejection:', error);
});

process.on('SIGINT', () => {
    console.log('Shutting down gracefully...');
    saveData();
    client.destroy();
    process.exit(0);
});

process.on('SIGTERM', () => {
    console.log('Shutting down gracefully...');
    saveData();
    client.destroy();
    process.exit(0);
});

client.login(config.token).catch(error => {
    console.error('Failed to login:', error);
    process.exit(1);
});
