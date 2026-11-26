import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { Bot, HttpError } from "grammy";

const { readConfig } = await import(process.env.TEST_COMPILED ? "../dist/config.js" : "../src/config.ts");
const { registerHandlers } = await import(process.env.TEST_COMPILED ? "../dist/handlers.js" : "../src/handlers.ts");
const { Storage } = await import(process.env.TEST_COMPILED ? "../dist/storage.js" : "../src/storage.ts");
const { run } = await import(process.env.TEST_COMPILED ? "../dist/bot.js" : "../src/bot.ts");
const { channelAdminCheck } = await import(process.env.TEST_COMPILED ? "../dist/admins.js" : "../src/admins.ts");
const { lookupAuthor } = await import(process.env.TEST_COMPILED ? "../dist/author.js" : "../src/author.ts");

const channel = -1000987654321;
const fakeToken = "1000:MOCK";
const user = { id: 100, first_name: "Hidden Account Name", username: "hidden_handle", is_bot: false };
const day = "2026-11-26";

function fixture(t, env = {}, username) {
    const dir = mkdtempSync(join(tmpdir(), "confession-test-"));
    const path = join(dir, "test.sqlite");
    const config = readConfig({ BOT_TOKEN: fakeToken, CHANNEL_ID: String(channel), DATABASE_PATH: path, ...env });
    const posts = [];
    const replies = [];
    const waits = [];
    let sequence = 0;
    let messageId = 0;
    let time = new Date("2026-11-26T21:59:59Z");
    const stores = new Set();
    t.after(() => {
        for (const store of stores) store.close();
        rmSync(dir, { recursive: true, force: true });
    });

    const control = {
        posts, replies, waits, config,
        channelResponse: undefined,
        replyResponse: undefined,
        now(value) { time = new Date(value); },
        recovery(...args) {
            const script = fileURLToPath(new URL("../src/recovery.ts", import.meta.url));
            return spawnSync(process.execPath, [script, ...args], {
                cwd: dir, env: { ...process.env, DATABASE_PATH: path }, encoding: "utf8", timeout: 5000,
            });
        },
        close(store) {
            store.close();
            stores.delete(store);
        },
        open(isAdmin = async () => false) {
            const storage = new Storage(path);
            stores.add(storage);
            const bot = new Bot(fakeToken, { botInfo: { ...user, id: 1, is_bot: true, username: "MockBot" } });
            bot.api.config.use(async (_previous, method, payload) => {
                if (method === "answerCallbackQuery") return { ok: true, result: true };
                assert.equal(method, "sendMessage");
                if (payload.chat_id === channel) {
                    posts.push(payload);
                    const id = ++messageId;
                    return control.channelResponse
                        ? control.channelResponse(id)
                        : { ok: true, result: { message_id: id } };
                }
                replies.push(payload);
                return control.replyResponse
                    ? control.replyResponse()
                    : { ok: true, result: { message_id: ++messageId } };
            });
            registerHandlers(bot, config, storage, { id: channel, username },
                isAdmin, () => time, async ms => { waits.push(ms); });
            return { storage, handle: update => bot.handleUpdate(update) };
        },
        message(text, from = user, attrs = {}) {
            const id = ++sequence;
            return {
                update_id: id,
                message: {
                    message_id: id, from, chat: { id: from.id, type: "private" }, date: 1, text, ...attrs,
                },
            };
        },
        callback(data, from = user) {
            const id = ++sequence;
            return {
                update_id: id,
                callback_query: {
                    id: String(id), from, data, chat_instance: "test",
                    message: { message_id: id, date: 1, chat: { id: from.id, type: "private" } },
                },
            };
        },
        lastReply() { return replies.at(-1).text; },
        records() {
            const db = new DatabaseSync(path, { readOnly: true });
            try {
                return db.prepare("SELECT * FROM submissions ORDER BY rowid").all();
            } finally {
                db.close();
            }
        },
    };
    return control;
}

const rejection = (code, parameters = {}) => ({ ok: false, error_code: code, description: "Mock rejection", parameters });
const success = id => ({ ok: true, result: { message_id: id } });

