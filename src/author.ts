import { DatabaseSync } from "node:sqlite";
import { Api } from "grammy";
import { ConfigurationError, loadEnvironment, readConfig } from "./config.ts";

function parsePostLink(link: string): { channel: string | number; messageId: number } {
    const url = URL.parse(link);
    const match = url?.origin === "https://t.me" && !url.username && !url.password
        ? /^\/(?:(?:s\/)?([a-zA-Z0-9_]+)|c\/(\d+))\/(\d+)\/?$/.exec(url.pathname)
        : null;
    const messageId = Number(match?.[3]);
    if (!match || !Number.isSafeInteger(messageId) || messageId < 1) {
        throw new ConfigurationError("Paste the full Telegram channel post link.");
    }
    const [, username, privateId] = match;
    const privateChannelId = Number(privateId);
    if (!username && (!Number.isSafeInteger(privateChannelId) || privateChannelId < 1
        || privateChannelId > 997_852_516_352)) {
        throw new ConfigurationError("The link contains an invalid Telegram channel ID.");
    }
    // Private links use the MTProto channel ID.
    return { channel: username ? `@${username}` : -(1_000_000_000_000 + privateChannelId), messageId };
}

export async function lookupAuthor(link: string, path: string, api: Pick<Api, "getChat">) {
    const { channel, messageId } = parsePostLink(link);
    let channelId: number;
    if (typeof channel === "number") {
        channelId = channel;
    } else {
        const chat = await api.getChat(channel).catch(() => undefined);
        if (chat?.type !== "channel") {
            throw new ConfigurationError("Could not verify the channel in Telegram. Check the post link and bot access.");
        }
        channelId = chat.id;
    }

    const db = new DatabaseSync(path, { readOnly: true, timeout: 5000 });
    let rows;
    try {
        rows = db.prepare(`
            SELECT user_id, author_label FROM submissions
            WHERE channel_id = ? AND channel_message_id = ? AND status = 'published'
        `).all(channelId, messageId) as { user_id: number; author_label: string }[];
    } finally {
        db.close();
    }
    if (!rows.length) throw new ConfigurationError("No published submission in this database matches that post.");
    if (rows.length > 1) throw new ConfigurationError("Multiple records match this post. No sender could be confirmed.");

    const { user_id: userId, author_label: postedAs } = rows[0];
    const chat = await api.getChat(userId).catch(() => undefined);
    const profile = chat?.type === "private" ? chat : undefined;
    const name = [profile?.first_name, profile?.last_name].filter(Boolean).join(" ");
    return {
        userId,
        postedAs,
        username: profile?.username ? `@${profile.username}` : null,
        displayName: name || null,
    };
}

if (import.meta.main) {
    try {
        if (process.argv.length !== 3) {
            throw new ConfigurationError('Usage: npm run author -- "https://t.me/channel/123"');
        }
        loadEnvironment();
        const settings = readConfig(process.env);
        const api = new Api(settings.token, { timeoutSeconds: 8, sensitiveLogs: false });
        const author = await lookupAuthor(process.argv[2], settings.databasePath, api);
        console.log(`Telegram user ID: ${author.userId}`);
        if (author.displayName) console.log(`Current name: ${author.displayName}`);
        console.log(`Current username: ${author.username ?? "(unavailable)"}`);
        console.log(`Posted as: ${author.postedAs}`);
    } catch (error) {
        console.error(error instanceof ConfigurationError ? error.message
            : "Could not look up the post. Check DATABASE_PATH and database access.");
        process.exitCode = 1;
    }
}
