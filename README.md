# Telegram Confession Bot

A self-hosted Telegram bot that publishes private text submissions to a channel under a chosen nickname or anonymously. It uses TypeScript, grammY, and SQLite.

## Getting started

Use Node.js 26 or newer. Install the dependencies, then create `.env` from the example if you don’t have one.

```powershell
npm ci
if (-not (Test-Path .env)) { Copy-Item .env.example .env }
```

Create a bot with [BotFather](https://t.me/BotFather), add it as a channel administrator with **Post Messages** permission, and set `BOT_TOKEN` and `CHANNEL_ID` in `.env`.

```powershell
npm run build
npm start
```

Run one bot process per token. The bot uses long polling and checks its channel permissions at startup. Press Ctrl+C to stop it. Use `npm run dev` for watch mode. In PowerShell, `npm.cmd` also works when script execution is restricted.

## Configuration

| Variable | Description |
| --- | --- |
| `BOT_TOKEN` | BotFather token. Store it in `.env` or the process environment. |
| `CHANNEL_ID` | Public `@channel_username` or numeric Telegram channel ID. Private channels require the numeric ID, including the leading minus sign. |
| `CHANNEL_URL` | Optional Telegram link for the **View channel** button. A private invite link gives successful submitters the option to join. Without an invite, private links open the post for existing members. |
| `DATABASE_PATH` | SQLite path. Defaults to `data/confessions.sqlite`. Relative paths resolve from the project directory when using npm scripts. |
| `BOT_TIMEZONE` | IANA timezone for daily allowances. Defaults to `Europe/Chisinau`. |
| `DAILY_POST_LIMIT` | Posts per allowance. Defaults to `5` and accepts integers from 1 to 5. |
| `ADMIN_UNLIMITED_POSTS` | Set to `true` to exempt channel owners and administrators. Defaults to `false`. |
| `CONFESSION_TEXT_LIMIT` | Maximum confession length in UTF-16 units. Defaults to `4000`. |
| `NICKNAME_LIMIT` | Maximum nickname length in UTF-16 units. Defaults to `32`. |

Shell environment variables take precedence over `.env`. The bot also checks the full outbound message against [Telegram’s message limit](https://core.telegram.org/bots/api#sendmessage).

## Posting

Send `/start` to the bot and choose a nickname or anonymous mode. Subsequent text messages in that private chat publish immediately. A successful post gets an acknowledgement with the remaining allowance and a **View channel** button.

| Command | Behavior |
| --- | --- |
| `/start` | Start setup or show the saved preference and remaining allowance. |
| `/help` | Show commands and privacy information. |
| `/confess` | Show posting instructions and the remaining allowance. |
| `/nickname River Fox` | Save a nickname immediately. Send `/nickname` by itself to enter it at a prompt. |
| `/anonymous` | Switch to anonymous posting and retain the saved nickname. |
| `/cancel` | Cancel pending setup or a nickname change. |

The bot quotes the confession and adds the author signature below it. Nicknames are reserved to Telegram account IDs. When checking ownership, the bot ignores decoration such as spaces, punctuation, and accents in names containing letters or numbers. It also compares common Unicode look-alikes. When older names collide, the earliest confirmed post takes precedence. [Unicode guidance](https://www.unicode.org/reports/tr39/#Confusable_Detection)

Allowances renew at local midnight. Once all available slots have been used by confirmed posts, the bot privately offers a **Please** button. Tapping it or typing `please` refills the allowance. A rejected send releases its slot. A send with an unknown outcome holds its slot until recovery.

## Storage and privacy

Anonymous posts display “Anonymous” in the channel. The database stores Telegram user IDs, submitted text, preferences, and publication records. Telegram and the bot operator have access to submission information. The project excludes local configuration and database files from Git.

The database tracks successful posts by channel and Telegram message ID. Editing an old post in place preserves its link and stored publication record. To look up a published post’s sender, pass the full post link to the local CLI.

```powershell
npm run author -- "https://t.me/your_channel/123"
```

Keep lookup results and database backups private. Stop the bot and any recovery commands before copying the SQLite database and its sidecar files. To restore, point `DATABASE_PATH` at the restored copy. The project has no automatic data retention policy.

### Recover an uncertain publication

The bot records uncertain publications after cases such as a timeout or a crash between sending and saving the result. It leaves the slot reserved and avoids automatically resending the message.

1. Stop the bot and back up the database.
2. Run `npm run recovery -- list` to find the internal reference.
3. Run `npm run recovery -- inspect REFERENCE` privately and match the saved text, author label, and time against the channel.
4. If you verify the post, record the last number from its Telegram post link. If you verify that Telegram rejected the send, record it as failed. Leave inconclusive records unresolved.

```powershell
npm run recovery -- published REFERENCE CHANNEL_MESSAGE_ID
npm run recovery -- failed REFERENCE
```

Restart the bot after recovery. For startup problems, check the token on a Telegram 401, check for a second poller on a 409, and check the channel ID and **Post Messages** permission if channel validation fails.

## Development

```powershell
npm run check
npm run build
npm test
```

Tests mock Telegram and use temporary databases. Set `TEST_COMPILED=1` after building to run the same suite against `dist/`. For a live smoke test, use a separate bot, channel, and SQLite database. Verify anonymous publishing, nickname publishing, the channel button, and the allowance refill.

| Module | Responsibility |
| --- | --- |
| `src/bot.ts`, `src/handlers.ts` | Startup checks, polling, and private-chat commands |
| `src/storage.ts` | SQLite schema, nickname ownership, quotas, and publication records |
| `src/publishing.ts` | Channel message formatting and send outcomes |
| `src/author.ts`, `src/recovery.ts` | Local operator tools |
