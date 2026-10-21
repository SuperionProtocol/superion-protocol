// Recharge l'abonnement VRF Base Sepolia en ETH natif (montant VRF_FUND, défaut 0.02). Testnet uniquement.
const fs = require("fs"); const path = require("path");
const { ethers } = require("hardhat");
async function main() {
  if ((await ethers.provider.getNetwork()).chainId !== 84532n) throw new Error("Base Sepolia uniquement");
  const f = path.join(__dirname, "..", "..", "deployments", "vrf.baseSepolia.json");
  const st = JSON.parse(fs.readFileSync(f, "utf8"));
  const [s] = await ethers.getSigners();
  const c = new ethers.Contract(st.vrf.coordinator, ["function fundSubscriptionWithNative(uint256) payable", "function getSubscription(uint256) view returns (uint96,uint96,uint64,address,address[])"], s);
  const v = ethers.parseEther(process.env.VRF_FUND || "0.02");
  const tx = await c.fundSubscriptionWithNative(st.vrf.subId, { value: v }); await tx.wait();
  const st2 = JSON.parse(fs.readFileSync(f, "utf8"));
  st2.txs[`vrf_topup_${Date.now()}`] = tx.hash;
  const sub = await c.getSubscription(st.vrf.subId);
  st2.vrf.subscription.nativeBalance = ethers.formatEther(sub[1]);
  fs.writeFileSync(f, JSON.stringify(st2, null, 2) + "\n");
  console.log("topup", tx.hash, "nativeBalance", ethers.formatEther(sub[1]));
}
main().catch((e) => { console.error(e); process.exit(1); });