test("first-time setup, cancellation, and returning anonymous automatic publishing", async t => {
    const f = fixture(t);
    let { handle, storage } = f.open();
    await handle(f.message("/start"));
    assert.deepEqual(f.replies.at(-1).reply_markup.inline_keyboard[0].map(x => x.text),
        ["Choose a nickname", "Stay anonymous"]);
    assert.match(f.lastReply(), /published immediately.*5 times/);
    await handle(f.message("Before setup"));
    await handle(f.callback("setup:nickname"));
    await handle(f.message("/cancel"));
    await handle(f.message("After cancel, still before setup"));
    assert.equal(f.posts.length, 0);
    await handle(f.callback("setup:anonymous"));
    assert.match(f.lastReply(), /5 posts remaining/);
    f.close(storage);

    ({ handle, storage } = f.open());
    await handle(f.message("A confession containing <html> & *markdown*"));
    assert.equal(f.posts.length, 1);
    const record = f.records()[0];
    assert.equal(f.posts[0].text, "A confession containing <html> & *markdown*\n\n— Anonymous");
    assert.match(record.reference, /^[a-f0-9-]{36}$/);
    assert.equal(f.posts[0].reply_markup, undefined);
    assert.deepEqual(f.posts[0].link_preview_options, { is_disabled: true });
    assert.match(f.lastReply(), /Published! You have 4/);
    assert.equal(record.status, "published");
    assert.ok(record.channel_message_id);
    assert.deepEqual(f.replies.at(-1).reply_markup.inline_keyboard, [[{
        text: "View channel", url: `https://t.me/c/987654321/${record.channel_message_id}`,
    }]]);
    await handle(f.message("/start"));
    assert.match(f.lastReply(), /Publishing as Anonymous.*4 posts/);
    assert.equal(storage.quota(user.id, day).used, 1);
});

test("a configured channel link is shared with successful submitters", async t => {
    const invite = "https://t.me/+example-invite";
    const f = fixture(t, { CHANNEL_URL: invite }, "mock_channel");
    const { handle } = f.open();
    await handle(f.message("/anonymous"));
    await handle(f.message("First post"));
    assert.deepEqual(f.replies.at(-1).reply_markup.inline_keyboard, [[{ text: "View channel", url: invite }]]);
});

test("nickname setup and editing persist across restarts and preserve prior author labels and quota", async t => {
    const f = fixture(t);
    let { handle, storage } = f.open();
    await handle(f.message("/start"));
    await handle(f.callback("setup:nickname"));
    f.close(storage);
    ({ handle, storage } = f.open());
    await handle(f.message("invalid\nname"));
    assert.match(f.lastReply(), /one line/);
    await handle(f.message("Finch & Co"));
    assert.equal(f.posts.length, 0);
    await handle(f.message("First post"));
    assert.match(f.posts[0].text, /— Finch & Co$/);
    await handle(f.message("/nickname"));
    f.close(storage);

    ({ handle, storage } = f.open());
    await handle(f.message("Sparrow"));
    assert.match(f.lastReply(), /4 posts remaining/);
    assert.equal(f.posts.length, 1);
    await handle(f.message("/nickname"));
    await handle(f.message("/cancel"));
    await handle(f.callback("setup:anonymous")); // A button from the original setup.
    await handle(f.message("Another post"));
    assert.match(f.posts[1].text, /— Sparrow$/);
    await handle(f.message("/anonymous"));
    assert.deepEqual({ ...storage.preference(user.id) }, { mode: "anonymous", nickname: "Sparrow", editingNickname: 0 });
    await handle(f.message("Third post"));
    assert.match(f.posts[2].text, /— Anonymous$/);
    assert.deepEqual(f.records().map(record => record.author_label), ["Finch & Co", "Sparrow", "Anonymous"]);
    assert.equal(storage.quota(user.id, day).used, 3);
});

