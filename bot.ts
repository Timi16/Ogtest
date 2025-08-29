import "dotenv/config";
import * as ethers from "ethers";
import TelegramBot from "node-telegram-bot-api";
import { createZGComputeNetworkBroker } from "@0glabs/0g-serving-broker";
import { pipeline } from "@xenova/transformers";

type Msg = { role: "system" | "user" | "assistant"; content: string };

const BOT_TOKEN = (process.env.BOT_TOKEN || "").trim();
const RPC_URL = process.env.RPC_URL!;
const PRIVATE_KEY = process.env.PRIVATE_KEY!;
const CHAT_PROVIDER = process.env.CHAT_PROVIDER!;

const isTrivialGreeting = (t: string) =>
  /^(hi|hello|hey|yo|gm|gn|good (morning|afternoon|evening)|how (are|r) (you|u))/i.test(t);

async function makeBroker() {
  const provider = new ethers.JsonRpcProvider(RPC_URL);
  const wallet = new ethers.Wallet(PRIVATE_KEY, provider);
  return createZGComputeNetworkBroker(wallet as any);
}

type LedgerInfo = { exists: boolean; raw: bigint; og: number };

function toBigIntSafe(v: any): bigint {
  try {
    if (v === null || v === undefined) return 0n;
    return ethers.getBigInt(v);
  } catch {
    return 0n;
  }
}

async function readLedger(b: any): Promise<LedgerInfo> {
  try {
    const acct = await b.ledger.getLedger();
    const val =
      acct?.totalbalance ??
      acct?.totalBalance ??
      acct?.balance ??
      acct?.amount ??
      0;
    const raw = toBigIntSafe(val);
    const og = Number(ethers.formatEther(raw));
    return { exists: true, raw, og };
  } catch (err: any) {
    const msg = String(err?.reason || err?.shortMessage || err?.message || "").toLowerCase();
    if (msg.includes("ledgernotexists") || msg.includes("call_exception")) {
      return { exists: false, raw: 0n, og: 0 };
    }
    return { exists: false, raw: 0n, og: 0 };
  }
}

async function ensureLedgerMinOG(b: any, minOG = 0.02): Promise<number> {
  const info = await readLedger(b);
  if (!info.exists) {
    await b.ledger.addLedger(minOG);
    const after = await readLedger(b);
    return after.og;
  }
  if (info.og < minOG) {
    const topUp = Math.max(minOG - info.og, 0);
    if (topUp > 0) await b.ledger.addLedger(topUp);
    const after = await readLedger(b);
    return after.og;
  }
  return info.og;
}

async function getMeta(b: any, provider: string) {
  return b.inference?.getServiceMetadata
    ? b.inference.getServiceMetadata(provider)
    : b.getServiceMetadata(provider);
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

async function main() {
  if (!/^\d+:[\w-]+$/.test(BOT_TOKEN)) throw new Error("BOT_TOKEN invalid");
  const bot = new TelegramBot(BOT_TOKEN, { polling: true });
  try { await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/deleteWebhook`); } catch {}

  const broker = await makeBroker();
  try {
    const bal = await ensureLedgerMinOG(broker, 0.02);
    console.log("Ledger balance (OG):", bal.toFixed(6));
  } catch {
    console.warn("Could not create/top-up ledger. You likely need testnet OG in the wallet.");
  }

  const classifier = await pipeline("zero-shot-classification", "Xenova/nli-deberta-v3-xsmall");
  const CRYPTO = ["cryptocurrency","blockchain","defi","nfts","wallets","smart contracts","exchanges","privacy tee","0g"];
  const LABELS = ["greeting", ...CRYPTO];
  const scoreOf = (out: any, label: string) => {
    const i = out.labels.findIndex((l: string) => l.toLowerCase() === label.toLowerCase());
    return i >= 0 ? Number(out.scores[i]) : 0;
  };

  bot.onText(/^\/balance$/, async (ctx: any) => {
    const id = (ctx as any).chat?.id ?? (ctx as any).message?.chat?.id;
    if (!id) return;
    try {
      const info = await readLedger(broker);
      if (!info.exists) {
        await bot.sendMessage(id, "No ledger yet. Fund the wallet with testnet OG and ask a crypto question to initialize.");
        return;
      }
      await bot.sendMessage(id, `Ledger balance: ${info.og.toFixed(6)} OG`);
    } catch {
      await bot.sendMessage(id, "Couldn’t read balance right now.");
    }
  });

  bot.on("message", async (msg: any) => {
    const chatId = msg.chat?.id;
    const text = (msg.text ?? "").trim();
    if (!text || text.startsWith("/")) return;

    try {
      if (isTrivialGreeting(text)) {
        await bot.sendMessage(chatId, "Hey! I’m Susana 👋 How can I help with crypto or 0G today?");
        return;
      }

      try {
        await ensureLedgerMinOG(broker, 0.02);
      } catch {
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
        const messages: Msg[] = [
          { role: "system", content: "You are Susana, a knowledgeable crypto/0G assistant. Be concise and accurate." },
          { role: "user", content: text }
        ];
        const answer = await ogChat(broker, CHAT_PROVIDER, messages);
        await bot.sendMessage(chatId, answer || "No response.");
        return;
      }

      await bot.sendMessage(chatId, "I don’t have access to that information.");
    } catch {
      await bot.sendMessage(chatId, "Error reaching the crypto model. Try again.");
    }
  });

  bot.on("polling_error", (e: any) => console.error("[polling_error]", e));
  bot.onText(/^\/start$/, async (ctx: any) => {
    const id = (ctx as any).chat?.id ?? (ctx as any).message?.chat?.id;
    if (id) {
      await bot.sendMessage(id, "My name is Susana — your No.1 Crypto Bot. Ask me anything about crypto/0G.\nUse /balance to check my 0G ledger.");
    }
  });

  console.log("Susana is running with long polling…");
}

void main();
