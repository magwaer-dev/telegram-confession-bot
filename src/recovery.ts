import { existsSync } from "node:fs";
import { ConfigurationError, databasePath, loadEnvironment } from "./config.ts";
import { Storage, type PublicationResult } from "./storage.ts";

function recover(args: string[]): void {
    loadEnvironment();
    const [action, reference, id] = args;
    const listing = action === "list" && args.length === 1;
    const inspecting = action === "inspect" && args.length === 2;
    const messageId = Number(id);
    const validId = id !== undefined && /^\d+$/.test(id) && Number.isSafeInteger(messageId) && messageId > 0;
    if (!listing && (
        !reference || !/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(reference)
        || !(inspecting || (action === "failed" && args.length === 2)
            || (action === "published" && args.length === 3 && validId))
    )) {
        throw new ConfigurationError(
            "Usage: npm run recovery -- list | inspect REFERENCE | published REFERENCE CHANNEL_MESSAGE_ID | failed REFERENCE",
        );
    }

    const path = databasePath(process.env);
    if (!existsSync(path)) throw new ConfigurationError("No database found. Check DATABASE_PATH.");
    const storage = new Storage(path);
    try {
        if (listing) {
            const rows = storage.listUncertain();
            if (rows.length) console.table(rows);
            else console.info("No unresolved publications.");
            return;
        }

        if (inspecting) {
            const submission = storage.inspectSubmission(reference!);
            if (!submission) throw new ConfigurationError("No submission matches that reference.");
            console.info(JSON.stringify(submission, null, 2));
            return;
        }

        const result: PublicationResult = action === "published"
            ? { status: "published", messageId } : { status: "failed" };
        if (!storage.resolve(reference!, result, new Date().toISOString())) {
            throw new ConfigurationError("No unresolved publication matches that reference.");
        }
        console.info(`Recorded ${result.status} for ${reference}.`);
    } finally {
        storage.close();
    }
}

try {
    recover(process.argv.slice(2));
} catch (error) {
    console.error(error instanceof ConfigurationError ? error.message : "Could not access the database. Check DATABASE_PATH and permissions.");
    process.exitCode = 1;
}
