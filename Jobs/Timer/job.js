const t = require('../../strings')(__dirname);

module.exports = {
  command: {
    name: t('command'),
    description: t('description'),
    options: [{ name: t('option'), description: t('option_description'), type: 4, required: true, min_value: 1 }],
  },

  async create(interaction) {
    const seconds = interaction.options.getInteger(t('option'));
    await interaction.reply(t('started', { seconds }));
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
    await channel.send(t('done', { username: data.username }));
    return true;
  },
};
