import "dotenv/config";
import * as ethers from "ethers";
import { createRequire } from "module";
import { createZGComputeNetworkBroker } from "@0glabs/0g-serving-broker";

const require = createRequire(import.meta.url);
const TelegramBot = require("node-telegram-bot-api");

type Msg = { role: "system" | "user" | "assistant"; content: string };

const BOT_TOKEN = process.env.BOT_TOKEN!;
const RPC_URL = process.env.RPC_URL!;
const PRIVATE_KEY = process.env.PRIVATE_KEY!;
const CHAT_PROVIDER = process.env.CHAT_PROVIDER!;

// ---- 0G helpers ----
async function makeBroker() {
  const p = new ethers.JsonRpcProvider(RPC_URL);
  const w = new ethers.Wallet(PRIVATE_KEY, p);
  return createZGComputeNetworkBroker(w as any);
}
async function ensureLedger(b: any, amount = 0.05) {
  try { await b.ledger.getLedger(); } catch { await b.ledger.addLedger(amount); }
}
async function getMeta(b: any, provider: string) {
  return (b.getServiceMetadata ? await b.getServiceMetadata(provider)
                               : await b.inference.getServiceMetadata(provider));
}
async function ogChat(b: any, provider: string, messages: Msg[]) {
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

const cryptoRegex = new RegExp(
  [
    "crypto","blockchain","onchain","token","coin","airdrop","defi","dex","cex",
    "wallet","seed","mnemonic","rpc","smart contract","evm","solidity","rust",
    "nft","staking","bridge","l2","rollup","zk","zkp","tee","phala","0g",
    "\\b(btc|eth|sol|bnb|matic|avax|dot|ada|arb|op|base|fil|atom|ltc|xrp|doge)\\b"
  ].join("|"),
  "i"
);
const isCrypto = (t?: string) => !!t && cryptoRegex.test(t);

// ---- bot (long-polling) ----
const bot = new TelegramBot(BOT_TOKEN, {
  polling: { // long-polling; library handles offset/loop
    params: { timeout: 30 } // seconds; Telegram holds the connection open
  }
});

let brokerPromise: Promise<any> | null = null;

bot.on("message", async (msg: any) => {
  const chatId = msg.chat?.id;
  const text = (msg.text ?? "").trim();

  if (!text) return;
  if (!isCrypto(text)) {
    await bot.sendMessage(chatId, "I don’t have access to that information. Ask me something crypto.");
    return;
  }

  try {
    brokerPromise = brokerPromise || (async () => {
      const b = await makeBroker();
      await ensureLedger(b, 0.05);
      return b;
    })();
    const broker = await brokerPromise;

    const messages: Msg[] = [
      { role: "system", content: "You are a concise, crypto-native assistant. Ignore non-crypto topics." },
      { role: "user", content: text }
    ];

    const answer = await ogChat(broker, CHAT_PROVIDER, messages);
    await bot.sendMessage(chatId, answer || "No response.");
  } catch (e) {
    console.error(e);
    await bot.sendMessage(chatId, "Error reaching the crypto model. Try again.");
  }
});

console.log("Bot running with long polling…");
