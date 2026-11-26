import { setTimeout as wait } from "node:timers/promises";
import { GrammyError, HttpError } from "grammy";
import type { Settings } from "./config.ts";
import type { PublicationResult, Submission } from "./storage.ts";

export const TELEGRAM_MESSAGE_LIMIT = 4096;

export function localDay(calendar: Settings["calendar"], time: Date): string {
    const parts = Object.fromEntries(calendar.formatToParts(time).map(part => [part.type, part.value]));
    return `${parts.year}-${parts.month}-${parts.day}`;
}

export function channelText({ text, label }: Submission): string {
    return `${text}\n\n— ${label}`;
}

export function safeError(error: unknown): string {
    if (error instanceof GrammyError) return `Telegram API error ${error.error_code}`;
    if (error instanceof HttpError) return "Telegram transport error";
    const code = (error as NodeJS.ErrnoException | undefined)?.code;
    if (typeof code === "string" && /^(ERR_SQLITE_ERROR|SQLITE_[A-Z_]+|EACCES|EPERM|ENOENT|ENOSPC|EBUSY)$/.test(code)) {
        return code;
    }
    return "unexpected error";
}

export async function sendWithRateLimitRetry<T>(
    send: () => Promise<T>,
    pause: (ms: number) => Promise<unknown> = wait,
): Promise<T> {
    let waitBudget = 30;
    for (let retries = 0; ; retries++) {
        try {
            return await send();
        } catch (error) {
            const delay = error instanceof GrammyError && error.error_code === 429 ? error.parameters.retry_after : undefined;
            if (!delay || !Number.isInteger(delay) || delay < 1 || delay > waitBudget || retries >= 2) throw error;
            waitBudget -= delay;
            await pause(delay * 1000);
        }
    }
}

export async function publish(
    submission: Submission,
    send: () => Promise<{ message_id: number }>,
    pause?: (ms: number) => Promise<unknown>,
): Promise<PublicationResult | { status: "uncertain" }> {
    try {
        const message = await sendWithRateLimitRetry(send, pause);
        if (!Number.isSafeInteger(message.message_id) || message.message_id < 1) {
            console.error(`Publication uncertain for ${submission.reference} (no usable channel message ID).`);
            return { status: "uncertain" };
        }
        return { status: "published", messageId: message.message_id };
    } catch (error) {
        const definite = error instanceof GrammyError && error.error_code >= 400
            && error.error_code < 500 && error.error_code !== 408;
        const status = definite ? "failed" : "uncertain";
        console.error(`Publication ${status} for ${submission.reference} (${safeError(error)}).`);
        return { status };
    }
}
