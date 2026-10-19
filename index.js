'use strict';

const {
  Client, GatewayIntentBits, Events, EmbedBuilder,
  ActionRowBuilder, ButtonBuilder, ButtonStyle, SlashCommandBuilder,
} = require('discord.js');
const { LavalinkManager } = require('lavalink-client');

const PINK = 0xf6c9e3;
const BAR = 14;

const token = process.env.DISCORD_TOKEN;
if (!token) {
  console.error('DISCORD_TOKEN variable is missing!');
  process.exit(1);
}

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates],
});

const panels = new Map();        // guildId -> panel Message
const fallbackTried = new Set(); // YouTube track ids already retried on SoundCloud

process.on('unhandledRejection', (e) => console.error('[unhandledRejection]', e));

// ───────────── helpers ─────────────
const soft = (text) => new EmbedBuilder().setColor(PINK).setDescription(text);

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

// ───────────── search with SoundCloud fallback ─────────────
async function findTrack(player, query, requester) {
  const isUrl = /^https?:\/\//i.test(query);
  const tries = isUrl
    ? [{ query }]
    : [{ query, source: 'spsearch' }, { query, source: 'scsearch' }, { query, source: 'ytsearch' }];

  for (const q of tries) {
    try {
      const res = await player.search(q, requester);
      if (res && res.tracks && res.tracks.length && res.loadType !== 'error') {
        const picked = res.loadType === 'playlist'
          ? (res.tracks[res.pluginInfo?.selectedTrack ?? 0] || res.tracks[0])
          : res.tracks[0];
        return picked;
      }
    } catch (e) {
      console.error('[search] failed for', JSON.stringify(q), e.message);
    }
  }
  return null;
}

// ───────────── commands ─────────────
const command = new SlashCommandBuilder()
  .setName('gorani')
  .setDescription('Play a song by YouTube link or name 🎶')
  .addStringOption((o) => o.setName('query').setDescription('YouTube link or song name').setRequired(true));

async function registerCommands(guild) {
  try { await guild.commands.create(command.toJSON()); }
  catch (e) { console.error('[commands] register failed for', guild.id, e.message); }
}

async function handleSlash(i) {
  if (i.commandName !== 'gorani' || !i.guild) return;

  const vc = i.member?.voice?.channel;
  if (!vc) {
    return i.reply({ embeds: [soft('Join a voice channel first, then use `/gorani` ♡')], ephemeral: true });
  }
  if (!client.lavalink.nodeManager.nodes.size ||
      ![...client.lavalink.nodeManager.nodes.values()].some((n) => n.connected)) {
    return i.reply({ embeds: [soft('⚠️ Music server is not connected yet, try again in a few seconds.')], ephemeral: true });
  }

  await i.deferReply();
  const query = i.options.getString('query', true).trim();
  const requester = i.member.displayName || i.user.username;

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

async function handleButton(i) {
  if (!i.customId.startsWith('g:') || !i.guild) return;

  const player = client.lavalink.getPlayer(i.guild.id);
  if (!player || !player.queue.current) {
    return i.reply({ embeds: [soft('Nothing is playing right now ♡')], ephemeral: true });
  }
  if (!i.member?.voice?.channelId || i.member.voice.channelId !== player.voiceChannelId) {
    return i.reply({ embeds: [soft('Please join my voice channel first ♡')], ephemeral: true });
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
    case 'g:stop':
      await i.deferUpdate();
      await player.destroy('stopped by user').catch(() => {});
      return;
    case 'g:queue': {
      const q = player.queue.tracks;
      let text = q.length ? '' : 'The queue is empty ♡';
      q.slice(0, 10).forEach((t, n) => {
        text += `\`${n + 1}.\` ${clean(t.info.title)} — \`${fmt(t.info.duration)}\`\n`;
      });
      if (q.length > 10) text += `… and ${q.length - 10} more`;
      return i.reply({
        embeds: [new EmbedBuilder().setColor(PINK).setAuthor({ name: '✦ Queue' }).setDescription(text)],
        ephemeral: true,
      });
    }
    default:
      return i.deferUpdate();
  }
}

// ───────────── ready ─────────────
client.once(Events.ClientReady, async () => {
  console.log(`[gorani] logged in as ${client.user.tag}`);

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

  // Discord closed the voice websocket (useful to debug "no sound" problems)
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
      tempNotice(player.textChannelId, `⚠️ YouTube blocked **${title}**, trying SoundCloud…`);
      try {
        const author = (track.info.author || '').replace(/ - Topic$/, '');
        const res = await player.search({ query: `${track.info.title} ${author}`.trim(), source: 'scsearch' }, track.requester);
        const alt = res?.tracks?.[0];
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

  for (const guild of client.guilds.cache.values()) registerCommands(guild);

  // keep the progress bar fresh
  setInterval(() => {
    for (const player of client.lavalink.players.values()) {
      if (player.playing && !player.paused) refreshPanel(player);
    }
  }, 10000);
});

client.on(Events.GuildCreate, registerCommands);

// forward Discord voice packets to Lavalink
client.on(Events.Raw, (d) => client.lavalink?.sendRawData(d));

client.on(Events.InteractionCreate, async (i) => {
  try {
    if (i.isChatInputCommand()) await handleSlash(i);
    else if (i.isButton()) await handleButton(i);
  } catch (e) {
    console.error('[interaction] error:', e);
    try {
      const payload = { embeds: [soft('⚠️ Something went wrong.')], ephemeral: true };
      if (i.deferred || i.replied) await i.followUp(payload); else await i.reply(payload);
    } catch { /* ignore */ }
  }
});

client.login(token);