test("a nickname on the command line is saved privately and preserves the allowance", async t => {
    const f = fixture(t);
    const { handle, storage } = f.open();
    await handle(f.message("/nickname   Cedar Studio  "));
    assert.match(f.lastReply(), /5 posts remaining/);
    assert.equal(storage.preference(user.id).nickname, "Cedar Studio");
    assert.equal(f.posts.length, 0);
    await handle(f.message("First confession"));
    assert.match(f.posts[0].text, /— Cedar Studio$/);

    await handle(f.message("/nickname@OtherBot Unchanged"));
    assert.equal(storage.preference(user.id).nickname, "Cedar Studio");
    await handle(f.message("/nickname Invalid\nName"));
    assert.match(f.lastReply(), /one line/);
    assert.equal(storage.preference(user.id).nickname, "Cedar Studio");
    await handle(f.message("/Nickname@MockBot Fox & Co"));
    assert.match(f.lastReply(), /4 posts remaining/);
    assert.equal(f.posts.length, 1);
    await handle(f.message("Second confession"));
    assert.match(f.posts[1].text, /— Fox & Co$/);
    assert.equal(storage.quota(user.id, day).used, 2);
});

test("a new nickname can only be claimed by one account and stays reserved after a rename", async t => {
    const f = fixture(t);
    const owner = f.open();
    const challenger = f.open();
    const other = { ...user, id: 200 };
    await Promise.all([
        owner.handle(f.message("/nickname River Fox")),
        challenger.handle(f.message("/nickname ＲＩＶＥＲ　ＦＯＸ", other)),
    ]);
    assert.equal(owner.storage.preference(user.id).nickname, "River Fox");
    assert.equal(challenger.storage.preference(other.id).nickname, null);
    assert.match(f.lastReply(), /already taken or reserved/);
    await owner.handle(f.message("/nickname New Name"));
    await owner.handle(f.message("/anonymous"));
    await challenger.handle(f.message("/nickname", other));
    await challenger.handle(f.message("River  Fox", other));
    assert.match(f.lastReply(), /already taken or reserved/);
    await challenger.handle(f.message("AnOnYmOuS", other));
    assert.match(f.lastReply(), /already taken or reserved/);
    assert.equal(challenger.storage.preference(other.id).editingNickname, 1);
    assert.equal(f.posts.length, 0);
});

test("nickname variants with added spaces, symbols and look-alike letters stay reserved", async t => {
    const f = fixture(t);
    const { handle, storage } = f.open();
    const other = { ...user, id: 200 };
    await handle(f.message("/nickname Foxtrail-dev"));
    for (const attempt of [
        "F o x t r a i l - d e v",
        "Foxtrail--dev",
        "Foxtrail™-dev⚡",
        "Fóxtrail-dev",
        "F\u043Extrail-d\u0435v",
        "Foxtrail\u200B-dev",
        "An0nymous",
    ]) {
        await handle(f.message(`/nickname ${attempt}`, other));
        assert.match(f.lastReply(), /already taken or reserved/);
        assert.equal(storage.preference(other.id).nickname, null);
    }
    await handle(f.message("/nickname Foxtrail-fox", other));
    assert.equal(storage.preference(other.id).nickname, "Foxtrail-fox");
    assert.equal(f.posts.length, 0);
});

