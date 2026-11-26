import { resolve } from "node:path";
import { config as loadDotenv } from "dotenv";

export class ConfigurationError extends Error {}

export function loadEnvironment(): void {
    const { error } = loadDotenv({ quiet: true });
    if (error && (error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw new ConfigurationError("Could not read .env.");
    }
}

export function databasePath(env: NodeJS.ProcessEnv): string {
    return resolve(env.DATABASE_PATH?.trim() || "data/confessions.sqlite");
}

function integerSetting(env: NodeJS.ProcessEnv, name: string, fallback: number, max: number): number {
    const input = env[name]?.trim();
    if (!input) return fallback;
    const value = Number(input);
    if (!/^\d+$/.test(input) || !Number.isSafeInteger(value) || value < 1 || value > max) {
        throw new ConfigurationError(`${name} must be a whole number from 1 to ${max}.`);
    }
    return value;
}

export function readConfig(env: NodeJS.ProcessEnv) {
    const token = env.BOT_TOKEN?.trim() ?? "";
    if (!/^\d+:[A-Za-z0-9_-]+$/.test(token)) {
        throw new ConfigurationError("Set BOT_TOKEN to your BotFather token.");
    }

    const channel = env.CHANNEL_ID?.trim() ?? "";
    let channelId: string | number = channel;
    if (/^-\d+$/.test(channel) && Number.isSafeInteger(Number(channel)) && Number(channel) < 0) {
        channelId = Number(channel);
    } else if (!/^@[A-Za-z0-9_]+$/.test(channel)) {
        throw new ConfigurationError("Set CHANNEL_ID to a negative Telegram channel ID or @channelusername.");
    }

    const channelUrl = env.CHANNEL_URL?.trim();
    if (channelUrl && !/^https:\/\/t\.me\/(?:[A-Za-z0-9_]+|(?:\+|joinchat\/)[A-Za-z0-9_-]+)\/?$/.test(channelUrl)) {
        throw new ConfigurationError("CHANNEL_URL must be a Telegram channel or invite link starting with https://t.me/.");
    }

    const timezone = env.BOT_TIMEZONE?.trim() || "Europe/Chisinau";
    let calendar: Intl.DateTimeFormat;
    try {
        if (/^[+-]/.test(timezone)) throw new RangeError();
        calendar = new Intl.DateTimeFormat("en", {
            timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit",
        });
    } catch {
        throw new ConfigurationError("BOT_TIMEZONE must be an IANA timezone such as Europe/Chisinau.");
    }

    const adminUnlimited = env.ADMIN_UNLIMITED_POSTS?.trim().toLowerCase() || "false";
    if (adminUnlimited !== "true" && adminUnlimited !== "false") {
        throw new ConfigurationError("ADMIN_UNLIMITED_POSTS must be true or false.");
    }

    return {
        token, channelId, channelUrl, timezone, calendar,
        databasePath: databasePath(env),
        dailyLimit: integerSetting(env, "DAILY_POST_LIMIT", 5, 5),
        adminUnlimitedPosts: adminUnlimited === "true",
        textLimit: integerSetting(env, "CONFESSION_TEXT_LIMIT", 4000, 4000),
        nicknameLimit: integerSetting(env, "NICKNAME_LIMIT", 32, 32),
    };
}

export type Settings = ReturnType<typeof readConfig>;
