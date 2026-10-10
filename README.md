# DeanMachine

A small Discord bot. A loop runs every few seconds and processes jobs stored per server in `Servers/<Server_ID>.json`.

## Setup

1. Install Node.js 22+.
2. `npm install`
3. Copy `.env.example` to `.env` and put in your bot token.
4. Invite the bot with the `bot` and `applications.commands` scopes and the View Channels, Send Messages,
   Read Message History and Create Polls permissions. The bot prints a ready-made invite link on startup.
5. `npm start`

## Build executables

```
./build.sh
```

This installs dependencies, clears `dist/` and runs `npm run build`.

This creates two ready-to-deploy folders, each with the executable, a copy of `.env` and the editable strings:

- `dist/windows/` (Windows x64): run `deanmachine.exe`
- `dist/linux/` (Debian x64): run `./deanmachine` (you may need `chmod +x deanmachine` first)

Copy the whole folder to the target machine. `Servers/` is created next to the executable on first run.
Default strings are built into the executable. To override, put a copy at the same relative path next to it
(e.g. `strings.yaml` or `Jobs/VoteTime/strings.yaml`).

## Messages

All strings live in YAML files: core bot messages in `strings.yaml`, and each job's in `Jobs/<Job>/strings.yaml`.
Edit them to restyle messages (Discord markdown and emoji work). Placeholders like `{name}` are filled in by the bot.

## Jobs

Each job is a self-contained folder in `Jobs/`. The folder name is the job type:

```
Jobs/
  Announce/       # /announce, /stop-announce
  VoteTime/       # /vote-time
    job.js        # the job's code
    strings.yaml  # the job's strings
```

`job.js` loads its own strings with `const t = require('../../strings')(__dirname);` and exports:

- `commands`: the job's slash command definitions
- `handle(interaction, ctx)`: handles the job's slash commands, plus any button or select menu whose `customId`
  starts with `<Job>:` (e.g. `Announce:stop`). `ctx.jobs` lists this job type's running instances on the server
  as `{ id, data }`; `ctx.add(data)` starts a new one and `ctx.remove(id)` deletes one.
- `run(data, client)`: called every loop tick. It may update `data` (changes are saved automatically).
  Return `true` when the job is finished and it is removed from the database.

To add a job, add a new folder. No other code changes are needed.

Server database format:

```json
{
  "jobs": [
    { "id": "lx3k9a1b", "type": "VoteTime", "data": { "channelId": "...", "pollId": "...", "timesId": "...", "name": "Next Session", "times": [1791738000, 1791824400, 1791910800], "endsAt": 1791698186389 } }
  ]
}
```

