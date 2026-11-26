import { Bot, GrammyError } from "grammy";
import { channelAdminCheck } from "./admins.ts";
import type { Settings } from "./config.ts";
import { commands, registerHandlers } from "./handlers.ts";
import { safeError, sendWithRateLimitRetry } from "./publishing.ts";
import { Storage } from "./storage.ts";

export async function run(
    settings: Settings,
    bot = new Bot(settings.token, { client: { timeoutSeconds: 45, sensitiveLogs: false } }),
): Promise<void> {
    let storage: Storage | undefined;
    let stopping: Promise<void> | undefined;
    let stopRequested = false;
    let phase = "opening the database";
    let advice = "Check DATABASE_PATH and the directory’s write permissions.";

    const stop = () => {
        stopRequested = true;
        stopping ??= bot.stop().catch((error: unknown) => {
            console.warn(`Could not confirm the polling offset (${safeError(error)}).`);
        });
    };

    process.on("SIGINT", stop);
    process.on("SIGTERM", stop);

    try {
        storage = new Storage(settings.databasePath);
        phase = "connecting to Telegram";
        advice = "Check BOT_TOKEN and your network connection.";
        bot.botInfo = await sendWithRateLimitRetry(() => bot.api.getMe());
        if (stopRequested) return;

        phase = "checking the channel";
        advice = "Check CHANNEL_ID and give the bot administrator permission to post in the channel.";
        const channel = await sendWithRateLimitRetry(() => bot.api.getChat(settings.channelId));
        if (channel.type !== "channel") {
            console.error("CHANNEL_ID must point to a Telegram channel.");
            process.exitCode = 1;
            return;
        }
        const member = await sendWithRateLimitRetry(() => bot.api.getChatMember(channel.id, bot.botInfo.id));
        if (member.status !== "administrator" || !member.can_post_messages) {
            console.error(advice);
            process.exitCode = 1;
            return;
        }
        if (stopRequested) return;

        try {
            await sendWithRateLimitRetry(() => bot.api.setMyCommands(commands));
        } catch (error) {
            console.warn(`Could not refresh the Telegram command menu (${safeError(error)}).`);
        }
        if (stopRequested) return;

        registerHandlers(bot, settings, storage, channel, channelAdminCheck(bot.api, channel.id));
        bot.catch(({ error, ctx }) => {
            console.error(`Could not process update ${ctx.update.update_id} (${safeError(error)}).`);
            // A failed storage transaction remains eligible for redelivery if polling stops here.
            throw error;
        });

        const unresolved = storage.listUncertain().length;
        if (unresolved) console.warn(`${unresolved} publication(s) need recovery. Run npm run recovery -- list.`);
        phase = "polling Telegram";
        advice = "Check the preceding errors, then restart the bot.";
        await bot.start({
            allowed_updates: ["message", "callback_query"],
            onStart: () => console.info("Confession bot is running."),
        });
    } catch (error) {
        if (error instanceof GrammyError && error.error_code === 409 && phase === "polling Telegram") {
            advice = "Stop other processes polling with this bot token.";
        }
        console.error(`Bot stopped while ${phase} (${safeError(error)}). ${advice}`);
        process.exitCode = 1;
    } finally {
        await stopping;
        process.off("SIGINT", stop);
        process.off("SIGTERM", stop);
        try {
            storage?.close();
        } catch (error) {
            console.error(`Could not close the database (${safeError(error)}).`);
            process.exitCode = 1;
        }
    }
}
