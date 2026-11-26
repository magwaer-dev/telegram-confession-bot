import { ConfigurationError, loadEnvironment, readConfig } from "./config.ts";

try {
    loadEnvironment();
    const settings = readConfig(process.env);
    // grammY's error debug namespace can include raw transport errors.
    process.env.DEBUG = `${process.env.DEBUG ?? ""},-grammy:error`;
    const { run } = await import("./bot.ts");
    await run(settings);
} catch (error) {
    console.error(error instanceof ConfigurationError ? error.message : "The bot stopped during startup.");
    process.exitCode = 1;
}
