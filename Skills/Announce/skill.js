const path = require('path');
const { MessageFlags, PermissionFlagsBits, ActionRowBuilder, StringSelectMenuBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const t = require('../../src/strings')(__dirname);
const opt = key => t(`options.${key}`);

// customIds; the core routes "<Skill>:..." to this skill
const STOP_MENU = `${path.basename(__dirname)}:stop`;
const DELETE_BUTTON = `${path.basename(__dirname)}:delete:`; // + job id
const MIN_REPEAT = 300; // minutes
const MAX_REPEAT = 31 * 24 * 60; // minutes
const USER_MAX = 2; // per member without Manage Server
const SERVER_MAX = 25; // also the most a select menu can list
const SPAM_WINDOW = 3; // skip a repeat if one of our posts is in the channel's last N messages
const RETRY_MS = 60 * 1000;
const MAX_RETRIES = 10; // one-off announcements give up after this many failed posts
const UNKNOWN_CHANNEL = 10003;
const IMAGE = /^https?:\/\/\S+\.(png|jpe?g|gif|webp)(\?\S*)?$/i;
const MENTIONS = /@everyone|@here|<@[!&]?\d+>/g;

const isAdmin = interaction => interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild);
const ephemeral = (interaction, content) => interaction.reply({ content, flags: MessageFlags.Ephemeral });
const cut = (text, max) => (text.length > max ? text.slice(0, max - 1) + '…' : text);

function duration(minutes) {
  if (minutes < 60) return t('minutes', { n: Math.max(1, Math.round(minutes)) });
  if (minutes < 48 * 60) return t('hours', { n: +(minutes / 60).toFixed(1) });
  return t('days', { n: +(minutes / 1440).toFixed(1) });
}

function stopLabel(data) {
  const minutes = (data.nextAt - Date.now()) / 60000;
  return cut(t('stop_label', {
    username: data.username,
    next: minutes < 1 ? t('next_now') : t('next_in', { time: duration(minutes) }),
    repeat: data.repeat ? t('repeat_every', { interval: duration(data.repeat) }) : t('repeat_once'),
    message: data.message,
  }), 100);
}

function post(data) {
  const color = parseInt(t('color').replace('#', ''), 16);
  if (data.image) return { embeds: [{ color, image: { url: data.message } }] };
  const mentions = (data.message.match(MENTIONS) || []).join(' ');
  return {
    content: t('text_intro', { username: data.username, mentions }).trim(),
    embeds: [{ color, description: data.message }],
    allowedMentions: { parse: ['everyone', 'users', 'roles'] },
  };
}

async function announce(interaction, ctx) {
  const message = interaction.options.getString(opt('message'), true).trim();
  const delay = interaction.options.getInteger(opt('delay')) ?? 0;
  const repeat = interaction.options.getInteger(opt('repeat')) ?? 0;
  const image = IMAGE.test(message);
  const admin = isAdmin(interaction);

  if (repeat && (repeat < MIN_REPEAT || repeat > MAX_REPEAT)) return ephemeral(interaction, t('bad_repeat', { min: MIN_REPEAT, max: MAX_REPEAT }));
  if (repeat && !admin) return ephemeral(interaction, t('need_admin_repeat'));
  if (image && !admin) return ephemeral(interaction, t('need_admin_image'));
  if (ctx.jobs.length >= SERVER_MAX) return ephemeral(interaction, t('server_limit', { max: SERVER_MAX }));
  if (!admin && ctx.jobs.filter(j => j.data.userId === interaction.user.id).length >= USER_MAX) {
    return ephemeral(interaction, t('user_limit', { max: USER_MAX }));
  }

  const nextAt = Date.now() + delay * 60000;
  const data = {
    channelId: interaction.channelId,
    userId: interaction.user.id,
    username: interaction.member?.displayName ?? interaction.user.username,
    message,
    image,
    repeat,
    nextAt,
    postIds: [],
  };
  const id = ctx.add(data);

  // Confirmation with a preview of the post and a button to delete it again.
  const scheduled = t('scheduled', {
    when: delay ? t('scheduled_later', { time: Math.floor(nextAt / 1000) }) : t('scheduled_now'),
    repeat: repeat ? t('scheduled_repeat', { interval: duration(repeat) }) : t('scheduled_once'),
  });
  const preview = post(data);
  const button = new ButtonBuilder().setCustomId(DELETE_BUTTON + id).setLabel(t('delete_button')).setStyle(ButtonStyle.Danger);
  try {
    await interaction.reply({
      content: cut([scheduled, t('preview'), preview.content].filter(Boolean).join('\n'), 2000),
      embeds: preview.embeds,
      components: [new ActionRowBuilder().addComponents(button)],
      allowedMentions: { parse: [] },
      flags: MessageFlags.Ephemeral,
    });
  } catch (err) {
    ctx.remove(id);
    throw err;
  }
}

