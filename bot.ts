import "dotenv/config";
import * as ethers from "ethers";
import TelegramBot from "node-telegram-bot-api";
import { createZGComputeNetworkBroker } from "@0glabs/0g-serving-broker";
import { pipeline } from "@xenova/transformers";

type Msg = { role: "system" | "user" | "assistant"; content: string };

const BOT_TOKEN     = (process.env.BOT_TOKEN || "").trim();
const RPC_URL       = process.env.RPC_URL!;
const PRIVATE_KEY   = process.env.PRIVATE_KEY!;
const CHAT_PROVIDER = process.env.CHAT_PROVIDER!; // provider address for chatbot service

// simple greeting fallback so convo feels responsive even if classifier is unsure
const isTrivialGreeting = (t: string) =>
  /^(hi|hello|hey|yo|gm|gn|good (morning|afternoon|evening)|how (are|r) (you|u))/i.test(t);

async function makeBroker() {
  const provider = new ethers.JsonRpcProvider(RPC_URL);
  const wallet   = new ethers.Wallet(PRIVATE_KEY, provider);
  return createZGComputeNetworkBroker(wallet as any);
}

async function getMeta(b: any, provider: string) {
  return b.inference?.getServiceMetadata
    ? b.inference.getServiceMetadata(provider)
    : b.getServiceMetadata(provider);
}

// ---------- Ledger helpers (OG units) ----------
type LedgerInfo = { exists: boolean; raw: bigint; og: number };

async function readLedger(b: any): Promise<LedgerInfo> {
  try {
    const acct = await b.ledger.getLedger();
    const raw  = ethers.getBigInt(acct.totalbalance);        // base units
    const og   = parseFloat(ethers.formatEther(raw));         // display as OG
    return { exists: true, raw, og };
  } catch (err: any) {
    const notExists =
      err?.reason === "LedgerNotExists(address)" ||
      String(err?.shortMessage || "").toLowerCase().includes("ledgernotexists");
    if (notExists) return { exists: false, raw: 0n, og: 0 };
    throw err;
  }
}

// Ensure a ledger exists and has at least `minOG` balance (number, in OG tokens)
async function ensureLedgerMinOG(b: any, minOG = 0.02): Promise<number> {
  const info = await readLedger(b);
  if (!info.exists) {
    await b.ledger.addLedger(minOG); // number, in OG
    const after = await readLedger(b);
    return after.og;
  }
  if (info.og < minOG) {
    const topUp = minOG - info.og;   // number math in OG
    await b.ledger.addLedger(topUp);  // top up (OG)
    const after = await readLedger(b);
    return after.og;
  }
  return info.og;
}

// ---------- 0G chat ----------
async function ogChat(b: any, provider: string, messages: Msg[]) {
  const { endpoint, model } = await getMeta(b, provider);

  // acknowledge once; safe to call many times (no-op if already acked)
  await b.inference.acknowledgeProviderSigner(provider);

  // billing text used to create signed headers
  const bill = messages.map(m => `${m.role}: ${m.content}`).join("\n").slice(0, 4000);
  const headers = await b.inference.getRequestHeaders(provider, bill);

  const r = await fetch(`${endpoint}/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify({ model, messages }),
  });

  const j = await r.json();
  const content = j?.choices?.[0]?.message?.content ?? "";
  const chatId  = j?.id ?? "";
  await b.inference.processResponse(provider, content, chatId);
  return content;
}

async function main() {
  if (!/^\d+:[\w-]+$/.test(BOT_TOKEN)) throw new Error("BOT_TOKEN invalid");

  const bot = new TelegramBot(BOT_TOKEN, { polling: true });
  try { await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/deleteWebhook`); } catch {}

  const broker = await makeBroker();
  try {
    const bal = await ensureLedgerMinOG(broker, 0.02); // require at least 0.02 OG
    console.log("Ledger balance (OG):", bal.toFixed(6));
  } catch (e) {
    console.warn("Could not create/top-up ledger. You likely need testnet OG in the wallet.");
  }

  // tiny classifier for intent; keeps greetings nice
  const classifier = await pipeline("zero-shot-classification", "Xenova/nli-deberta-v3-xsmall");
  const CRYPTO = ["cryptocurrency","blockchain","defi","nfts","wallets","smart contracts","exchanges","privacy tee","0g"];
  const LABELS = ["greeting", ...CRYPTO];
  const scoreOf = (out: any, label: string) => {
    const i = out.labels.findIndex((l: string) => l.toLowerCase() === label.toLowerCase());
    return i >= 0 ? Number(out.scores[i]) : 0;
    };

  // /balance command (shows current OG and hints if low)
  bot.onText(/^\/balance$/, async (ctx: any) => {
    const id = (ctx as any).chat?.id ?? (ctx as any).message?.chat?.id;
    if (!id) return;
    try {
      const info = await readLedger(broker);
      if (!info.exists) {
        await bot.sendMessage(id, "No ledger yet. I’ll try to create it when you next ask a crypto question. Make sure your wallet has some OG on testnet.");
        return;
      }
      const og = info.og;
      await bot.sendMessage(id, `Ledger balance: ${og.toFixed(6)} OG`);
    } catch (e) {
      console.error(e);
      await bot.sendMessage(id, "Couldn’t read balance right now.");
    }
  });

  bot.on("message", async (msg: any) => {
    const chatId = msg.chat?.id;
    const text = (msg.text ?? "").trim();
    if (!text || text.startsWith("/")) return; // skip commands here

    try {
      // greet fast
      if (isTrivialGreeting(text)) {
        await bot.sendMessage(chatId, "Hey! I’m Susana 👋 How can I help with crypto or 0G today?");
        return;
      }

      // ensure balance before paying for inference
      try {
        await ensureLedgerMinOG(broker, 0.02);
      } catch {
        await bot.sendMessage(chatId, "I need a bit of testnet OG in the wallet to operate. Please fund and try again.");
        return;
      }

      // ML intent
      const z = await classifier(text, LABELS, { multi_label: true, hypothesis_template: "This text is about {}." });
      const greet  = scoreOf(z, "greeting");
      const crypto = Math.max(...CRYPTO.map(l => scoreOf(z, l)));

      if (greet >= 0.35 && crypto < 0.45) {
        await bot.sendMessage(chatId, "Hey! I’m Susana 👋 How can I help with crypto or 0G today?");
        return;
      }

      if (crypto >= 0.45) {
        const messages: Msg[] = [
          { role: "system", content: "You are Susana, a knowledgeable crypto/0G assistant. Be concise and accurate." },
          { role: "user",   content: text }
        ];
        const answer = await ogChat(broker, CHAT_PROVIDER, messages);
        await bot.sendMessage(chatId, answer || "No response.");
        return;
      }

      await bot.sendMessage(chatId, "I don’t have access to that information.");
    } catch (e) {
      console.error(e);
      await bot.sendMessage(chatId, "Error reaching the crypto model. Try again.");
    }
  });

  bot.on("polling_error", (e: any) => console.error("[polling_error]", e));
  bot.onText(/^\/start$/, async (ctx: any) => {
    const id = (ctx as any).chat?.id ?? (ctx as any).message?.chat?.id;
    if (id) {
      await bot.sendMessage(
        id,
        "My name is Susana — your No.1 Crypto Bot. Ask me anything about crypto/0G.\nUse /balance to check my 0G ledger."
      );
    }
  });

  console.log("Susana is running with long polling…");
}

void main();