test("the earliest confirmed author keeps a newly conflicting nickname after an upgrade", async t => {
    const f = fixture(t);
    const other = { ...user, id: 200 };
    f.close(f.open().storage);
    const db = new DatabaseSync(f.config.databasePath);
    try {
        db.exec("PRAGMA user_version = 1");
        db.prepare("INSERT INTO users (user_id, mode) VALUES (?, 'anonymous')").run(user.id);
        db.prepare("INSERT INTO users (user_id, mode, nickname) VALUES (?, 'nickname', ?)").run(other.id, "Foxtrail..dev");
        const claim = db.prepare("INSERT INTO nickname_claims (nickname_key, user_id) VALUES (?, ?)");
        claim.run("foxtrail..dev", other.id);
        claim.run("foxtrail-dev", user.id);
        claim.run("unused reserved", user.id);
        const insert = db.prepare(`
            INSERT INTO submissions (reference, user_id, quota_day, confession, author_label, channel_id,
                status, accepted_at, resolved_at, channel_message_id)
            VALUES (?, ?, '2026-11-24', 'Legacy post', ?, ?, ?, ?, ?, ?)
        `);
        insert.run("later", other.id, "FOXTRAIL..DEV", channel, "published",
            "2026-11-24T15:00:00Z", "2026-11-24T15:00:01Z", 50);
        insert.run("first", user.id, "Foxtrail-dev", channel, "published",
            "2026-11-24T13:00:00Z", "2026-11-24T13:00:01Z", 49);
        insert.run("failed", user.id, "Free Name", channel, "failed",
            "2026-11-24T12:00:00Z", "2026-11-24T12:00:01Z", null);
    } finally {
        db.close();
    }

    let { handle, storage } = f.open();
    await handle(f.message("Would publish under the conflicting saved name", other));
    assert.match(f.lastReply(), /saved nickname is already taken/);
    assert.equal(storage.quota(other.id, day).used, 0);
    await handle(f.message("/nickname FOXTRAIL – DEV", other));
    assert.match(f.lastReply(), /already taken or reserved/);
    await handle(f.message("/nickname Unused--Reserved", other));
    assert.match(f.lastReply(), /already taken or reserved/);
    await handle(f.message("/nickname Free Name", other));
    assert.equal(storage.preference(other.id).nickname, "Free Name");
    assert.equal(f.posts.length, 0);
    f.close(storage);

    ({ handle, storage } = f.open());
    await handle(f.message("/nickname Foxtrail-dev"));
    await handle(f.message("The original author can still post"));
    assert.match(f.posts[0].text, /— Foxtrail-dev$/);
    assert.equal(storage.quota(user.id, day).used, 1);
});

test("channel posts use plain text with a blank line before the signature", async t => {
    const f = fixture(t);
    const { handle } = f.open();
    await handle(f.message("/nickname Real Author"));
    await handle(f.message("😀 A confession\nA second line"));
    const post = f.posts[0];
    assert.equal(post.text, "😀 A confession\nA second line\n\n— Real Author");
    assert.equal(post.entities, undefined);
    assert.equal(post.parse_mode, undefined);
});

test("commands, non-private updates, edits, media, and invalid text stay out of the channel", async t => {
    const f = fixture(t);
    const { handle, storage } = f.open();
    await handle(f.message("/anonymous@MockBot"));
    for (const command of ["/start", "/help", "/confess", "/test", "/unknown", "/anonymous@OtherBot"]) {
        await handle(f.message(command));
    }
    const { update_id, message } = f.message("original edit");
    await handle({ update_id, edited_message: message });
    await handle(f.message("group message", user, { chat: { id: -2, type: "group", title: "Group" } }));
    await handle(f.message(undefined, user, { photo: [], caption: "A media caption" }));
    assert.match(f.lastReply(), /accepts ordinary text/);
    await handle(f.message(" \n \u200b"));
    assert.match(f.lastReply(), /some text/);
    await handle(f.message("a".repeat(4001)));
    assert.match(f.lastReply(), /too long/);

    assert.equal(f.posts.length, 0);
    assert.equal(storage.quota(user.id, day).used, 0);
    await handle(f.message("/nickname"));
    await handle(f.message("x".repeat(32)));
    await handle(f.message("a".repeat(4000)));
    assert.equal(f.posts.length, 1);
    assert.ok(f.posts[0].text.length <= 4096);
});

test("a sixth post is blocked across a restart and the allowance renews at Chisinau midnight", async t => {
    const f = fixture(t);
    let { handle, storage } = f.open();
    await handle(f.message("/anonymous"));
    for (let i = 0; i < 5; i++) await handle(f.message(`Post ${i + 1}`));
    assert.match(f.lastReply(), /0\/5 posts remaining/);
    f.close(storage);

    ({ handle, storage } = f.open());
    const blocked = f.message("Blocked post");
    await handle(blocked);
    assert.match(f.lastReply(), /all five.*midnight \(Europe\/Chisinau\)/);
    assert.equal(f.records().length, 5);
    const other = { ...user, id: 200 };
    await handle(f.message("/anonymous", other));
    await handle(f.message("Different user", other));
    assert.equal(storage.quota(other.id, day).used, 1);
    f.close(storage);

    f.now("2026-11-26T22:00:00Z");
    ({ handle, storage } = f.open());
    await handle(blocked);
    await handle(f.message("The next day"));
    assert.equal(f.posts.length, 7);
    assert.equal(storage.quota(user.id, day).used, 5);
    assert.equal(storage.quota(user.id, "2026-11-27").used, 1);
    assert.match(f.lastReply(), /4 posts remaining/);
});

