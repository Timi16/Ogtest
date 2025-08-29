import "dotenv/config";
import * as ethers from "ethers";
import { createZGComputeNetworkBroker } from "@0glabs/0g-serving-broker";

(async () => {
  const provider = new ethers.JsonRpcProvider(process.env.RPC_URL!);
  const wallet = new ethers.Wallet(process.env.PRIVATE_KEY!, provider);
  const broker = await createZGComputeNetworkBroker(wallet as any);

  const services = await broker.inference.listService();

  const chat = services.find((s: any) =>
    (s?.serviceType || "").toLowerCase().includes("chat") ||
    /llama|deepseek|qwen|mistral|chat/i.test(s?.model || "")
  );
  const embed = services.find((s: any) =>
    (s?.serviceType || "").toLowerCase().includes("embed") ||
    /embed|bge|gte|e5|nomic/i.test(s?.model || "")
  );

  console.log("CHAT_PROVIDER:", chat?.provider || "(none found)");
  console.log("EMBED_PROVIDER:", embed?.provider || "(none found)");

  if (embed) {
    const { endpoint, model } = await broker.inference.getServiceMetadata(embed.provider);
    await broker.inference.acknowledgeProviderSigner(embed.provider);
    const headers = await broker.inference.getRequestHeaders(embed.provider, "ping");
    const r = await fetch(`${endpoint}/embeddings`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...headers },
      body: JSON.stringify({ model, input: ["ping"] }),
    });
    console.log("Embeddings endpoint status:", r.status);
  }
})();
