// Minimal stand-ins for the discord.js objects the skills use.

function ctx(list = [], storage = {}) {
  return {
    jobs: list,
    storage,
    add(data) {
      const id = `j${list.length}`;
      list.push({ id, data });
      return id;
    },
    remove(id) {
      list.splice(list.findIndex(j => j.id === id), 1);
    },
  };
}

function command(name, options = {}, { admin = false, userId = 'u1', displayName = 'Dean' } = {}) {
  const i = {
    commandName: name,
    guildId: 'g1',
    channelId: 'c1',
    user: { id: userId, username: displayName },
    member: { displayName },
    memberPermissions: { has: () => admin },
    isChatInputCommand: () => true,
    isMessageComponent: () => false,
    options: { getString: k => options[k] ?? null, getInteger: k => options[k] ?? null },
    reply: async x => { i.replied = x; },
    fetchReply: async () => ({ id: 'reply1' }),
    followUp: async x => {
      i.followedUp = x;
      return { id: 'followup1', poll: x.poll && { expiresTimestamp: Date.now() + 864e5 } };
    },
  };
  return i;
}

function component(customId, { values, admin = false, userId = 'u1' } = {}) {
  const i = {
    customId,
    values,
    user: { id: userId },
    memberPermissions: { has: () => admin },
    isChatInputCommand: () => false,
    isMessageComponent: () => true,
    update: async x => { i.updated = x; },
  };
  return i;
}

// A client with one channel. `messages` maps message id -> message; missing ids are "deleted".
function client(messages = {}) {
  const channel = {
    sent: [],
    deleted: [],
    recent: [], // ids of the channel's latest messages
    messages: {
      fetch: async arg => {
        if (arg.limit) return channel.recent.map(id => ({ id }));
        const msg = messages[arg.message];
        if (!msg) throw Object.assign(new Error('Unknown Message'), { code: 10008 });
        return { ...msg, delete: async () => channel.deleted.push(arg.message) };
      },
    },
    send: async x => {
      channel.sent.push(x);
      return { id: `m${channel.sent.length}` };
    },
  };
  return { channel, channels: { fetch: async () => channel } };
}

module.exports = { ctx, command, component, client };
