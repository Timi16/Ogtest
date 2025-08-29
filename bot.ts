import "dotenv/config";
import * as ethers from "ethers";
import TelegramBot from "node-telegram-bot-api";
import { pipeline } from "@xenova/transformers";
// ⬇️ use the SDK's ESM build to avoid CJS error-handler issues
import { createZGComputeNetworkBroker } from "@0glabs/0g-serving-broker/lib.esm/index.js";

type Msg = { role: "system" | "user" | "assistant"; content: string };

const BOT_TOKEN = (process.env.BOT_TOKEN || "").trim();
const RPC_URL = process.env.RPC_URL!;
const PRIVATE_KEY = process.env.PRIVATE_KEY!;
const CHAT_PROVIDER = process.env.CHAT_PROVIDER!;

// light, fast greeting fallback (so you always greet even if classifier stalls)
function isTrivialGreeting(t: string) {
  return /^(hi|hello|hey|good (morning|afternoon|evening)|how (are|r) (you|u))/i.test(t);
}

async function makeBroker() {
  const p = new ethers.JsonRpcProvider(RPC_URL);
  const w = new ethers.Wallet(PRIVATE_KEY, p);
  return createZGComputeNetworkBroker(w as any);
}

// prefer inference.* if present; fall back to root for older builds
async function getMeta(b: any, provider: string) {
  if (b.inference?.getServiceMetadata) {
    return b.inference.getServiceMetadata(provider);
  }
  return b.getServiceMetadata(provider);
}

// Ensure a ledger exists & has at least `minA0GI` balance (A0GI = atomic unit, integer)
async function ensureLedger(b: any, minA0GI = 100_000) {
  try {
    const acct = await b.ledger.getLedger();
    const bal = BigInt(acct.totalbalance);          // already in A0GI
    if (bal < BigInt(minA0GI)) {
      const diff = Number(BigInt(minA0GI) - bal);   // small top-up → safe to Number
      if (diff > 0) await b.ledger.depositFund(diff); // number in A0GI
    }
  } catch {
    // no ledger yet → create with initial A0GI
    await b.ledger.addLedger(minA0GI);              // number in A0GI
  }
}

// One OpenAI-compatible chat call through 0G
async function ogChat(b: any, provider: string, messages: Msg[]) {
  const { endpoint, model } = await getMeta(b, provider);

  // build single-use billing text (headers require the billed content)
  const bill = messages.map(m => `${m.role}: ${m.content}`).join("\n").slice(0, 4000);

  // headers need: acknowledged provider + existing ledger (we do both on startup)
  const headers = await b.inference.getRequestHeaders(provider, bill);

  const res = await fetch(`${endpoint}/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify({ model, messages })
  });

  const j = await res.json();
  const content = j?.choices?.[0]?.message?.content ?? "";
  const chatId = j?.id ?? "";
  await b.inference.processResponse(provider, content, chatId);
  return content;
}

async function main() {
  if (!/^\d+:[\w-]+$/.test(BOT_TOKEN)) throw new Error("BOT_TOKEN invalid");

  const bot = new TelegramBot(BOT_TOKEN, { polling: true });

  // clear webhook so polling works (ignore failures)
  try { await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/deleteWebhook`); } catch {}

  // warm everything once at startup
  const broker = await makeBroker();
  await ensureLedger(broker, 100_000); // e.g., 100k A0GI buffer
  await broker.inference.acknowledgeProviderSigner(CHAT_PROVIDER); // required once per provider

  // tiny, local intent classifier (optional; keeps greetings nice)
  const classifier = await pipeline(
    "zero-shot-classification",
    "Xenova/nli-deberta-v3-xsmall"
  );
  const CRYPTO_LABELS = [
    "cryptocurrency","blockchain","defi","nfts","wallets",
    "smart contracts","exchanges","privacy tee","0g"
  ];
  const INTENT_LABELS = ["greeting", ...CRYPTO_LABELS];
  const scoreOf = (out: any, label: string) => {
    const i = out.labels.findIndex((l: string) => l.toLowerCase() === label.toLowerCase());
    return i >= 0 ? Number(out.scores[i]) : 0;
  };

  bot.on("message", async (msg: any) => {
    const chatId = msg.chat?.id;
    const text = (msg.text ?? "").trim();
    if (!text) return;

    try {
      if (isTrivialGreeting(text)) {
        await bot.sendMessage(chatId, "Hey! I’m Susana 👋 How can I help with crypto or 0G today?");
        return;
      }

      const z = await classifier(text, INTENT_LABELS, {
        multi_label: true,
        hypothesis_template: "This text is about {}."
      });
      const greetScore = scoreOf(z, "greeting");
      const cryptoScore = Math.max(...CRYPTO_LABELS.map(l => scoreOf(z, l)));

      if (greetScore >= 0.35 && cryptoScore < 0.45) {
        await bot.sendMessage(chatId, "Hey! I’m Susana 👋 How can I help with crypto or 0G today?");
        return;
      }

      if (cryptoScore >= 0.45) {
        const messages: Msg[] = [
          { role: "system", content: "You are Susana, a knowledgeable crypto/0G assistant. Be concise and accurate." },
          { role: "user", content: text }
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
    if (id) await bot.sendMessage(id, "My name is Susana — your No.1 Crypto Bot. Ask me anything about crypto/0G.");
  });

  console.log("Susana is running with long polling…");
}

void main();
