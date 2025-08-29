import "dotenv/config";
import * as ethers from "ethers";
import { createZGComputeNetworkBroker } from "@0glabs/0g-serving-broker";

type Broker = any;

async function setup(): Promise<Broker> {
  const provider = new ethers.JsonRpcProvider(process.env.RPC_URL!);
  const wallet = new ethers.Wallet(process.env.PRIVATE_KEY!, provider);
  const broker = await createZGComputeNetworkBroker(wallet as any);
  console.log("Broker address:", wallet.address);
  return broker;
}

async function ensureLedger(broker: Broker, initialAmount = 0.1) {
  try {
    await broker.ledger.getLedger();
  } catch {
    await broker.ledger.addLedger(Number(initialAmount));
  }
}

async function listServices(broker: Broker) {
  const services = await broker.inference.listService();
  const rows = (services ?? []).map((s: any, i: number) => ({
    i,
    provider: s?.provider,
    serviceType: s?.serviceType,
    url: s?.url,
    model: s?.model,
    inputPrice: s?.inputPrice?.toString?.(),
    outputPrice: s?.outputPrice?.toString?.(),
  }));
  if (rows.length) console.table(rows);
  else console.log("No services found.");
  return services;
}

async function queryOnce(broker: Broker, provider: string, prompt: string) {
  const { endpoint, model } = await broker.inference.getServiceMetadata(provider);
  await broker.inference.acknowledgeProviderSigner(provider);
  const headers = await broker.inference.getRequestHeaders(provider, prompt);
  const res = await fetch(`${endpoint}/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify({ model, messages: [{ role: "user", content: prompt }] }),
  });
  const data = await res.json();
  const content = data?.choices?.[0]?.message?.content ?? "";
  const chatId = data?.id ?? "";
  await broker.inference.processResponse(provider, content, chatId);
  console.log(content);
}

(async () => {
  const broker = await setup();
  await ensureLedger(broker, 0.1);
  const services = await listServices(broker);
  const first = services?.[0]?.provider;
  if (first) await queryOnce(broker, first, "Hello OG Compute!");
})();