test("the hidden Please button and typed request reset a fully used allowance", async t => {
    const f = fixture(t);
    const adminLookup = async () => { throw new Error("Admin verification should be disabled"); };
    let { handle, storage } = f.open(adminLookup);
    await handle(f.message("/help"));
    assert.doesNotMatch(f.lastReply(), /please|reset|admins have unlimited/i);
    await handle(f.message("/anonymous"));
    assert.match(f.lastReply(), /5 posts remaining/);
    await handle(f.message("please"));
    assert.doesNotMatch(f.lastReply(), /please|reset/i);
    assert.equal(f.posts.length, 0);
    for (let i = 1; i <= 4; i++) {
        await handle(f.message(`Post ${i}`));
        assert.deepEqual(f.replies.at(-1).reply_markup.inline_keyboard.map(row => row.map(button => button.text)),
            [["View channel"]]);
    }
    await handle(f.message("Post 5"));
    assert.match(f.lastReply(), /Published!.*0\/5 posts remaining.*say “please”/is);
    const rows = f.replies.at(-1).reply_markup.inline_keyboard;
    assert.equal(rows[0][0].text, "View channel");
    assert.equal(rows[1][0].text, "Please");
    const button = rows[1][0].callback_data;
    f.close(storage);

    ({ handle, storage } = f.open(adminLookup));
    const tap = f.callback(button);
    await handle(tap);
    assert.match(f.lastReply(), /Allowance reset!.*5\/5/);
    await handle(tap);
    assert.deepEqual({ ...storage.quota(user.id, day) }, { used: 5, published: 5, bonus: 5 });
    for (let i = 6; i <= 10; i++) await handle(f.message(`Post ${i}`));
    const nextButton = f.replies.at(-1).reply_markup.inline_keyboard[1][0].callback_data;
    assert.notEqual(nextButton, button);
    await handle(f.callback(button));
    assert.match(f.lastReply(), /expired/);
    await handle(f.message(" Please "));
    assert.match(f.lastReply(), /Allowance reset!.*5\/5/);
    assert.equal(f.posts.length, 10);
    assert.deepEqual({ ...storage.quota(user.id, day) }, { used: 10, published: 10, bonus: 10 });

    f.now("2026-11-26T22:00:00Z");
    await handle(f.callback(nextButton));
    assert.match(f.lastReply(), /expired/);
    await handle(f.message("/start"));
    assert.match(f.lastReply(), /5 posts remaining/);
    assert.equal(storage.quota(user.id, "2026-11-27").bonus, 0);
});

test("concurrent updates use one reservation each even while channel sends are pending", async t => {
    const f = fixture(t);
    const { handle, storage } = f.open();
    const second = f.open();
    await handle(f.message("/anonymous"));
    const gate = Promise.withResolvers();
    const started = Promise.withResolvers();
    f.channelResponse = async id => {
        if (f.posts.length === 5) started.resolve();
        await gate.promise;
        return success(id);
    };
    const updates = Array.from({ length: 6 }, (_, index) => f.message(`Concurrent ${index}`));
    const pending = updates.map((update, index) => (index % 2 ? second.handle : handle)(update));
    try {
        await Promise.race([started.promise, Promise.all(pending)]);
        await second.handle(updates[0]);
        assert.equal(f.posts.length, 5);
        assert.equal(storage.quota(user.id, day).used, 5);
        assert.equal(storage.listUncertain().length, 5);
        assert.ok(f.replies.some(reply => reply.text.includes("all five")));
        await second.handle(f.message("please"));
        assert.doesNotMatch(f.lastReply(), /reset/i);
        assert.equal(storage.quota(user.id, day).bonus, 0);
    } finally {
        gate.resolve();
        await Promise.all(pending);
    }
    assert.equal(new Set(f.records().map(r => r.reference)).size, 5);
    assert.equal(storage.listUncertain().length, 0);
});

