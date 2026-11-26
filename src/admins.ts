import type { Api } from "grammy";
import { safeError } from "./publishing.ts";

type TelegramAbortSignal = NonNullable<Parameters<Api["getChatAdministrators"]>[2]>;

export function channelAdminCheck(
    api: Pick<Api, "getChatAdministrators">,
    channelId: number,
    now = Date.now,
): (userId: number) => Promise<boolean> {
    let adminIds = new Set<number>();
    let refreshAt = 0;
    let refresh: Promise<void> | undefined;

    async function refreshAdmins(): Promise<void> {
        try {
            // grammY types this as a polyfill signal but accepts native signals at runtime.
            const signal = AbortSignal.timeout(5000) as unknown as TelegramAbortSignal;
            const members = await api.getChatAdministrators(channelId, {}, signal);
            adminIds = new Set(members.filter(member => !member.user.is_bot).map(member => member.user.id));
            refreshAt = now() + 60_000;
        } catch (error) {
            adminIds.clear();
            refreshAt = now() + 15_000;
            console.warn(`Could not verify channel admins; applying the standard quota (${safeError(error)}).`);
        }
    }

    return async userId => {
        if (now() >= refreshAt) {
            refresh ??= refreshAdmins().finally(() => { refresh = undefined; });
            await refresh;
        }
        return adminIds.has(userId);
    };
}