async function showStopMenu(interaction, ctx) {
  const admin = isAdmin(interaction);
  const visible = ctx.jobs.filter(j => admin || j.data.userId === interaction.user.id);
  if (!visible.length) return ephemeral(interaction, t('nothing_to_stop'));

  const menu = new StringSelectMenuBuilder()
    .setCustomId(STOP_MENU)
    .setPlaceholder(t('pick_placeholder'))
    .addOptions(visible.slice(0, SERVER_MAX).map(j => ({ label: stopLabel(j.data), value: j.id })));
  await interaction.reply({ content: t('pick_to_stop'), components: [new ActionRowBuilder().addComponents(menu)], flags: MessageFlags.Ephemeral });
}

// Stops a job chosen from the /stop-announce menu or with the Delete button.
async function stop(interaction, ctx, id) {
  const job = ctx.jobs.find(j => j.id === id);
  let content;
  if (!job) content = t('already_gone');
  else if (!isAdmin(interaction) && job.data.userId !== interaction.user.id) content = t('not_allowed');
  else {
    ctx.remove(job.id);
    content = cut(t('stopped', { message: job.data.message }), 2000);
  }
  await interaction.update({ content, embeds: [], components: [], allowedMentions: { parse: [] } });
}

module.exports = {
  commands: [
    {
      name: t('command'),
      description: t('description'),
      options: [
        { name: opt('message'), description: opt('message_description'), type: 3, required: true, max_length: 2000 },
        { name: opt('delay'), description: opt('delay_description'), type: 4, min_value: 0 },
        { name: opt('repeat'), description: opt('repeat_description'), type: 4, min_value: 0, max_value: MAX_REPEAT },
      ],
    },
    { name: t('stop_command'), description: t('stop_description') },
  ],

  async handle(interaction, ctx) {
    if (interaction.isChatInputCommand()) {
      return interaction.commandName === t('command') ? announce(interaction, ctx) : showStopMenu(interaction, ctx);
    }
    if (interaction.customId === STOP_MENU) return stop(interaction, ctx, interaction.values[0]);
    if (interaction.customId.startsWith(DELETE_BUTTON)) return stop(interaction, ctx, interaction.customId.slice(DELETE_BUTTON.length));
  },

  async run(data, client) {
    const now = Date.now();
    if (now < data.nextAt) return false;

    try {
      const channel = await client.channels.fetch(data.channelId);
      // Anti-spam: skip a repeat if one of its earlier posts is still among the last few messages.
      const recent = data.postIds.length ? await channel.messages.fetch({ limit: SPAM_WINDOW }) : null;
      if (!recent?.some(m => data.postIds.includes(m.id))) {
        const msg = await channel.send(post(data));
        data.postIds = [...data.postIds, msg.id].slice(-SPAM_WINDOW);
      }
    } catch (err) {
      if (err.code === UNKNOWN_CHANNEL) return true;
      console.error(`Announce: posting in channel ${data.channelId} failed: ${err.message}`);
      // One-offs retry a few times; repeats just wait for their next slot.
      if (!data.repeat) {
        data.retries = (data.retries ?? 0) + 1;
        data.nextAt = now + RETRY_MS;
        return data.retries >= MAX_RETRIES;
      }
    }

    if (!data.repeat) return true;
    // Stay on the original schedule; missed slots are skipped, not caught up.
    while (data.nextAt <= now) data.nextAt += data.repeat * 60000;
    return false;
  },
};
