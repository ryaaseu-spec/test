'use strict';

const {
  Client, GatewayIntentBits, Events, EmbedBuilder, SlashCommandBuilder,
  MessageFlags, PermissionFlagsBits,
} = require('discord.js');
const {
  joinVoiceChannel, entersState, getVoiceConnection, generateDependencyReport,
  VoiceConnectionStatus, VoiceConnectionDisconnectReason,
} = require('@discordjs/voice');

const PINK = 0xf6c9e3;
const COMMAND_NAME = 'join-vc-allmas'; // Discord only allows lowercase letters in command names

const token = process.env.DISCORD_TOKEN;
if (!token) {
  console.error('DISCORD_TOKEN variable is missing!');
  process.exit(1);
}

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates],
});

process.on('unhandledRejection', (e) => console.error('[unhandledRejection]', e));
process.on('uncaughtException', (e) => console.error('[uncaughtException]', e));

const soft = (text) => new EmbedBuilder().setColor(PINK).setDescription(text);
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// ───────────── the only slash command ─────────────
const command = new SlashCommandBuilder()
  .setName(COMMAND_NAME)
  .setDescription('Join your voice channel and stay there until someone disconnects me 🎀');

// Adds OUR command only if it is missing.
// IMPORTANT: this never overwrites or deletes other commands (the Python bot with the same
// token has its own slash commands: /staff, /autorole, ...), so we only create ours.
async function ensureCommand(guild) {
  try {
    const existing = await guild.commands.fetch();
    if (!existing.some((c) => c.name === COMMAND_NAME)) {
      await guild.commands.create(command.toJSON());
      console.log(`[commands] added /${COMMAND_NAME} in ${guild.name}`);
    }
  } catch (e) {
    console.error('[commands] ensure failed for', guild.id, e.message);
  }
}

// ───────────── join a voice channel and stay (24/7) ─────────────
async function joinAndHold(channel) {
  const gid = channel.guild.id;

  const old = getVoiceConnection(gid);
  if (old) { try { old.destroy(); } catch { /* ignore */ } }

  const connection = joinVoiceChannel({
    channelId: channel.id,
    guildId: gid,
    adapterCreator: channel.guild.voiceAdapterCreator,
    selfDeaf: true,
    selfMute: false,
  });

  connection.on('stateChange', (o, n) => console.log(`[voice:${gid}] ${o.status} -> ${n.status}`));
  connection.on('error', (e) => console.error(`[voice:${gid}] error:`, e.message));

  connection.on(VoiceConnectionStatus.Disconnected, async (_old, now) => {
    try {
      if (now.reason === VoiceConnectionDisconnectReason.WebSocketClose && now.closeCode === 4014) {
        // someone disconnected the bot (or moved it). Wait a moment: if it was only a move,
        // the library reconnects by itself. If not, this throws and we leave for good.
        await Promise.race([
          entersState(connection, VoiceConnectionStatus.Signalling, 5_000),
          entersState(connection, VoiceConnectionStatus.Connecting, 5_000),
        ]);
      } else if (connection.rejoinAttempts < 5) {
        // network problem / voice server change -> come back to the same channel
        await wait((connection.rejoinAttempts + 1) * 5_000);
        connection.rejoin();
      } else {
        connection.destroy();
      }
    } catch {
      if (connection.state.status !== VoiceConnectionStatus.Destroyed) connection.destroy();
    }
  });

  try {
    await entersState(connection, VoiceConnectionStatus.Ready, 20_000);
  } catch (e) {
    if (connection.state.status !== VoiceConnectionStatus.Destroyed) connection.destroy();
    throw e;
  }
  return connection;
}

// ───────────── slash command handler ─────────────
async function handleSlash(i) {
  if (i.commandName !== COMMAND_NAME) return;

  // answer Discord immediately (it only waits 3 seconds)
  await i.deferReply({ flags: MessageFlags.Ephemeral });

  if (!i.guild) {
    return i.editReply({ embeds: [soft('Use this command inside a server ♡')] });
  }

  const vc = i.member?.voice?.channel;
  if (!vc) {
    return i.editReply({ embeds: [soft('Join a voice channel first, then use `/join-vc-allmas` ♡')] });
  }

  const me = i.guild.members.me;
  if (!vc.joinable || !vc.permissionsFor(me)?.has(PermissionFlagsBits.Connect)) {
    return i.editReply({ embeds: [soft('⚠️ I don\'t have permission to join that voice channel.')] });
  }

  const existing = getVoiceConnection(i.guild.id);
  if (existing && existing.joinConfig.channelId === vc.id &&
      existing.state.status === VoiceConnectionStatus.Ready) {
    return i.editReply({ embeds: [soft(`I'm already in **${vc.name}** ♡`)] });
  }

  try {
    await joinAndHold(vc);
    console.log(`[join] guild=${i.guild.id} channel=${vc.id} (${vc.name})`);
    await i.editReply({
      embeds: [soft(`✦ Joined **${vc.name}** — I'll stay here until someone disconnects me ♡`)],
    });
  } catch (e) {
    console.error('[join] failed:', e.message);
    await i.editReply({ embeds: [soft(`⚠️ I couldn't join the voice channel (${e.message}).`)] });
  }
}

// optional: AUTO_JOIN="guildId:channelId,guildId:channelId" -> rejoin after a restart
async function autoJoin() {
  const raw = process.env.AUTO_JOIN || '';
  for (const pair of raw.split(',').map((s) => s.trim()).filter(Boolean)) {
    const [guildId, channelId] = pair.split(':');
    try {
      const guild = client.guilds.cache.get(guildId) || await client.guilds.fetch(guildId);
      const channel = guild.channels.cache.get(channelId) || await guild.channels.fetch(channelId);
      await joinAndHold(channel);
      console.log(`[auto-join] joined ${channel.name} in ${guild.name}`);
    } catch (e) {
      console.error('[auto-join] failed for', pair, e.message);
    }
  }
}

// ───────────── start ─────────────
client.once(Events.ClientReady, async () => {
  console.log(`[allmas] logged in as ${client.user.tag}`);
  console.log(generateDependencyReport());

  // add /join-vc-allmas where it is missing (never touches other commands)
  for (const guild of client.guilds.cache.values()) await ensureCommand(guild);
  // the other bot may re-sync its commands later, so re-check every 5 minutes
  setInterval(() => {
    for (const guild of client.guilds.cache.values()) ensureCommand(guild);
  }, 5 * 60 * 1000);

  await autoJoin();
  console.log('[allmas] ready');
});

client.on(Events.GuildCreate, (guild) => ensureCommand(guild));

client.on(Events.InteractionCreate, async (i) => {
  try {
    if (i.isChatInputCommand()) await handleSlash(i);
  } catch (e) {
    console.error('[interaction] error:', e);
    try {
      const payload = { embeds: [soft('⚠️ Something went wrong.')], flags: MessageFlags.Ephemeral };
      if (i.deferred || i.replied) await i.editReply({ embeds: payload.embeds });
      else await i.reply(payload);
    } catch { /* ignore */ }
  }
});

client.login(token);
