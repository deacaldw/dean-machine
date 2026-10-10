# DeanMachine

A small Discord bot. A loop runs every few seconds and processes jobs stored per server in `Servers/<Server_ID>.json`.

## Setup

1. Install Node.js 22+.
2. `npm install`
3. Copy `.env.example` to `.env` and put in your bot token.
4. Invite the bot with the `bot` and `applications.commands` scopes.
5. `npm start`

## Build executables

```
npm run build
```

This creates `dist/deanmachine-win.exe` (Windows x64) and `dist/deanmachine-linux` (Debian x64).
Put `.env` in the same folder as the executable. `Servers/` is created there too.
Default strings are built into the executable. To override, put a copy at the same relative path next to it
(e.g. `strings.yaml` or `Jobs/Timer/strings.yaml`).

## Messages

All strings live in YAML files: core bot messages in `strings.yaml`, and each job's in `Jobs/<Job>/strings.yaml`.
Edit them to restyle messages (Discord markdown and emoji work). Placeholders like `{username}` are filled in by the bot.

## Jobs

Each job is a self-contained folder in `Jobs/`. The folder name is the job type:

```
Jobs/
  Timer/
    job.js        # the job's code
    strings.yaml  # the job's strings
```

`job.js` loads its own strings with `const t = require('../../strings')(__dirname);` and exports:

- `command`: the slash command that creates the job
- `create(interaction)`: replies to the user and returns the job's data
- `run(data, client)`: called every loop tick; return `true` when the job is finished and it is removed from the database

To add a job, add a new folder. No other code changes are needed.

Server database format:

```json
{
  "jobs": [
    { "id": "lx3k9a1b", "type": "Timer", "data": { "userId": "...", "username": "...", "channelId": "...", "endsAt": 1760000000000 } }
  ]
}
```

