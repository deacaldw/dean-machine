# DeanMachine

A Discord bot for multiple servers. Each feature is a self-contained **skill**; running instances of a skill
(**jobs**) are stored per server in `Servers/<Server_ID>.json` and processed by a loop every few seconds.

## Skills

- **VoteTime** – `/vote-time`: a 24h poll to pick the next game session time, shown in everyone's local time.
- **Announce** – `/announce`, `/stop-announce`: one-off or repeating announcements.
- **TwentyQuestions** – `/20questions [category]`: a co-op guessing game about a Wikipedia topic from a category
  (yours, in your own words, or a random one), played in a thread and refereed by Claude.

## Setup

1. Install Node.js 22+ and run `npm install`.
2. Copy `res/.env.example` to `res/.env` and set `DISCORD_TOKEN`, `APP_ID` and `ANTHROPIC_API_KEY`
   (optionally `YOUTUBE_API_KEY` for trailers, songs and documentaries after 20 Questions games).
   In the Discord Developer Portal, enable **Message Content Intent** on the Bot page.
3. `npm start`. The bot prints an invite link (also saved to `invite.txt`).

## Build

```
./build.sh
```

Runs the tests, then creates `bin/windows/` and `bin/linux/`. Each contains the executable, `.env`, and the skills'
`strings.yaml` files, which can be edited there without rebuilding. Everything in `res/<target>/` is copied in too.

On Debian, put `bin/linux` where the bot should live and run `sudo bash setup.sh` inside it. This registers it as
the `deanmachine` systemd service, which starts on boot and restarts on failure. Logs: `journalctl -u deanmachine -f`.

## Project layout

```
src/        core: Discord client, job loop, per-server JSON database, strings loader
Skills/     one folder per skill: skill.js + strings.yaml
res/        files copied into bin/: .env, and linux/setup.sh
test/       npm test
```

## Writing a skill

Add `Skills/<Name>/skill.js` and `Skills/<Name>/strings.yaml`. Load strings with
`const t = require('../../src/strings')(__dirname)` and export:

- `commands`: slash command definitions.
- `handle(interaction, ctx)`: handles the commands, plus buttons and menus whose `customId` starts with `<Name>:`.
  `ctx.jobs` lists this skill's jobs on the server (`{ id, data }`); `ctx.add(data)` returns a new job id;
  `ctx.remove(id)` deletes a job. `ctx.storage` is the skill's own object on the server, kept for good (unlike jobs);
  changes to it are saved.
- `message(message, ctx)` (optional): called for every message people post in the server.
- `run(data, client, storage)`: called every tick for each job. Changes to `data` and `storage` are saved. Return
  `true` when done.
