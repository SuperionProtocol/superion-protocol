// Crée (si besoin) un portefeuille de test éphémère pour la recette UI et lui envoie un peu d'ETH de test.
// La clé reste dans .ui-wallet.json (mode 600), jamais affichée.
const fs = require("fs");
const path = require("path");
const { ethers } = require("hardhat");
const { waitTx } = require("./lib.cjs");
const FILE = path.join(__dirname, "..", "..", ".ui-wallet.json");
(async () => {
  if ((await ethers.provider.getNetwork()).chainId !== 84532n) throw new Error("Base Sepolia uniquement");
  if (!fs.existsSync(FILE)) fs.writeFileSync(FILE, JSON.stringify({ uitester: ethers.Wallet.createRandom().privateKey }), { mode: 0o600 });
  const w = new ethers.Wallet(JSON.parse(fs.readFileSync(FILE, "utf8")).uitester);
  const [admin] = await ethers.getSigners();
  const bal = await ethers.provider.getBalance(w.address);
  console.log("uitester", w.address, "ETH", ethers.formatEther(bal));
  if (bal < ethers.parseEther("0.002")) {
    const r = await waitTx(() => admin.sendTransaction({ to: w.address, value: ethers.parseEther("0.003") }), console.log, "fund_eth_uitester");
  }
})().catch((e) => { console.error(e.shortMessage || e.message); process.exit(1); });
