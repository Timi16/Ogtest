import "dotenv/config";
import * as ethers from "ethers";
import TelegramBot from "node-telegram-bot-api";
import { pipeline } from "@xenova/transformers";
const BOT_TOKEN = (process.env.BOT_TOKEN || "").trim();
const RPC_URL = process.env.RPC_URL;
const PRIVATE_KEY = process.env.PRIVATE_KEY;
const CHAT_PROVIDER = process.env.CHAT_PROVIDER;
const isTrivialGreeting = (t) => /^(hi|hello|hey|yo|gm|gn|good (morning|afternoon|evening)|how (are|r) (you|u))/i.test(t);
async function makeBroker() {
    const { createZGComputeNetworkBroker } = await import("@0glabs/0g-serving-broker");
    const provider = new ethers.JsonRpcProvider(process.env.RPC_URL);
    const wallet = new ethers.Wallet(process.env.PRIVATE_KEY, provider);
    return createZGComputeNetworkBroker(wallet);
}
function toBigIntSafe(v) {
    try {
        if (v == null)
            return 0n;
        return ethers.getBigInt(v);
    }
    catch {
        return 0n;
    }
}
async function readLedger(b) {
    try {
        const acct = await b.ledger.getLedger();
        const val = acct?.totalbalance ?? acct?.totalBalance ?? acct?.balance ?? acct?.amount ?? 0;
        const raw = toBigIntSafe(val);
        const og = Number(ethers.formatEther(raw));
        return { exists: true, raw, og };
    }
    catch (err) {
        const msg = String(err?.reason || err?.shortMessage || err?.message || "").toLowerCase();
        if (msg.includes("ledgernotexists") || msg.includes("call_exception"))
            return { exists: false, raw: 0n, og: 0 };
        return { exists: false, raw: 0n, og: 0 };
    }
}
async function ensureLedgerMinOG(b, minOG = 0.02) {
    const info = await readLedger(b);
    if (!info.exists) {
        await b.ledger.addLedger(minOG);
        const after = await readLedger(b);
        return after.og;
    }
    if (info.og < minOG) {
        const topUp = Math.max(minOG - info.og, 0);
        if (topUp > 0)
            await b.ledger.addLedger(topUp);
        const after = await readLedger(b);
        return after.og;
    }
    return info.og;
}
async function getMeta(b, provider) {
    return b.inference?.getServiceMetadata
        ? b.inference.getServiceMetadata(provider)
        : b.getServiceMetadata(provider);
}
async function ogChat(b, provider, messages) {
    const { endpoint, model } = await getMeta(b, provider);
    await b.inference.acknowledgeProviderSigner(provider);
    const bill = messages.map(m => `${m.role}: ${m.content}`).join("\n").slice(0, 4000);
    const headers = await b.inference.getRequestHeaders(provider, bill);
    const res = await fetch(`${endpoint}/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...headers },
        body: JSON.stringify({ model, messages })
    });
    if (!res.ok) {
        const txt = await res.text().catch(() => "");
        throw new Error(`HTTP ${res.status} from provider. Body: ${txt.slice(0, 300)}`);
    }
    let j;
    try {
        j = await res.json();
    }
    catch (e) {
        const txt = await res.text().catch(() => "");
        throw new Error(`Non-JSON response from provider: ${txt.slice(0, 300)}`);
    }
    const content = j?.choices?.[0]?.message?.content ?? "";
    const chatId = j?.id ?? "";
    await b.inference.processResponse(provider, content, chatId);
    return content;
}
async function diag(b, provider) {
    try {
        const meta = await getMeta(b, provider);
        await b.inference.acknowledgeProviderSigner(provider);
        const headers = await b.inference.getRequestHeaders(provider, "diag");
        const res = await fetch(`${meta.endpoint}/chat/completions`, {
            method: "POST",
            headers: { "Content-Type": "application/json", ...headers },
            body: JSON.stringify({ model: meta.model, messages: [{ role: "user", content: "ping" }] })
        });
        const status = res.status;
        let body = "";
        try {
            body = await res.text();
        }
        catch { }
        return { ok: res.ok, status, endpoint: meta.endpoint, model: meta.model, body: body.slice(0, 300) };
    }
    catch (e) {
        return { ok: false, error: String(e?.message || e) };
    }
}
async function main() {
    if (!/^\d+:[\w-]+$/.test(BOT_TOKEN))
        throw new Error("BOT_TOKEN invalid");
    const bot = new TelegramBot(BOT_TOKEN, { polling: true });
    try {
        await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/deleteWebhook`);
    }
    catch { }
    const broker = await makeBroker();
    try {
        const bal = await ensureLedgerMinOG(broker, 0.02);
        console.log("Ledger balance (OG):", bal.toFixed(6));
    }
    catch (e) {
        console.warn("Could not create/top-up ledger. You likely need testnet OG in the wallet.");
    }
    const classifier = await pipeline("zero-shot-classification", "Xenova/nli-deberta-v3-xsmall");
    const CRYPTO = ["cryptocurrency", "blockchain", "defi", "nfts", "wallets", "smart contracts", "exchanges", "privacy tee", "0g"];
    const LABELS = ["greeting", ...CRYPTO];
    const scoreOf = (out, label) => {
        const i = out.labels.findIndex((l) => l.toLowerCase() === label.toLowerCase());
        return i >= 0 ? Number(out.scores[i]) : 0;
    };
    bot.onText(/^\/balance$/, async (ctx) => {
        const id = ctx.chat?.id ?? ctx.message?.chat?.id;
        if (!id)
            return;
        try {
            const info = await readLedger(broker);
            if (!info.exists) {
                await bot.sendMessage(id, "No ledger yet. Fund wallet with testnet OG and ask a crypto question to initialize.");
                return;
            }
            await bot.sendMessage(id, `Ledger balance: ${info.og.toFixed(6)} OG`);
        }
        catch (e) {
            console.error("[/balance]", e);
            await bot.sendMessage(id, "Couldn’t read balance right now.");
        }
    });
    bot.onText(/^\/provider$/, async (ctx) => {
        const id = ctx.chat?.id ?? ctx.message?.chat?.id;
        if (!id)
            return;
        try {
            const m = await getMeta(broker, CHAT_PROVIDER);
            await bot.sendMessage(id, `Provider: ${CHAT_PROVIDER}\nModel: ${m.model}\nEndpoint: ${m.endpoint}`);
        }
        catch (e) {
            console.error("[/provider]", e);
            await bot.sendMessage(id, "Couldn’t read provider metadata.");
        }
    });
    bot.onText(/^\/diag$/, async (ctx) => {
        const id = ctx.chat?.id ?? ctx.message?.chat?.id;
        if (!id)
            return;
        const d = await diag(broker, CHAT_PROVIDER);
        await bot.sendMessage(id, "Diag:\n" + JSON.stringify(d, null, 2));
    });
    bot.on("message", async (msg) => {
        const chatId = msg.chat?.id;
        const text = (msg.text ?? "").trim();
        if (!text || text.startsWith("/"))
            return;
        try {
            if (isTrivialGreeting(text)) {
                await bot.sendMessage(chatId, "Hey! I’m Susana 👋 How can I help with crypto or 0G today?");
                return;
            }
            try {
                await ensureLedgerMinOG(broker, 0.02);
            }
            catch {
                await bot.sendMessage(chatId, "I need a bit of testnet OG in the wallet to operate. Please fund and try again.");
                return;
            }
            const z = await classifier(text, LABELS, { multi_label: true, hypothesis_template: "This text is about {}." });
            const greet = scoreOf(z, "greeting");
            const crypto = Math.max(...CRYPTO.map(l => scoreOf(z, l)));
            if (greet >= 0.35 && crypto < 0.45) {
                await bot.sendMessage(chatId, "Hey! I’m Susana 👋 How can I help with crypto or 0G today?");
                return;
            }
            if (crypto >= 0.45) {
                const messages = [
                    { role: "system", content: "You are Susana, a knowledgeable crypto/0G assistant. Be concise and accurate." },
                    { role: "user", content: text }
                ];
                const answer = await ogChat(broker, CHAT_PROVIDER, messages);
                await bot.sendMessage(chatId, answer || "No response.");
                return;
            }
            await bot.sendMessage(chatId, "I don’t have access to that information.");
        }
        catch (e) {
            console.error("[message]", e);
            await bot.sendMessage(chatId, "Error reaching the crypto model. Try again.");
        }
    });
    bot.on("polling_error", (e) => console.error("[polling_error]", e));
    bot.onText(/^\/start$/, async (ctx) => {
        const id = ctx.chat?.id ?? ctx.message?.chat?.id;
        if (id) {
            await bot.sendMessage(id, "My name is Susana — your No.1 Crypto Bot. Ask me anything about crypto/0G.\nUse /balance to check my 0G ledger.");
        }
    });
    console.log("Susana is running with long polling…");
}
void main();
//# sourceMappingURL=bot.js.map