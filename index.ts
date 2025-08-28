import { Wallet } from "ethers";

// const wallet = Wallet.createRandom();
// console.log("Address:", wallet.address);
// console.log("Private Key:", wallet.privateKey);

import "dotenv/config";
import { ethers } from "ethers";
import { createZGComputeNetworkBroker } from "@0glabs/0g-serving-broker";


async function setupBroker() {
    const provider = new ethers.JsonRpcProvider(process.env.RPC_URL!);
    const wallet = new ethers.Wallet(process.env.PRIVATE_KEY!, provider);
    const broker = await createZGComputeNetworkBroker(wallet as any);
    console.log("✅ Broker connected with address:", wallet.address);
    return broker;
}


async function checkAndFund(broker: any) {
  const account = await broker.ledger.getLedger();
  console.log("💰 Current Balance:", ethers.formatEther(account.totalbalance), "OG");

  // top up (if needed)
  await broker.ledger.addLedger("0.1"); // uncomment to fund 0.1 OG
}


async function listServices(broker: any) {
  const services = await broker.listServices();
  console.log("📜 Services available:", services);
  return services;
}

async function queryProvider(broker: any, providerAddr: string) {
  const result = await broker.query(providerAddr, "Hello OG Compute!");
  console.log("🤖 Provider output:", result);
}

(async () => {
  const broker = await setupBroker();

  await checkAndFund(broker);
  const services = await listServices(broker);

  // replace with one provider address from services
  if (services.length > 0) {
    await queryProvider(broker, services[0].address);
  }
})();
