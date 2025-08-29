// bot.ts
import "dotenv/config";
import * as ethers from "ethers";
import { createRequire } from "module";
const require = createRequire(import.meta.url);
const TelegramBot = require("node-telegram-bot-api");
const { createZGComputeNetworkBroker } = require("@0glabs/0g-serving-broker");
const BOT_TOKEN = (process.env.BOT_TOKEN || "").trim();
const RPC_URL = process.env.RPC_URL;
const PRIVATE_KEY = process.env.PRIVATE_KEY;
const CHAT_PROVIDER = process.env.CHAT_PROVIDER;
if (!/^\d+:[\w-]+$/.test(BOT_TOKEN))
    throw new Error("BOT_TOKEN invalid");
async function makeBroker() {
    const p = new ethers.JsonRpcProvider(RPC_URL);
    const w = new ethers.Wallet(PRIVATE_KEY, p);
    return createZGComputeNetworkBroker(w);
}
async function getMeta(b, provider) {
    return b.getServiceMetadata ? b.getServiceMetadata(provider) : b.inference.getServiceMetadata(provider);
}
async function ogChat(b, provider, messages) {
    const { endpoint, model } = await getMeta(b, provider);
    await b.inference.acknowledgeProviderSigner(provider);
    const bill = messages.map(m => `${m.role}: ${m.content}`).join("\n").slice(0, 4000);
    const headers = await b.inference.getRequestHeaders(provider, bill);
    const r = await fetch(`${endpoint}/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...headers },
        body: JSON.stringify({ model, messages })
    });
    const j = await r.json();
    const content = j?.choices?.[0]?.message?.content ?? "";
    const chatId = j?.id ?? "";
    await b.inference.processResponse(provider, content, chatId);
    return content;
}
async function main() {
    try {
        await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/deleteWebhook`);
    }
    catch { }
    const bot = new TelegramBot(BOT_TOKEN, { polling: true });
    let brokerPromise = null;
    bot.onText(/^\/start$/, async (ctx) => {
        const id = ctx.chat?.id ?? ctx.message?.chat?.id;
        if (id)
            await bot.sendMessage(id, "My name is Susana — your No.1 Crypto Bot. Ask me anything.");
    });
    bot.on("message", async (msg) => {
        const chatId = msg.chat?.id;
        const text = (msg.text ?? "").trim();
        if (!text || text.startsWith("/"))
            return;
        try {
            brokerPromise = brokerPromise || makeBroker();
            const broker = await brokerPromise;
            const messages = [
                { role: "system", content: "Your name is Susana — your No.1 Crypto Bot. Be friendly, clear, and concise." },
                { role: "user", content: text }
            ];
            const answer = await ogChat(broker, CHAT_PROVIDER, messages);
            await bot.sendMessage(chatId, answer || "No response.");
        }
        catch (e) {
            console.error(e);
            await bot.sendMessage(chatId, "Error reaching the model. Try again.");
        }
    });
    bot.on("polling_error", (e) => console.error("[polling_error]", e));
    console.log("Susana is running with long polling…");
}
void main();
