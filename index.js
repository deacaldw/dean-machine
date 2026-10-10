const fs = require('fs');
const path = require('path');

// When packaged as an executable, look for .env and Servers/ next to the exe.
const baseDir = process.pkg ? path.dirname(process.execPath) : __dirname;
require('dotenv').config({ path: path.join(baseDir, '.env') });

const { Client, GatewayIntentBits, Events } = require('discord.js');
const db = require('./db')(path.join(baseDir, 'Servers'));
const t = require('./strings')(__dirname);

const LOOP_SECONDS = Number(process.env.LOOP_SECONDS) || 2;

// Load every job type from Jobs/<Name>/job.js. The folder name is the job type.
// Each job module exports:
//   commands - slash command definitions
//   handle(interaction, ctx) - handles the job's slash commands, and any component
//       (button, select menu) whose customId starts with "<Name>:". ctx has:
//         jobs        this server's running instances of this job type: [{ id, data }]
//         add(data)   start a new instance; returns its id
//         remove(id)  delete an instance
//   run(data, client) - called every loop tick; may update `data`; returns true when complete
const jobs = {};
const jobsDir = path.join(__dirname, 'Jobs');
for (const name of fs.readdirSync(jobsDir)) {
  const file = path.join(jobsDir, name, 'job.js');
  if (fs.existsSync(file)) jobs[name] = require(file);
}

const client = new Client({ intents: [GatewayIntentBits.Guilds] });

client.once(Events.ClientReady, async () => {
  await client.application.commands.set(Object.values(jobs).flatMap(j => j.commands));
  console.log(t('console.logged_in', { tag: client.user.tag, jobs: Object.keys(jobs).join(', ') }));
  console.log(t('console.invite', { url: `https://discord.com/oauth2/authorize?client_id=${process.env.APP_ID}&scope=bot+applications.commands&permissions=562949953489920` }));
  setInterval(loop, LOOP_SECONDS * 1000);
});

client.on(Events.InteractionCreate, async interaction => {
  if (!interaction.guildId) return;
  const type = Object.keys(jobs).find(name =>
    interaction.isChatInputCommand() ? jobs[name].commands.some(c => c.name === interaction.commandName)
      : interaction.isMessageComponent() && interaction.customId.startsWith(`${name}:`));
  if (!type) return;

  const server = db.get(interaction.guildId);
  const before = JSON.stringify(server.jobs);
  try {
    await jobs[type].handle(interaction, {
      jobs: server.jobs.filter(j => j.type === type),
      add: data => {
        const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
        server.jobs.push({ id, type, data });
        return id;
      },
      remove: id => { server.jobs = server.jobs.filter(j => j.id !== id); },
    });
  } catch (err) {
    console.error(t('console.handler_failed', { type, error: err.message }));
  }
  if (JSON.stringify(server.jobs) !== before) db.save(interaction.guildId);
});

let running = false;
async function loop() {
  if (running) return; // don't overlap if a tick takes longer than the interval
  running = true;
  try {
    for (const serverId of db.list()) {
      const server = db.get(serverId);
      const before = JSON.stringify(server.jobs);
      const finished = [];
      for (const job of server.jobs) {
        try {
          if (!jobs[job.type] || await jobs[job.type].run(job.data, client)) finished.push(job.id);
        } catch (err) {
          console.error(t('console.job_failed', { type: job.type, id: job.id, error: err.message }));
          finished.push(job.id);
        }
      }
      server.jobs = server.jobs.filter(j => !finished.includes(j.id));
      if (JSON.stringify(server.jobs) !== before) db.save(serverId);
    }
  } finally {
    running = false;
  }
}

if (!process.env.DISCORD_TOKEN) {
  console.error(t('console.missing_token', { path: path.join(baseDir, '.env') }));
  process.exit(1);
}
client.login(process.env.DISCORD_TOKEN);