test("Telegram rejection releases a slot; a flood-control rejection can be retried safely", async t => {
    const f = fixture(t, { DAILY_POST_LIMIT: "1" });
    const { handle, storage } = f.open();
    await handle(f.message("/anonymous"));
    f.channelResponse = () => rejection(403);
    await handle(f.message("Definite rejection"));
    assert.match(f.lastReply(), /slot was released/);
    assert.equal(f.replies.at(-1).reply_markup, undefined);
    assert.equal(f.records()[0].status, "failed");
    assert.equal(storage.quota(user.id, day).used, 0);
    f.channelResponse = id => f.posts.length === 2 ? rejection(429, { retry_after: 2 }) : success(id);
    await handle(f.message("Retry after rate limit"));
    assert.deepEqual(f.waits, [2000]);
    assert.equal(f.posts[1].text, f.posts[2].text);
    assert.equal(f.records().length, 2);
    assert.equal(storage.quota(user.id, day).used, 1);
    assert.match(f.lastReply(), /Published!/);
});

test("an uncertain send survives restart and recovery preserves the original quota date", async t => {
    const f = fixture(t, { DAILY_POST_LIMIT: "1" });
    let { handle, storage } = f.open();
    await handle(f.message("/anonymous"));
    f.channelResponse = () => {
        f.now("2026-11-26T22:00:00Z");
        throw new HttpError("Mock response lost", {});
    };
    const update = f.message("Uncertain result");
    await handle(update);
    const [record] = f.records();
    assert.match(f.lastReply(), /couldn’t confirm publication/);
    assert.equal(record.status, "uncertain");
    assert.equal(record.quota_day, day);
    assert.equal(record.resolved_at, null);
    f.close(storage);

    ({ handle, storage } = f.open());
    await handle(update);
    assert.equal(f.posts.length, 1);
    assert.equal(storage.listUncertain().length, 1);
    assert.equal(storage.quota(user.id, day).used, 1);
    assert.equal(storage.quota(user.id, "2026-11-27").used, 0);
    assert.equal(storage.resolve(record.reference, { status: "published", messageId: 42 }, "2026-11-27T02:00:00Z"), true);
    assert.equal(storage.resolve(record.reference, { status: "failed" }, "2026-11-27T02:00:00Z"), false);
    assert.equal(f.records()[0].channel_message_id, 42);
    assert.equal(storage.quota(user.id, day).used, 1);
});

test("private acknowledgement failure cannot undo or repeat a successful channel post", async t => {
    const f = fixture(t, { DAILY_POST_LIMIT: "1" });
    let { handle, storage } = f.open();
    await handle(f.message("/anonymous"));
    f.replyResponse = () => rejection(403);
    const update = f.message("Publish despite an acknowledgement failure");
    await handle(update);
    assert.equal(f.records()[0].status, "published");
    assert.equal(storage.quota(user.id, day).used, 1);
    f.close(storage);
    ({ handle, storage } = f.open());
    f.replyResponse = undefined;
    await handle(update);
    await handle({ ...update, update_id: 999 });
    assert.equal(f.posts.length, 1);
    await handle(f.message("Over quota"));
    assert.match(f.lastReply(), /allowance renews/);
    assert.equal(storage.quota(user.id, day).used, 1);
});

