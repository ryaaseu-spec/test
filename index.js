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

// ───────────── slash commands ─────────────
const command = new SlashCommandBuilder()
  .setName(COMMAND_NAME)
  .setDescription('Join your voice channel and stay there until someone disconnects me 🎀');

// Adds OUR commands (/join-vc-allmas and /gorani) only if they are missing.
// It NEVER overwrites or deletes other commands (the Python bot uses the same app: /staff, /autorole ...).
async function registerCommands(guild) {
  try {
    const existing = await guild.commands.fetch();
    for (const cmd of [command, goraniCommand]) {
      if (!existing.some((c) => c.name === cmd.name)) {
        await guild.commands.create(cmd.toJSON());
        console.log(`[commands] added /${cmd.name} in ${guild.name}`);
      }
    }
  } catch (e) { console.error('[commands] register failed for', guild.id, e.message); }
}

// ───────────── join a voice channel and stay (24/7) ─────────────
async function joinAndHold(channel) {
  const gid = channel.guild.id;
  await releaseMusicPlayer(gid); // if /gorani (music) is connected here, let it go first

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

  // add our commands where they are missing (other commands are left alone)
  for (const guild of client.guilds.cache.values()) await registerCommands(guild);

  await autoJoin();
  console.log('[allmas] ready');
});

client.on(Events.GuildCreate, (guild) => registerCommands(guild));

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

