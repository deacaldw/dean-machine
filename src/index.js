const fs = require('fs');
const path = require('path');

// Packaged: everything lives next to the executable. From source: data in the project root, .env in res/.
const root = path.join(__dirname, '..');
const baseDir = process.pkg ? path.dirname(process.execPath) : root;
require('dotenv').config({ path: path.join(baseDir, process.pkg ? '.env' : 'res/.env') });

const { Client, GatewayIntentBits, Events } = require('discord.js');
const db = require('./db')(path.join(baseDir, 'Servers'));

const LOOP_SECONDS = Number(process.env.LOOP_SECONDS) || 2;
const PERMISSIONS = 562949953489920n; // View Channels, Send Messages, Read Message History, Create Polls

// Each Skills/<Name>/skill.js exports:
//   commands                  slash command definitions
//   handle(interaction, ctx)  handles its commands and components whose customId starts with "<Name>:"
//                             ctx: { jobs: [{ id, data }], add(data) -> id, remove(id) }
//   run(data, client)         called every loop tick; may update data; returns true when the job is done
const skills = {};
const skillsDir = path.join(root, 'Skills');
for (const name of fs.readdirSync(skillsDir)) {
  skills[name] = require(path.join(skillsDir, name, 'skill.js'));
}

const client = new Client({ intents: [GatewayIntentBits.Guilds] });

client.once(Events.ClientReady, async () => {
  await client.application.commands.set(Object.values(skills).flatMap(s => s.commands));
  const invite = `https://discord.com/oauth2/authorize?client_id=${process.env.APP_ID}&scope=bot+applications.commands&permissions=${PERMISSIONS}`;
  console.log(`Logged in as ${client.user.tag}. Skills: ${Object.keys(skills).join(', ')}`);
  console.log(`Invite: ${invite}`);
  try {
    fs.writeFileSync(path.join(baseDir, 'invite.txt'), invite + '\n');
  } catch (err) {
    console.error(`Could not write invite.txt: ${err.message}`);
  }
  setInterval(loop, LOOP_SECONDS * 1000);
});

client.on(Events.InteractionCreate, async interaction => {
  if (!interaction.guildId) return;
  const name = Object.keys(skills).find(n => interaction.isChatInputCommand()
    ? skills[n].commands.some(c => c.name === interaction.commandName)
    : interaction.isMessageComponent() && interaction.customId.startsWith(`${n}:`));
  if (!name) return;

  const server = db.get(interaction.guildId);
  const before = JSON.stringify(server.jobs);
  try {
    await skills[name].handle(interaction, {
      jobs: server.jobs.filter(j => j.skill === name),
      add: data => {
        const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
        server.jobs.push({ id, skill: name, data });
        return id;
      },
      remove: id => { server.jobs = server.jobs.filter(j => j.id !== id); },
    });
  } catch (err) {
    console.error(`${name}: ${err.message}`);
  }
  if (JSON.stringify(server.jobs) !== before) db.save(interaction.guildId);
});

let running = false;
async function loop() {
  if (running) return; // a slow tick must not overlap the next one
  running = true;
  try {
    for (const serverId of db.list()) {
      const server = db.get(serverId);
      const before = JSON.stringify(server.jobs);
      const done = [];
      for (const job of server.jobs) {
        try {
          if (!skills[job.skill] || await skills[job.skill].run(job.data, client)) done.push(job.id);
        } catch (err) {
          console.error(`${job.skill} job ${job.id} failed: ${err.message}`);
          done.push(job.id);
        }
      }
      server.jobs = server.jobs.filter(j => !done.includes(j.id));
      if (JSON.stringify(server.jobs) !== before) db.save(serverId);
    }
  } finally {
    running = false;
  }
}

if (!process.env.DISCORD_TOKEN) {
  console.error(`DISCORD_TOKEN is missing. Put it in ${path.join(baseDir, process.pkg ? '.env' : 'res/.env')}`);
  process.exit(1);
}
client.login(process.env.DISCORD_TOKEN);