test("recovery can record a verified failure and release its original reservation", async t => {
    const f = fixture(t, { DAILY_POST_LIMIT: "1" });
    let { handle, storage } = f.open();
    await handle(f.message("/anonymous"));
    f.channelResponse = () => rejection(502);
    await handle(f.message("Private recovery test confession"));
    const [record] = f.records();
    assert.equal(record.status, "uncertain");
    assert.equal(storage.quota(user.id, day).used, 1);
    f.close(storage);

    const list = f.recovery("list");
    assert.equal(list.status, 0, list.stderr);
    assert.ok(list.stdout.includes(record.reference));
    assert.ok(!list.stdout.includes(record.confession));
    const inspect = f.recovery("inspect", record.reference);
    assert.equal(inspect.status, 0, inspect.stderr);
    const details = JSON.parse(inspect.stdout);
    assert.equal(details.confession, record.confession);
    assert.equal(details.author_label, "Anonymous");
    assert.equal(details.accepted_at, record.accepted_at);
    assert.equal(details.channel_id, channel);
    assert.equal(details.channel_message_id, null);
    assert.ok(!("user_id" in details));
    const resolve = f.recovery("failed", record.reference);
    assert.equal(resolve.status, 0, resolve.stderr);
    ({ storage } = f.open());
    assert.equal(storage.quota(user.id, day).used, 0);
    assert.equal(f.records()[0].status, "failed");
    assert.equal(f.posts.length, 1);
});

test("editing a channel post leaves its internal reference, message ID and used allowance intact", async t => {
    const f = fixture(t);
    const { handle, storage } = f.open();
    await handle(f.message("/anonymous"));
    await handle(f.message("A confession to edit"));
    const [record] = f.records();
    await handle({
        update_id: 3,
        edited_channel_post: {
            message_id: record.channel_message_id,
            chat: { id: channel, type: "channel" },
            date: 1,
            edit_date: 2,
            text: "A confession to edit\n\n— Anonymous",
        },
    });
    assert.equal(f.posts.length, 1);
    assert.equal(storage.quota(user.id, day).used, 1);
    const inspect = f.recovery("inspect", record.reference);
    assert.equal(inspect.status, 0, inspect.stderr);
    const details = JSON.parse(inspect.stdout);
    assert.equal(details.status, "published");
    assert.equal(details.channel_message_id, record.channel_message_id);
});

test("author lookup accepts a full post link and matches both channel and message ID", async t => {
    const f = fixture(t);
    const { handle } = f.open();
    await handle(f.message("/anonymous"));
    await handle(f.message("A confession to look up"));
    const [record] = f.records();
    const messageId = record.channel_message_id;
    const path = f.config.databasePath;
    const calls = [];
    const api = {
        async getChat(id) {
            calls.push(id);
            if (id === "@mock_channel") return { id: channel, type: "channel" };
            if (id === user.id) return { type: "private", ...user };
            throw new Error("Mock profile lookup failed");
        },
    };
    const publicLink = `https://t.me/mock_channel/${messageId}`;
    const author = await lookupAuthor(publicLink, path, api);
    assert.deepEqual(calls, ["@mock_channel", user.id]);
    assert.deepEqual(author, {
        userId: user.id, postedAs: "Anonymous", username: "@hidden_handle", displayName: user.first_name,
    });

    const privateLink = `https://t.me/c/987654321/${messageId}?single`;
    const hidden = await lookupAuthor(privateLink, path, {
        async getChat(id) {
            assert.equal(id, user.id);
            throw new Error("Mock private profile unavailable");
        },
    });
    assert.equal(hidden.userId, user.id);
    assert.equal(hidden.username, null);
    await assert.rejects(lookupAuthor(`https://t.me/c/987654322/${messageId}`, path, api), /No published submission/);
    await assert.rejects(lookupAuthor("https://t.me.example.com/mock_channel/1", path, api), /Paste the full/);
    assert.deepEqual(calls, ["@mock_channel", user.id]);
});

