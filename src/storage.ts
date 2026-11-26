import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { rectifyConfusion } from "@ensdomains/unicode-confusables";

export type Preference = {
    mode: "anonymous" | "nickname" | null;
    nickname: string | null;
    editingNickname: 0 | 1;
};

export type Submission = {
    reference: string;
    userId: number;
    day: string;
    text: string;
    label: string;
    channelId: number;
    acceptedAt: string;
};

export type PublicationResult =
    | { status: "published"; messageId: number }
    | { status: "failed" };

function nicknameKey(nickname: string): string {
    const visible = nickname.replace(/\p{Default_Ignorable_Code_Point}/gu, "");
    const alphanumeric = visible.replace(/[^\p{L}\p{N}\p{M}]/gu, "")
        .normalize("NFKD").toUpperCase().toLowerCase()
        .replace(/[^\p{L}\p{N}]/gu, "");
    return alphanumeric
        ? rectifyConfusion(alphanumeric).toLowerCase().normalize("NFC")
        : visible.normalize("NFC").replace(/[\p{White_Space}\p{Emoji_Modifier}]/gu, "");
}

const anonymousNickname = nicknameKey("Anonymous");

const insertNicknameClaim = `
    INSERT INTO nickname_claims (nickname_key, user_id) VALUES (?, ?)
    ON CONFLICT (nickname_key) DO NOTHING
`;

export class Storage {
    private readonly db: DatabaseSync;

    constructor(path: string) {
        if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
        this.db = new DatabaseSync(path, { timeout: 5000 });
        try {
            this.db.exec(`
                PRAGMA journal_mode = WAL;
                PRAGMA synchronous = FULL;
                CREATE TABLE IF NOT EXISTS users (
                    user_id INTEGER PRIMARY KEY,
                    mode TEXT CHECK (mode IN ('anonymous', 'nickname')),
                    nickname TEXT,
                    editing_nickname INTEGER NOT NULL DEFAULT 0 CHECK (editing_nickname IN (0, 1)),
                    CHECK (mode IS NOT 'nickname' OR nickname IS NOT NULL)
                ) STRICT;
                CREATE TABLE IF NOT EXISTS processed_updates (
                    user_id INTEGER NOT NULL REFERENCES users(user_id),
                    event_key TEXT NOT NULL,
                    update_id INTEGER NOT NULL,
                    PRIMARY KEY (user_id, event_key)
                ) STRICT;
                CREATE TABLE IF NOT EXISTS submissions (
                    reference TEXT PRIMARY KEY,
                    user_id INTEGER NOT NULL REFERENCES users(user_id),
                    quota_day TEXT NOT NULL,
                    confession TEXT NOT NULL,
                    author_label TEXT NOT NULL,
                    channel_id INTEGER NOT NULL,
                    status TEXT NOT NULL DEFAULT 'uncertain' CHECK (status IN ('uncertain', 'published', 'failed')),
                    accepted_at TEXT NOT NULL,
                    resolved_at TEXT,
                    channel_message_id INTEGER,
                    CHECK ((status = 'published') = (channel_message_id IS NOT NULL)),
                    CHECK ((status = 'uncertain') = (resolved_at IS NULL))
                ) STRICT;
                CREATE INDEX IF NOT EXISTS submissions_quota
                    ON submissions (user_id, quota_day) WHERE status <> 'failed';
                CREATE TABLE IF NOT EXISTS quota_resets (
                    user_id INTEGER NOT NULL REFERENCES users(user_id),
                    quota_day TEXT NOT NULL,
                    bonus_slots INTEGER NOT NULL CHECK (bonus_slots > 0),
                    PRIMARY KEY (user_id, quota_day)
                ) STRICT;
                CREATE TABLE IF NOT EXISTS nickname_claims (
                    nickname_key TEXT PRIMARY KEY,
                    user_id INTEGER NOT NULL REFERENCES users(user_id)
                ) STRICT;
            `);
            this.migrateNicknameClaims();
        } catch (error) {
            this.db.close();
            throw error;
        }
    }

    close(): void {
        this.db.close();
    }

