const { MessageFlags } = require('discord.js');
const t = require('../../strings')(__dirname);
const opt = key => t(`options.${key}`);

const DEFAULT_DAYS = 3;
const DEFAULT_TIME = '17:00';
const DEFAULT_DAY_OFFSET = 1;
const POLL_HOURS = 24;
const CHECK_SECONDS = 15; // how often to check the messages still exist / the poll has closed
const FINALIZE_WAIT_MS = 5 * 60 * 1000; // max wait for Discord to finalize results after closing
const WEEKEND = [5, 6, 0]; // Fri, Sat, Sun win ties
const UNKNOWN_MESSAGE = 10008;
const UNKNOWN_CHANNEL = 10003;

const lastCheck = {}; // pollId -> timestamp, in memory only
const starting = new Set(); // guilds where a vote is being created right now

const london = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/London', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
const pad = n => String(n).padStart(2, '0');

function optionText(time) {
  const d = new Date(time * 1000);
  return t('poll_option', {
    weekday: t.get('weekdays')[d.getUTCDay()],
    day: d.getUTCDate(),
    month: t.get('months')[d.getUTCMonth()],
    utc: `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`,
    london: london.format(d),
  });
}

function link(guildId, data) {
  return `https://discord.com/channels/${guildId}/${data.channelId}/${data.pollId}`;
}

async function fetchMessage(channel, id) {
  return channel.messages.fetch({ message: id, force: true }).catch(err => {
    if (err.code === UNKNOWN_MESSAGE) return null;
    throw err;
  });
}

module.exports = {
  command: {
    name: t('command'),
    description: t('description'),
    options: [
      { name: opt('days'), description: opt('days_description'), type: 4, min_value: 1, max_value: t.get('emojis').length },
      { name: opt('time'), description: opt('time_description'), type: 3 },
      { name: opt('name'), description: opt('name_description'), type: 3, max_length: 300 },
      { name: opt('message'), description: opt('message_description'), type: 3, max_length: 1000 },
      { name: opt('dayoffset'), description: opt('dayoffset_description'), type: 4, min_value: 0, max_value: 30 },
    ],
  },

  async create(interaction, existing) {
    const ephemeral = content => interaction.reply({ content, flags: MessageFlags.Ephemeral });

    // Only one vote per server.
    if (existing.length || starting.has(interaction.guildId)) {
      const vote = existing[0];
      const closes = Math.floor((vote ? vote.endsAt : Date.now() + POLL_HOURS * 3600 * 1000) / 1000);
      await ephemeral(t('already_running', { link: vote ? link(interaction.guildId, vote) : '', closes }));
      return null;
    }

    const days = interaction.options.getInteger(opt('days')) ?? DEFAULT_DAYS;
    const time = interaction.options.getString(opt('time')) ?? DEFAULT_TIME;
    const name = interaction.options.getString(opt('name')) ?? t('defaults.name');
    const message = interaction.options.getString(opt('message')) ?? t('defaults.message');
    const dayOffset = interaction.options.getInteger(opt('dayoffset')) ?? DEFAULT_DAY_OFFSET;

    const match = /^([01]?\d|2[0-3]):([0-5]\d)$/.exec(time);
    if (!match) {
      await ephemeral(t('bad_time', { time }));
      return null;
    }

    const now = new Date();
    const times = [];
    for (let i = 0; i < days; i++) {
      times.push(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + dayOffset + i, +match[1], +match[2]) / 1000);
    }
    const emojis = t.get('emojis');

    starting.add(interaction.guildId);
    try {
      await interaction.reply({
        poll: {
          question: { text: name },
          answers: times.map((time, i) => ({ text: optionText(time), emoji: emojis[i] })),
          duration: POLL_HOURS,
          allowMultiselect: true,
        },
      });
      const pollMsg = await interaction.fetchReply();

      const lines = times.map((time, i) => t('local_times_line', { emoji: emojis[i], time }));
      const timesMsg = await interaction.followUp(t('local_times_header', { name, message }) + '\n' + lines.join('\n'));

      return {
        channelId: interaction.channelId,
        pollId: pollMsg.id,
        timesId: timesMsg.id,
        name,
        times,
        endsAt: pollMsg.poll?.expiresTimestamp ?? Date.now() + POLL_HOURS * 3600 * 1000,
      };
    } finally {
      starting.delete(interaction.guildId);
    }
  },

  async run(data, client) {
    const now = Date.now();
    if (now - (lastCheck[data.pollId] ?? 0) < CHECK_SECONDS * 1000) return false;
    lastCheck[data.pollId] = now;
    const done = () => { delete lastCheck[data.pollId]; return true; };

    let channel, pollMsg, timesMsg;
    try {
      channel = await client.channels.fetch(data.channelId);
      pollMsg = await fetchMessage(channel, data.pollId);
      timesMsg = await fetchMessage(channel, data.timesId);
    } catch (err) {
      if (err.code === UNKNOWN_CHANNEL) return done();
      return false; // temporary problem; try again later
    }

    // If either message was deleted, delete the other and drop the vote.
    if (!pollMsg || !timesMsg) {
      await pollMsg?.delete().catch(() => {});
      await timesMsg?.delete().catch(() => {});
      return done();
    }

    if (now < data.endsAt) return false;
    if (!pollMsg.poll?.resultsFinalized && now < data.endsAt + FINALIZE_WAIT_MS) return false;

    // Most votes wins; ties prefer Fri/Sat/Sun, then the earliest day.
    const votes = data.times.map((time, i) => ({ time, count: pollMsg.poll?.answers.get(i + 1)?.voteCount ?? 0 }));
    const max = Math.max(...votes.map(v => v.count));
    if (max === 0) {
      await channel.send(t('no_votes', { name: data.name }));
      return done();
    }
    const tied = votes.filter(v => v.count === max);
    const weekend = tied.filter(v => WEEKEND.includes(new Date(v.time * 1000).getUTCDay()));
    const winner = (weekend.length ? weekend : tied)[0];

    await channel.send(t('result', { name: data.name, time: winner.time }));
    return done();
  },
};
