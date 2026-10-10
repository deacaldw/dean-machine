const t = require('../strings');

module.exports = {
  command: {
    name: t('timer.command'),
    description: t('timer.description'),
    options: [{ name: t('timer.option'), description: t('timer.option_description'), type: 4, required: true, min_value: 1 }],
  },

  async create(interaction) {
    const seconds = interaction.options.getInteger(t('timer.option'));
    await interaction.reply(t('timer.started', { seconds }));
    return {
      userId: interaction.user.id,
      username: interaction.user.username,
      channelId: interaction.channelId,
      endsAt: Date.now() + seconds * 1000,
    };
  },

  async run(data, client) {
    if (Date.now() < data.endsAt) return false;
    const channel = await client.channels.fetch(data.channelId);
    await channel.send(t('timer.done', { username: data.username }));
    return true;
  },
};