    private migrateNicknameClaims(): void {
        this.db.exec("BEGIN IMMEDIATE");
        try {
            const version = this.db.prepare("PRAGMA user_version").get()?.user_version;
            if (version === 0 || version === 1) {
                const previousClaims = this.db.prepare(`
                    SELECT nickname_key, user_id FROM nickname_claims ORDER BY rowid
                `).all() as { nickname_key: string; user_id: number }[];
                this.db.exec("DELETE FROM nickname_claims");

                const insert = this.db.prepare(insertNicknameClaim);
                const posts = this.db.prepare(`
                    SELECT user_id, author_label FROM submissions
                    WHERE status = 'published' AND author_label <> 'Anonymous'
                    ORDER BY accepted_at, rowid
                `).iterate() as Iterable<{ user_id: number; author_label: string }>;
                for (const post of posts) {
                    const key = nicknameKey(post.author_label);
                    if (key && key !== anonymousNickname) insert.run(key, post.user_id);
                }
                // Keep names that were reserved before they appeared in a confirmed post.
                for (const claim of previousClaims) {
                    const key = nicknameKey(claim.nickname_key);
                    if (key && key !== anonymousNickname) insert.run(key, claim.user_id);
                }
                this.db.exec("PRAGMA user_version = 2");
            }
            this.db.exec("COMMIT");
        } catch (error) {
            this.db.exec("ROLLBACK");
            throw error;
        }
    }

    handleUpdate<T>(userId: number, eventKey: string, updateId: number, handle: () => T): T | undefined {
        this.db.exec("BEGIN IMMEDIATE");
        try {
            this.db.prepare("INSERT INTO users (user_id) VALUES (?) ON CONFLICT DO NOTHING").run(userId);
            const { changes } = this.db.prepare(`
                INSERT INTO processed_updates (user_id, event_key, update_id)
                VALUES (?, ?, ?) ON CONFLICT DO NOTHING
            `).run(userId, eventKey, updateId);
            const result = changes ? handle() : undefined;
            this.db.exec("COMMIT");
            return result;
        } catch (error) {
            this.db.exec("ROLLBACK");
            throw error;
        }
    }

    preference(userId: number): Preference {
        return this.db.prepare(`
            SELECT mode, nickname, editing_nickname AS editingNickname FROM users WHERE user_id = ?
        `).get(userId) as Preference;
    }

    setPreference(userId: number, preference: Preference): void {
        this.db.prepare(`
            UPDATE users SET mode = ?, nickname = ?, editing_nickname = ? WHERE user_id = ?
        `).run(preference.mode, preference.nickname, preference.editingNickname, userId);
    }

    // Called inside handleUpdate's write transaction when saving or using a nickname.
    claimNickname(userId: number, nickname: string): boolean {
        const key = nicknameKey(nickname);
        if (!key || key === anonymousNickname) return false;
        const { changes } = this.db.prepare(insertNicknameClaim).run(key, userId);
        return changes === 1
            || this.db.prepare("SELECT user_id FROM nickname_claims WHERE nickname_key = ?").get(key)?.user_id === userId;
    }

    quota(userId: number, day: string) {
        return this.db.prepare(`
            SELECT count(*) AS used, count(*) FILTER (WHERE status = 'published') AS published,
                coalesce((SELECT bonus_slots FROM quota_resets WHERE user_id = ? AND quota_day = ?), 0) AS bonus
            FROM submissions WHERE user_id = ? AND quota_day = ? AND status <> 'failed'
        `).get(userId, day, userId, day) as { used: number; published: number; bonus: number };
    }

    // The caller verifies exhaustion inside handleUpdate before resetting the allowance.
    resetQuota(userId: number, day: string, used: number): void {
        this.db.prepare(`
            INSERT INTO quota_resets (user_id, quota_day, bonus_slots) VALUES (?, ?, ?)
            ON CONFLICT (user_id, quota_day) DO UPDATE SET bonus_slots = excluded.bonus_slots
        `).run(userId, day, used);
    }

    // Called inside handleUpdate's write transaction, after validation and the quota check.
    reserve(submission: Submission): void {
        this.db.prepare(`
            INSERT INTO submissions (reference, user_id, quota_day, confession, author_label, channel_id, accepted_at)
            VALUES (?, ?, ?, ?, ?, ?, ?)
        `).run(submission.reference, submission.userId, submission.day, submission.text,
            submission.label, submission.channelId, submission.acceptedAt);
    }

    resolve(reference: string, result: PublicationResult, timestamp: string): boolean {
        return this.db.prepare(`
            UPDATE submissions SET status = ?, channel_message_id = ?, resolved_at = ?
            WHERE reference = ? AND status = 'uncertain'
        `).run(result.status, result.status === "published" ? result.messageId : null, timestamp, reference).changes === 1;
    }

    inspectSubmission(reference: string) {
        return this.db.prepare(`
            SELECT reference, status, quota_day, accepted_at, channel_id, channel_message_id, author_label, confession
            FROM submissions WHERE reference = ?
        `).get(reference);
    }

    listUncertain() {
        return this.db.prepare(`
            SELECT reference, quota_day, accepted_at, channel_id FROM submissions
            WHERE status = 'uncertain' ORDER BY accepted_at
        `).all();
    }
}