// ═══════════════════════════════════════════════════════════════
//  /gorani — music (Lavalink + SoundCloud)            [added section]
//  Everything above works exactly as before.
// ═══════════════════════════════════════════════════════════════
const { ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const { LavalinkManager } = require('lavalink-client');

const BAR = 14;
const panels = new Map();        // guildId -> "now playing" panel message
const fallbackTried = new Set(); // YouTube track ids already retried on SoundCloud

const goraniCommand = new SlashCommandBuilder()
  .setName('gorani')
  .setDescription('Play a song by YouTube link or name 🎶')
  .addStringOption((o) => o.setName('query').setDescription('YouTube link or song name').setRequired(true));

// ───────────── helpers ─────────────
const clean = (s) => {
  if (!s) return 'Unknown';
  s = String(s).replace(/\[/g, '(').replace(/\]/g, ')');
  return s.length > 90 ? s.slice(0, 87) + '...' : s;
};

const fmt = (ms) => {
  const sec = Math.floor((ms || 0) / 1000);
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
  const p = (n) => String(n).padStart(2, '0');
  return h > 0 ? `${h}:${p(m)}:${p(s)}` : `${m}:${p(s)}`;
};

const requesterName = (t) => {
  const r = t && t.requester;
  if (!r) return 'someone';
  return typeof r === 'string' ? r : (r.displayName || r.username || 'someone');
};

function buildEmbed(player) {
  const t = player.queue.current;
  const info = t.info;
  const pos = player.position || 0;
  let bar, end;
  if (info.isStream) {
    bar = '▬'.repeat(BAR);
    end = 'LIVE';
  } else {
    const p = Math.min(BAR - 1, Math.floor((pos * BAR) / Math.max(1, info.duration)));
    bar = '▬'.repeat(p) + '🔘' + '▬'.repeat(BAR - p - 1);
    end = fmt(info.duration);
  }

  const title = info.uri
    ? `### [${clean(info.title)}](${info.uri})`
    : `### ${clean(info.title)}`;
  const loopTxt = { off: 'Off', track: 'Track 🔂', queue: 'Queue 🔁' }[player.repeatMode] || 'Off';

  const eb = new EmbedBuilder()
    .setColor(PINK)
    .setAuthor({ name: player.paused ? '⏸ Paused' : '✦ Now Playing' })
    .setDescription(`${title}\n-# ${clean(info.author)}\n\n\`${fmt(pos)}\`  ${bar}  \`${end}\``)
    .addFields(
      { name: '🔉 Volume', value: `\`${player.volume}%\``, inline: true },
      { name: '🔁 Loop', value: `\`${loopTxt}\``, inline: true },
      { name: '🎀 Queue', value: `\`${player.queue.tracks.length} next\``, inline: true },
    )
    .setFooter({ text: `♡ requested by ${requesterName(t)}` });

  if (info.artworkUrl) eb.setThumbnail(info.artworkUrl);
  const up = player.queue.tracks[0];
  if (up) eb.addFields({ name: 'Up next', value: clean(up.info.title), inline: false });
  return eb;
}

function buildRows(player) {
  const loopStyle = player.repeatMode === 'off' ? ButtonStyle.Secondary : ButtonStyle.Primary;
  const loopEmoji = player.repeatMode === 'track' ? '🔂' : '🔁';
  const btn = (id, emoji, style = ButtonStyle.Secondary) =>
    new ButtonBuilder().setCustomId(id).setEmoji(emoji).setStyle(style);
  return [
    new ActionRowBuilder().addComponents(
      btn('g:pause', player.paused ? '▶️' : '⏸️'),
      btn('g:skip', '⏭️'),
      btn('g:loop', loopEmoji, loopStyle),
      btn('g:shuffle', '🔀'),
    ),
    new ActionRowBuilder().addComponents(
      btn('g:vdown', '🔉'),
      btn('g:vup', '🔊'),
      btn('g:queue', '📜'),
      btn('g:stop', '⏹️', ButtonStyle.Danger),
    ),
  ];
}

async function sendPanel(player) {
  const channel = client.channels.cache.get(player.textChannelId);
  if (!channel || !player.queue.current) return;
  const old = panels.get(player.guildId);
  panels.delete(player.guildId);
  if (old) old.delete().catch(() => {});
  try {
    const msg = await channel.send({ embeds: [buildEmbed(player)], components: buildRows(player) });
    panels.set(player.guildId, msg);
  } catch (e) {
    console.error('[panel] send failed:', e.message);
  }
}

function refreshPanel(player) {
  const msg = panels.get(player.guildId);
  if (!msg || !player.queue.current) return;
  msg.edit({ embeds: [buildEmbed(player)], components: buildRows(player) }).catch(() => {});
}

async function tempNotice(channelId, text, seconds = 10) {
  const channel = client.channels.cache.get(channelId);
  if (!channel) return;
  try {
    const m = await channel.send({ embeds: [soft(text)] });
    setTimeout(() => m.delete().catch(() => {}), seconds * 1000);
  } catch { /* ignore */ }
}

// /join-vc-allmas calls this: let the music player leave first (one voice connection per server)
async function releaseMusicPlayer(gid) {
  const p = client.lavalink?.getPlayer(gid);
  if (!p) return;
  try { await p.destroy('switching to join-vc-allmas'); } catch { /* ignore */ }
  await wait(500);
}

// ───────────── SoundCloud search ─────────────
// Builds several cleaned-up versions of a song name (most specific -> simplest)
function scQueryVariants(title, author) {
  const auth = String(author || '').replace(/ - Topic$/i, '').replace(/VEVO$/i, '').trim();
  const squash = (s) => s.replace(/\s+/g, ' ').trim();
  const ascii = (s) => squash(s.replace(/[^\x20-\x7E]/g, ' '));
  const base = squash(
    String(title || '')
      .replace(/[\p{Extended_Pictographic}\uFE0F\u200D]/gu, ' ')
      .replace(/\/\/.*$/, ' ')                 // drop everything after "//"
      .replace(/official\s*(music\s*)?(video|audio)|lyrics?|video\s*clip|\bhd\b|\b4k\b/gi, ' ')
      .replace(/[^\p{L}\p{N}\s'&-]/gu, ' ')    // drop symbols: + ( ) [ ] | ? ! etc.
  );
  const noise = /\b(super\s*)?(slowed|sped\s*up|reverb|nightcore|8d|bass\s*boosted|edit)\b/gi;
  const noNoise = squash(base.replace(noise, ' '));
  const withAuthor = (s) =>
    (auth && !s.includes(' - ') && !s.toLowerCase().includes(auth.toLowerCase())) ? `${s} ${auth}` : s;

  return [...new Set([withAuthor(base), noNoise, ascii(noNoise)])].filter((s) => s.length >= 3);
}

// Tries each variant on SoundCloud, returns the first track found (or null)
async function searchSoundCloud(player, title, author, requester) {
  for (const v of scQueryVariants(title, author)) {
    try {
      const res = await player.search({ query: v, source: 'scsearch' }, requester);
      const n = res?.tracks?.length || 0;
      console.log(`[soundcloud] "${v}" -> ${res?.loadType} (${n} results)` +
        (res?.exception?.message ? ` | ${res.exception.message}` : ''));
      if (n && res.loadType !== 'error') return res.tracks[0];
    } catch (e) {
      console.error(`[soundcloud] "${v}" failed:`, e.message);
    }
  }
  return null;
}

async function findTrack(player, query, requester) {
  const isUrl = /^https?:\/\//i.test(query);
  const isYouTube = /^https?:\/\/((www|m|music)\.)?(youtube\.com|youtu\.be)\//i.test(query);

  const pick = (res) => {
    if (!res || !res.tracks || !res.tracks.length || res.loadType === 'error') return null;
    return res.loadType === 'playlist'
      ? (res.tracks[res.pluginInfo?.selectedTrack ?? 0] || res.tracks[0])
      : res.tracks[0];
  };

  // 1) YouTube link -> read the title from YouTube, then play the same song from SoundCloud
  if (isYouTube) {
    let yt = null;
    try { yt = pick(await player.search({ query }, requester)); }
    catch (e) { console.error('[search] youtube link failed:', e.message); }
    if (!yt) return null;

    const sc = await searchSoundCloud(player, yt.info.title, yt.info.author, requester);
    if (sc) return sc;
    return yt; // not on SoundCloud -> the YouTube track (may fail, trackError handles it)
  }

  // 2) other links (SoundCloud, etc.) -> play as is
  if (isUrl) {
    try { return pick(await player.search({ query }, requester)); }
    catch (e) { console.error('[search] link failed:', e.message); return null; }
  }

  // 3) plain text -> SoundCloud first, YouTube as backup
  const sc = await searchSoundCloud(player, query, '', requester);
  if (sc) return sc;
  try { return pick(await player.search({ query, source: 'ytsearch' }, requester)); }
  catch (e) { console.error('[search] ytsearch failed:', e.message); return null; }
}

// ───────────── /gorani ─────────────
async function handleGorani(i) {
  if (i.commandName !== 'gorani' || !i.guild) return;

  const vc = i.member?.voice?.channel;
  if (!vc) {
    return i.reply({ embeds: [soft('Join a voice channel first, then use `/gorani` ♡')], flags: MessageFlags.Ephemeral });
  }
  if (!client.lavalink || !client.lavalink.nodeManager.nodes.size ||
      ![...client.lavalink.nodeManager.nodes.values()].some((n) => n.connected)) {
    return i.reply({ embeds: [soft('⚠️ Music server is not connected yet, try again in a few seconds.')], flags: MessageFlags.Ephemeral });
  }

  await i.deferReply();
  const query = i.options.getString('query', true).trim();
  const requester = i.member.displayName || i.user.username;

  // one voice connection per server: if /join-vc-allmas is holding the channel, let it go first
  const held = getVoiceConnection(i.guild.id);
  if (held) {
    try { held.destroy(); } catch { /* ignore */ }
    await wait(500);
  }

  let player = client.lavalink.getPlayer(i.guild.id);
  if (player && player.connected && player.voiceChannelId !== vc.id && !player.playing) {
    await player.destroy().catch(() => {});
    player = null;
  }
  if (!player) {
    player = client.lavalink.createPlayer({
      guildId: i.guild.id,
      voiceChannelId: vc.id,
      textChannelId: i.channelId,
      selfDeaf: true,
      selfMute: false,
      volume: 80,
      vcRegion: vc.rtcRegion || undefined,
    });
  }
  player.textChannelId = i.channelId;
  if (!player.connected) await player.connect();

  const track = await findTrack(player, query, requester);
  if (!track) {
    return i.editReply({ embeds: [soft('⚠️ I couldn\'t find that song.')] });
  }

  const startedNow = !player.playing && !player.queue.current;
  await player.queue.add(track);
  if (!player.playing) await player.play();

  const title = clean(track.info.title);
  const msg = startedNow ? `✦ Loading **${title}** …` : `🎀 Added to queue: **${title}**`;
  await i.editReply({ embeds: [soft(msg)] });
  setTimeout(() => i.deleteReply().catch(() => {}), 8000);
}

async function handleGoraniButton(i) {
  if (!i.customId.startsWith('g:') || !i.guild) return;

  const player = client.lavalink?.getPlayer(i.guild.id);
  if (!player || !player.queue.current) {
    return i.reply({ embeds: [soft('Nothing is playing right now ♡')], flags: MessageFlags.Ephemeral });
  }
  if (!i.member?.voice?.channelId || i.member.voice.channelId !== player.voiceChannelId) {
    return i.reply({ embeds: [soft('Please join my voice channel first ♡')], flags: MessageFlags.Ephemeral });
  }

  const update = () => i.update({ embeds: [buildEmbed(player)], components: buildRows(player) });

  switch (i.customId) {
    case 'g:pause':
      if (player.paused) await player.resume(); else await player.pause();
      return update();
    case 'g:loop': {
      const next = { off: 'track', track: 'queue', queue: 'off' }[player.repeatMode] || 'off';
      await player.setRepeatMode(next);
      return update();
    }
    case 'g:shuffle':
      await player.queue.shuffle();
      return update();
    case 'g:vdown':
      await player.setVolume(Math.max(10, player.volume - 10));
      return update();
    case 'g:vup':
      await player.setVolume(Math.min(150, player.volume + 10));
      return update();
    case 'g:skip':
      await i.deferUpdate();
      if (player.paused) await player.resume().catch(() => {});
      try { await player.skip(0, false); } catch (e) { console.error('[skip]', e.message); }
      return;
    case 'g:stop': {
      // stop the music and clear the queue, but STAY in the voice channel
      await i.deferUpdate();
      try {
        await player.stopPlaying(true, false);
        const panel = panels.get(player.guildId);
        if (panel) {
          panel.edit({
            embeds: [soft('⏹ Stopped — I\'m staying in voice, use `/gorani` to play more ♡')],
            components: [],
          }).catch(() => {});
        }
      } catch (e) {
        console.error('[stop]', e.message);
        await player.destroy('stopped by user').catch(() => {});
      }
      return;
    }
    case 'g:queue': {
      const q = player.queue.tracks;
      let text = q.length ? '' : 'The queue is empty ♡';
      q.slice(0, 10).forEach((t, n) => {
        text += `\`${n + 1}.\` ${clean(t.info.title)} — \`${fmt(t.info.duration)}\`\n`;
      });
      if (q.length > 10) text += `… and ${q.length - 10} more`;
      return i.reply({
        embeds: [new EmbedBuilder().setColor(PINK).setAuthor({ name: '✦ Queue' }).setDescription(text)],
        flags: MessageFlags.Ephemeral,
      });
    }
    default:
      return i.deferUpdate();
  }
}

// ───────────── music startup (a failure here never affects /join-vc-allmas) ─────────────
client.once(Events.ClientReady, async () => {
  try {
    client.lavalink = new LavalinkManager({
      nodes: [{
        id: 'main',
        host: process.env.LAVALINK_HOST || 'localhost',
        port: Number(process.env.LAVALINK_PORT || 2333),
        authorization: process.env.LAVALINK_PASSWORD || 'youshallnotpass',
        secure: process.env.LAVALINK_SECURE === 'true',
        retryAmount: 100,
        retryDelay: 5000,
      }],
      sendToShard: (guildId, payload) => client.guilds.cache.get(guildId)?.shard?.send(payload),
      client: { id: client.user.id, username: client.user.username },
      autoSkip: true,
      playerOptions: {
        defaultSearchPlatform: 'ytsearch',
        volumeDecrementer: 1,
        // no "destroyAfterMs" on purpose: the bot stays in voice until someone disconnects it
        onDisconnect: { autoReconnect: false, destroyPlayer: true },
      },
    });

    const nm = client.lavalink.nodeManager;
    nm.on('connect', (node) => console.log(`[lavalink] node "${node.id}" connected`));
    nm.on('disconnect', (node, reason) => console.warn(`[lavalink] node "${node.id}" disconnected`, reason?.reason || ''));
    nm.on('error', (node, err) => console.error(`[lavalink] node "${node.id}" error:`, err?.message || err));

    client.lavalink.on('trackStart', (player) => sendPanel(player));

    client.lavalink.on('queueEnd', (player) => {
      const msg = panels.get(player.guildId);
      if (msg) {
        msg.edit({ embeds: [soft('✦ The queue has ended — use `/gorani` to play more ♡')], components: [] }).catch(() => {});
      }
    });

    client.lavalink.on('playerDestroy', (player) => {
      const msg = panels.get(player.guildId);
      if (msg) { msg.delete().catch(() => {}); panels.delete(player.guildId); }
    });

    client.lavalink.on('playerSocketClosed', (player, payload) => {
      console.warn(`[voice] socket closed for guild ${player.guildId}: code ${payload?.code} ${payload?.reason || ''}`);
    });

    // YouTube blocked the track -> look for the same song on SoundCloud
    client.lavalink.on('trackError', async (player, track, payload) => {
      console.warn('[track] error:', track?.info?.title, payload?.exception?.message || '');
      if (!track) return;
      const title = clean(track.info.title);

      if (track.info.sourceName === 'youtube' && !fallbackTried.has(track.info.identifier)) {
        fallbackTried.add(track.info.identifier);
        setTimeout(() => fallbackTried.delete(track.info.identifier), 60000); // allow retry later
        tempNotice(player.textChannelId, `⚠️ YouTube blocked **${title}**, trying SoundCloud…`);
        try {
          const alt = await searchSoundCloud(player, track.info.title, track.info.author, track.requester);
          if (alt) {
            await player.queue.splice(0, 0, alt);
            if (!player.playing) await player.play();
            return;
          }
        } catch (e) {
          console.error('[fallback] soundcloud search failed:', e.message);
        }
        tempNotice(player.textChannelId, `⚠️ Couldn't find **${title}** on SoundCloud either.`);
        return;
      }
      tempNotice(player.textChannelId, `⚠️ Couldn't play **${title}**, skipping…`);
    });

    client.lavalink.on('trackStuck', (player, track) => {
      console.warn('[track] stuck:', track?.info?.title);
    });

    await client.lavalink.init({ id: client.user.id, username: client.user.username });

    // keep the progress bar fresh
    setInterval(() => {
      for (const player of client.lavalink.players.values()) {
        if (player.playing && !player.paused) refreshPanel(player);
      }
    }, 10000);

    // the Python bot may re-sync its commands later, so re-check ours every 5 minutes
    setInterval(() => {
      for (const guild of client.guilds.cache.values()) registerCommands(guild);
    }, 5 * 60 * 1000);

    console.log('[gorani] music ready');
  } catch (e) {
    console.error('[gorani] music setup failed (join-vc-allmas still works):', e);
  }
});

// forward Discord voice packets to Lavalink
client.on(Events.Raw, (d) => client.lavalink?.sendRawData(d));

client.on(Events.InteractionCreate, async (i) => {
  try {
    if (i.isChatInputCommand()) await handleGorani(i);
    else if (i.isButton()) await handleGoraniButton(i);
  } catch (e) {
    console.error('[gorani] interaction error:', e);
    try {
      const payload = { embeds: [soft('⚠️ Something went wrong.')], flags: MessageFlags.Ephemeral };
      if (i.deferred || i.replied) await i.followUp(payload); else await i.reply(payload);
    } catch { /* ignore */ }
  }
});

client.login(token);
