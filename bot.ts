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

async function makeBroker() {
  const p = new ethers.JsonRpcProvider(RPC_URL);
  const w = new ethers.Wallet(PRIVATE_KEY, p);
  return createZGComputeNetworkBroker(w as any);
}

let zscPromise: Promise<any> | null = null;
async function getClassifier() {
  if (!zscPromise) {
    zscPromise = pipeline("zero-shot-classification", "Xenova/nli-deberta-v3-xsmall");
  }
  return zscPromise!;
}

const CRYPTO_LABELS = [
  "cryptocurrency","blockchain","defi","nfts","wallets",
  "smart contracts","exchanges","privacy tee","0g"
];
const INTENT_LABELS = ["greeting", ...CRYPTO_LABELS];

const scoreOf = (out: any, label: string) => {
  const i = out.labels.findIndex((l: string) => l.toLowerCase() === label.toLowerCase());
  return i >= 0 ? Number(out.scores[i]) : 0;
};

async function getMeta(b: any, provider: string) {
  return b.getServiceMetadata ? b.getServiceMetadata(provider) : b.inference.getServiceMetadata(provider);
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

  // ensure no webhook so polling works
  await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/deleteWebhook`);

  const bot = new TelegramBot(BOT_TOKEN, { polling: true });
  let brokerPromise: Promise<any> | null = null;

  bot.on("message", async (msg: any) => {
    const chatId = msg.chat?.id;
    const text = (msg.text ?? "").trim();
    if (!text) return;

    try {
      brokerPromise = brokerPromise || makeBroker();
      const broker = await brokerPromise;

      const classifier = await getClassifier();
      const z = await classifier(text, INTENT_LABELS, {
        multi_label: true,
        hypothesis_template: "This text is about {}."
      });

      const greetScore = scoreOf(z, "greeting");
      const cryptoScore = Math.max(...CRYPTO_LABELS.map(l => scoreOf(z, l)));

      if (greetScore >= 0.60 && cryptoScore < 0.50) {
        await bot.sendMessage(chatId, "Hey! I’m Susana 👋 How can I help with crypto or 0G today?");
        return;
      }

      if (cryptoScore >= 0.50) {
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
    const chatId = (ctx as any).chat?.id ?? (ctx as any).message?.chat?.id;
    if (chatId) await bot.sendMessage(chatId, "My name is Susana — your No.1 Crypto Bot. Ask me anything about crypto/0G.");
  });

  console.log("Susana is running with long polling…");
}

void main();
