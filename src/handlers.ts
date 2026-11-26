import { randomUUID } from "node:crypto";
import { InlineKeyboard, type Bot } from "grammy";
import type { Settings } from "./config.ts";
import { channelText, localDay, publish, safeError, sendWithRateLimitRetry, TELEGRAM_MESSAGE_LIMIT } from "./publishing.ts";
import type { Storage, Submission } from "./storage.ts";

export const commands = [
    { command: "start", description: "Welcome and posting allowance" },
    { command: "help", description: "Posting, commands, and privacy" },
    { command: "confess", description: "How to send a confession" },
    { command: "nickname", description: "Set or change your public nickname" },
    { command: "anonymous", description: "Switch to anonymous posting" },
    { command: "cancel", description: "Cancel setup or a nickname change" },
];

const setupKeyboard = new InlineKeyboard()
    .text("Choose a nickname", "setup:nickname")
    .text("Stay anonymous", "setup:anonymous");

type Reply = { text: string; keyboard?: InlineKeyboard };
type Action = Reply | { submission: Submission };
const visibleText = /[^\p{White_Space}\p{Default_Ignorable_Code_Point}\p{Cc}]/u;

export function registerHandlers(
    bot: Bot,
    settings: Settings,
    storage: Storage,
    channel: { id: number; username?: string; active_usernames?: string[] },
    isChannelAdmin: (userId: number) => Promise<boolean>,
    now = () => new Date(),
    pause?: (ms: number) => Promise<unknown>,
): void {
    const channelUsername = channel.username ?? channel.active_usernames?.[0];
    const channelUrl = settings.channelUrl || (channelUsername ? `https://t.me/${channelUsername}` : undefined);
    // Private message links use the MTProto channel ID.
    const privateChannelId = -channel.id - 1_000_000_000_000;
    const limit = settings.dailyLimit;
    const quotaAt = (id: number, day: string) => {
        const { used, published, bonus } = storage.quota(id, day);
        const remaining = Math.max(0, limit + bonus - used);
        return {
            used, bonus, remaining,
            resetReady: remaining === 0 && published === used,
            button: `quota:please:${day}:${bonus}`,
        };
    };
    const offerReset = (text: string, button: string, keyboard?: InlineKeyboard): Reply => ({
        text: `${text}\n\nYou have 0/${limit} posts remaining today. Say “please” or tap Please to reset to ${limit}/${limit}.`,
        keyboard: (keyboard?.row() ?? new InlineKeyboard()).text("Please", button),
    });
    const allowance = (count: number) => `You have ${count} ${count === 1 ? "post" : "posts"} remaining today.`;
    const unlimitedNotice = "You have no daily posting limit as a channel admin.";
    const renewal = `Your allowance renews at midnight (${settings.timezone}).`;
    const nicknamePrompt = `Send a nickname of up to ${settings.nicknameLimit} characters on one line. Use /cancel to stop.`;
    const welcome = (unlimited: boolean) => ({
        text: `Welcome! After setup, ordinary text you send here is published immediately to the channel. ${unlimited
            ? unlimitedNotice : `You can post up to ${settings.dailyLimit} times per day.`} Choose how your posts will be signed.`,
        keyboard: setupKeyboard,
    });
    const instructions = "Send your confession as a text message here and it will be published immediately.";
    const textOnly = "This bot accepts ordinary text messages. Type or paste your confession as a new message.";
    const help = [
        instructions,
        `The daily limit is ${limit} posts per person. ${renewal}${settings.adminUnlimitedPosts ? " Channel admins have unlimited posts." : ""}`,
        "/start — Show your publishing preference and allowance.\n/help — Show this guide.\n/confess — Get posting instructions.\n/nickname — Set your public nickname, for example /nickname Your Name.\n/anonymous — Switch to anonymous posting.\n/cancel — Cancel setup or a nickname change.",
        "People reading the channel see your confession and Anonymous or your chosen nickname. The bot stores your Telegram user ID for preferences, limits, and notifications, along with your submissions and their internal references. The bot operator and Telegram can access information about your submissions. Avoid including identifying details in your confession or nickname.",
    ].join("\n\n");

    bot.use(async (ctx) => {
        const message = ctx.update.message;
        const callback = ctx.update.callback_query;
        const user = ctx.from;
        if (ctx.chat?.type !== "private" || !user || user.is_bot || (!message && !callback)) return;
        const resetButton = callback?.data?.startsWith("quota:please:");
        if (callback && callback.data !== "setup:nickname" && callback.data !== "setup:anonymous" && !resetButton) return;
        const eventKey = message ? `message:${message.message_id}` : `callback:${callback!.id}`;
        const id = user.id;
        const unlimited = settings.adminUnlimitedPosts && await isChannelAdmin(id);
        const available = (day: string) => unlimited ? unlimitedNotice : allowance(quotaAt(id, day).remaining);

        const action = storage.handleUpdate<Action>(id, eventKey, ctx.update.update_id, () => {
            const preference = storage.preference(id);
            const awaitingNickname = preference.editingNickname === 1;
            const time = now();
            const day = localDay(settings.calendar, time);
            const resetAllowance = (used: number) => {
                storage.resetQuota(id, day, used);
                return { text: `Allowance reset! You have ${limit}/${limit} posts available today.` };
            };
            const ready = () => ({
                text: `All set! ${instructions} ${available(day)}`,
            });
            const saveAnonymous = () => {
                storage.setPreference(id, { ...preference, mode: "anonymous", editingNickname: 0 });
                return ready();
            };
            const askNickname = () => {
                storage.setPreference(id, { ...preference, editingNickname: 1 });
                return { text: nicknamePrompt };
            };
            const saveNickname = (nickname: string) => {
                if (!visibleText.test(nickname) || nickname.length > settings.nicknameLimit ||
                    nickname.startsWith("/") || /[\p{Cc}\p{Bidi_Control}\p{Zl}\p{Zp}]/u.test(nickname)) {
                    return askNickname();
                }
                if (!storage.claimNickname(id, nickname)) {
                    const retry = awaitingNickname ? nicknamePrompt : "Use /nickname with a different name.";
                    return { text: `That nickname is already taken or reserved. ${retry}` };
                }
                storage.setPreference(id, { mode: "nickname", nickname, editingNickname: 0 });
                return ready();
            };

            if (callback) {
                if (resetButton) {
                    const quota = quotaAt(id, day);
                    return preference.mode && !unlimited && quota.resetReady && callback.data === quota.button
                        ? resetAllowance(quota.used) : { text: "That button has expired. Send /start for your current allowance." };
                }
                if (preference.mode || awaitingNickname) {
                    return { text: awaitingNickname ? nicknamePrompt : "Use /nickname or /anonymous to change how future posts are signed." };
                }
                return callback.data === "setup:anonymous" ? saveAnonymous() : askNickname();
            }

            if (message?.text === undefined || message.forward_origin || message.via_bot || message.sender_chat) {
                return { text: awaitingNickname ? nicknamePrompt : textOnly };
            }

            const text = message.text.trim();
            if (text.startsWith("/") || message.entities?.some(entity => entity.type === "bot_command" && entity.offset === 0)) {
                const [commandToken = "", name, username] = /^\/(\w+)(?:@(\w+))?(?=\s|$)/.exec(text) ?? [];
                const target = username?.toLowerCase();
                const usernames = [ctx.me.username, ...(ctx.me.active_usernames ?? [])];
                if (target !== undefined && !usernames.some(username => username?.toLowerCase() === target)) {
                    return { text: "Use /help for this bot’s commands." };
                }
                switch (name?.toLowerCase()) {
                    case "start": {
                        if (!preference.mode) return awaitingNickname ? { text: nicknamePrompt } : welcome(unlimited);
                        const label = preference.mode === "anonymous" ? "Anonymous" : preference.nickname;
                        const next = awaitingNickname ? nicknamePrompt : instructions;
                        return { text: `Welcome back! Publishing as ${label}. ${available(day)}\n\n${next}\n\nUse /nickname or /anonymous to change your preference.` };
                    }
                    case "help":
                        return { text: help };
                    case "confess":
                        if (awaitingNickname) return { text: `${nicknamePrompt} ${available(day)}` };
                        return preference.mode
                            ? { text: `${instructions} ${available(day)}` } : welcome(unlimited);
                    case "nickname":
                        return saveNickname(text.slice(commandToken.length).trim());
                    case "anonymous":
                        return saveAnonymous();
                    case "cancel":
                        if (awaitingNickname) {
                            storage.setPreference(id, { ...preference, editingNickname: 0 });
                        }
                        return preference.mode
                            ? { text: awaitingNickname ? "Nickname change canceled. Your saved preference still applies." : "You have no nickname change in progress." }
                            : { text: "Setup canceled. Use /start when you’re ready." };
                    default:
                        return { text: "Unknown command. Use /help for the available commands." };
                }
            }

            if (awaitingNickname) return saveNickname(text);

            if (!preference.mode) return welcome(unlimited);
            if (!visibleText.test(text)) return { text: "Send a confession with some text." };

            if (!unlimited && text.toLowerCase() === "please") {
                const quota = quotaAt(id, day);
                return quota.resetReady ? resetAllowance(quota.used) : { text: "Send your confession as a new message." };
            }

            const submission = {
                reference: randomUUID(), userId: id, day, text,
                label: preference.mode === "nickname" ? preference.nickname! : "Anonymous",
                channelId: channel.id, acceptedAt: time.toISOString(),
            };
            if (text.length > settings.textLimit || channelText(submission).length > TELEGRAM_MESSAGE_LIMIT) {
                return { text: `That confession is too long. Send up to ${settings.textLimit} characters in one message.` };
            }

            if (!unlimited) {
                const quota = quotaAt(id, day);
                if (quota.remaining === 0) {
                    const used = quota.bonus === 0 && limit === 5 ? "all five" : "all";
                    const blocked = `You’ve used or reserved ${used} of today’s posting slots. ${renewal}`;
                    return quota.resetReady ? offerReset(blocked, quota.button) : { text: blocked };
                }
            }

            if (preference.mode === "nickname" && !storage.claimNickname(id, submission.label)) {
                return { text: "Your saved nickname is already taken or reserved. Use /nickname to pick a new name or /anonymous, then resend your confession." };
            }
            storage.reserve(submission);
            return { submission };
        });

        if (callback) {
            try {
                await ctx.answerCallbackQuery();
            } catch (error) {
                console.warn(`Could not acknowledge button (${safeError(error)}).`);
            }
        }
        if (!action) return;

        let reply: Reply;
        if ("submission" in action) {
            const { submission } = action;
            const result = await publish(submission, () => ctx.api.sendMessage(submission.channelId,
                channelText(submission), { link_preview_options: { is_disabled: true } }), pause);
            if (result.status !== "uncertain" && !storage.resolve(submission.reference, result, now().toISOString())) {
                throw new Error("Publication reservation could not be resolved.");
            }

            const replyDay = localDay(settings.calendar, now());
            const quota = quotaAt(id, replyDay);
            const left = unlimited ? unlimitedNotice : allowance(quota.remaining);
            if (result.status === "published") {
                const url = channelUrl ?? `https://t.me/c/${privateChannelId}/${result.messageId}`;
                const keyboard = new InlineKeyboard().url("View channel", url);
                reply = !unlimited && quota.resetReady
                    ? offerReset("Published!", quota.button, keyboard)
                    : { text: `Published! ${left}`, keyboard };
            } else if (result.status === "failed") {
                const released = unlimited ? "" : " Its slot was released.";
                reply = { text: `Your confession couldn’t be published.${released} ${left} You can try again later.` };
            } else {
                const reserved = unlimited ? "" : " Its slot is reserved while the outcome is unresolved.";
                reply = { text: `I couldn’t confirm publication of #${submission.reference}.${reserved} ${left} Check the channel before considering a new submission.` };
            }
        } else {
            reply = action;
        }

        try {
            await sendWithRateLimitRetry(() => ctx.reply(reply.text, { reply_markup: reply.keyboard }), pause);
        } catch (error) {
            const reference = "submission" in action ? ` for ${action.submission.reference}` : "";
            console.warn(`Could not deliver private reply${reference} (${safeError(error)}).`);
        }
    });
}