test("the running bot exempts the channel owner and admins while enforcing the ordinary quota", async t => {
    const f = fixture(t, { ADMIN_UNLIMITED_POSTS: "true" });
    const bot = new Bot(fakeToken);
    const methods = [];
    const owner = { ...user, id: 200, username: undefined };
    const admin = { ...user, id: 300, username: "mock_admin" };
    const ordinary = { ...user, username: admin.username };
    const updates = [owner, admin, ordinary].flatMap(sender => [
        f.message("/anonymous", sender),
        f.message("/start", sender),
        ...Array.from({ length: 6 }, (_, i) => f.message(`Post ${i + 1}`, sender)),
    ]);
    const outbound = [];
    bot.api.config.use(async (_previous, method, payload) => {
        methods.push(method);
        switch (method) {
            case "getMe":
                return { ok: true, result: { id: 1, is_bot: true, first_name: "Mock", username: "MockBot" } };
            case "getChat":
                return { ok: true, result: { id: channel, type: "channel", active_usernames: ["mock_channel"] } };
            case "getChatMember":
                return { ok: true, result: { status: "administrator", can_post_messages: true } };
            case "getChatAdministrators":
                assert.equal(payload.chat_id, channel);
                return { ok: true, result: [
                    { status: "creator", user: owner },
                    { status: "administrator", user: admin },
                ] };
            case "setMyCommands":
            case "deleteWebhook":
                return { ok: true, result: true };
            case "getUpdates": {
                if (payload.offset === 1) return { ok: true, result: updates };
                if (payload.limit !== 1) process.emit("SIGINT");
                return { ok: true, result: [] };
            }
            case "sendMessage":
                outbound.push(payload);
                return success(outbound.length + 122);
            default:
                throw new Error(`Unexpected mock method ${method}`);
        }
    });
    await run(f.config, bot);
    assert.equal(bot.isRunning(), false);
    assert.deepEqual(methods.slice(0, 5), ["getMe", "getChat", "getChatMember", "setMyCommands", "deleteWebhook"]);
    assert.equal(methods.filter(method => method === "getChatAdministrators").length, 1);
    const records = f.records();
    assert.equal(records.filter(record => record.user_id === owner.id).length, 6);
    assert.equal(records.filter(record => record.user_id === admin.id).length, 6);
    assert.equal(records.filter(record => record.user_id === ordinary.id).length, 5);
    assert.ok(records.every(record => record.status === "published" && record.channel_message_id > 0));
    for (const sender of [owner, admin]) {
        const replies = outbound.filter(payload => payload.chat_id === sender.id);
        assert.match(replies[1].text, /no daily posting limit/);
        assert.match(replies.at(-1).text, /Published! You have no daily posting limit/);
    }
    assert.match(outbound.at(-1).text, /all five/);
    assert.deepEqual(outbound.find(payload => /^Published!/.test(payload.text)).reply_markup.inline_keyboard, [[{
        text: "View channel", url: "https://t.me/mock_channel",
    }]]);
});

test("admin verification refreshes and falls back to the standard quota when Telegram is unavailable", async () => {
    let time = 0;
    let requests = 0;
    let roster = [{ status: "creator", user }];
    let unavailable = false;
    const check = channelAdminCheck({
        async getChatAdministrators() {
            requests++;
            if (unavailable) throw new HttpError("Mock timeout", {});
            return roster;
        },
    }, channel, () => time);
    assert.deepEqual(await Promise.all([check(user.id), check(200)]), [true, false]);
    assert.equal(requests, 1);
    time = 60_000;
    unavailable = true;
    assert.equal(await check(user.id), false);
    assert.equal(await check(user.id), false);
    assert.equal(requests, 2);
    time += 15_000;
    unavailable = false;
    roster = [];
    assert.equal(await check(user.id), false);
    assert.equal(requests, 3);
});

test("configuration rejects invalid or unsafe settings without echoing secret values", () => {
    const base = { BOT_TOKEN: fakeToken, CHANNEL_ID: String(channel) };
    assert.throws(() => readConfig({ ...base, BOT_TOKEN: "invalid-sensitive-value" }), /^Error: Set BOT_TOKEN/);
    assert.throws(() => readConfig({ ...base, CHANNEL_ID: "12345" }), /Set CHANNEL_ID/);
    assert.throws(() => readConfig({ ...base, CHANNEL_URL: "https://t.me.example.com/mock" }), /CHANNEL_URL/);
    assert.throws(() => readConfig({ ...base, BOT_TIMEZONE: "Unknown" }), /IANA timezone/);
    assert.throws(() => readConfig({ ...base, DAILY_POST_LIMIT: "6" }), /from 1 to 5/);
    assert.throws(() => readConfig({ ...base, ADMIN_UNLIMITED_POSTS: "yes" }), /true or false/);
    assert.equal(readConfig(base).adminUnlimitedPosts, false);
    assert.equal(readConfig(base).timezone, "Europe/Chisinau");
});
