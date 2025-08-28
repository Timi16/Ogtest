import "dotenv/config";
import * as ethers from "ethers";
import { createZGComputeNetworkBroker } from "@0glabs/0g-serving-broker";

async function setupBroker() {
  const provider = new ethers.JsonRpcProvider(process.env.RPC_URL!);
  const wallet = new ethers.Wallet(process.env.PRIVATE_KEY!, provider);
  const broker = await createZGComputeNetworkBroker(wallet as any);
  console.log(" Broker:", wallet.address);
  return broker;
}

async function ensureAccountAndFund(broker: any, amount = "0.10") {
  let acct;
  try {
    acct = await broker.ledger.getLedger();
  } catch {
    console.log(" Creating ledger with", amount, "OG…");
    await broker.ledger.addLedger(amount);
    acct = await broker.ledger.getLedger();
  }

  const bal = ethers.getBigInt(acct.totalbalance);
  const need = ethers.parseEther(amount);
  if (bal < need) {
    console.log("➕ Funding ledger with", amount, "OG…");
    await broker.ledger.addLedger(amount);
    acct = await broker.ledger.getLedger();
  }

  console.log("Balance:", ethers.formatEther(acct.totalbalance), "OG");
}

async function listServices(broker: any) {
  const services = await broker.listServices();
  const clean = (services || []).map((s: any, i: number) => ({
    i,
    address: s?.address || s?.provider || "unknown",
    model: s?.model || s?.name || "unknown",
    price: s?.price || s?.cost || "n/a",
  }));
  if (clean.length) console.table(clean);
  else console.log(" No services found.");
  return services;
}

async function queryProvider(broker: any, addr: string) {
  console.log(" Querying:", addr);
  const out = await broker.query(addr, "Hello OG Compute!");
  console.log(" Output:", out);
}

(async () => {
  try {
    const broker = await setupBroker();
    await ensureAccountAndFund(broker, "0.10");
    const services = await listServices(broker);
    const first =
      services?.[0]?.address || services?.[0]?.provider || undefined;
    if (first) await queryProvider(broker, first);
  } catch (e) {
    console.error("", e);
  }
})();
