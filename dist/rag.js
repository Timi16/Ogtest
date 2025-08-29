import "dotenv/config";
import * as ethers from "ethers";
import { createZGComputeNetworkBroker } from "@0glabs/0g-serving-broker";
const RPC_URL = process.env.RPC_URL;
const PRIVATE_KEY = process.env.PRIVATE_KEY;
const CHAT_PROVIDER = process.env.CHAT_PROVIDER;
async function broker() {
    const p = new ethers.JsonRpcProvider(RPC_URL);
    const w = new ethers.Wallet(PRIVATE_KEY, p);
    return createZGComputeNetworkBroker(w);
}
async function ensureLedger(b, amount = 0.05) {
    try {
        await b.ledger.getLedger();
    }
    catch {
        await b.ledger.addLedger(amount);
    }
}
async function chat(b, provider, messages) {
    const { endpoint, model } = await b.inference.getServiceMetadata(provider);
    await b.inference.acknowledgeProviderSigner(provider);
    const billText = messages
        .map((m) => `${m.role}: ${m.content}`)
        .join("\n")
        .slice(0, 4000);
    const headers = await b.inference.getRequestHeaders(provider, billText);
    const r = await fetch(`${endpoint}/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...headers },
        body: JSON.stringify({ model, messages }),
    });
    const j = await r.json();
    const content = j?.choices?.[0]?.message?.content ?? "";
    const chatId = j?.id ?? "";
    await b.inference.processResponse(provider, content, chatId);
    return content;
}
function label(chunks) {
    return chunks.map((t, i) => `[${i}] ${t}`).join("\n");
}
(async () => {
    if (!RPC_URL || !PRIVATE_KEY || !CHAT_PROVIDER)
        throw new Error("Set RPC_URL, PRIVATE_KEY, CHAT_PROVIDER in .env");
    const b = await broker();
    await ensureLedger(b, 0.05);
    const docs = [
        "Deserialize is a DEX/perps aggregator focusing on better routing and anti-rug protections.",
        "Denonymous is an enterprise feedback tool enabling anonymous, constructive input with SocialFi incentives.",
        "DebonkBot is a Telegram mini app for fast token trading with a risk-free demo mode.",
    ];
    const question = "In 2 lines, what is Denonymous and who is it for?";
    const selectPrompt = [
        {
            role: "system",
            content: "You select the most relevant snippets for a question. Reply with a JSON array of indices only, e.g. [1,2]. No text.",
        },
        {
            role: "user",
            content: `Question: ${question}\nSnippets:\n${label(docs)}`,
        },
    ];
    let raw = await chat(b, CHAT_PROVIDER, selectPrompt);
    let idx = [];
    try {
        idx = JSON.parse(raw);
    }
    catch {
        idx = [0, 1];
    }
    if (!Array.isArray(idx) ||
        !idx.every((n) => Number.isInteger(n) && n >= 0 && n < docs.length))
        idx = [0, 1];
    const context = idx.map((i) => docs[i]).join("\n");
    const answerPrompt = [
        {
            role: "system",
            content: "You are a precise assistant. Use ONLY the given context. If not in context, say you don't know.",
        },
        { role: "user", content: `Context:\n${context}\n\nQuestion: ${question}` },
    ];
    const answer = await chat(b, CHAT_PROVIDER, answerPrompt);
    console.log(answer);
})();
