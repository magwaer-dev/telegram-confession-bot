import { Telegraf } from "telegraf";
import * as dotenv from "dotenv";
dotenv.config();

const BOT_TOKEN = process.env.BOT_TOKEN!;
const CONFESSION_CHAT_ID = Number(process.env.CONFESSION_CHAT_ID);

const bot = new Telegraf(BOT_TOKEN);

bot.command("start", (ctx) => {
  ctx.reply('Hi motherfucker.')
});

bot.launch();
console.log("Bot is running...");
