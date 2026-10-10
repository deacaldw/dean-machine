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
A default `strings.yaml` is built into the executable; put a copy next to it to override.

## Messages

Every string the bot uses lives in `strings.yaml`. Edit it to restyle messages (Discord markdown and emoji work).
Placeholders like `{username}` are filled in by the bot. In code, use `t('timer.done', { username })` from `strings.js`.

## Jobs

Each file in `Jobs/` is a job type and exports:

- `command`: the slash command that creates the job
- `create(interaction)`: replies to the user and returns the job's data
- `run(data, client)`: called every loop tick; return `true` when the job is finished and it is removed from the database

Server database format:

```json
{
  "jobs": [
    { "id": "lx3k9a1b", "type": "Timer", "data": { "userId": "...", "username": "...", "channelId": "...", "endsAt": 1760000000000 } }
  ]
}
```

## Commands

- `/set-timer <seconds>`: replies `<username>, your timer is up.` when it runs out.
