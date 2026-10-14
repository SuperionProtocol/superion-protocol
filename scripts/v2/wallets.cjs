// Portefeuilles de test éphémères (testnet uniquement). Les clés restent dans un fichier local
// en mode 600 et ne sont JAMAIS affichées.
const fs = require("fs");
const path = require("path");
const FILE = path.join(__dirname, "..", "..", ".smoke-wallets.json");
const ROLES = ["provider", "verifier1", "verifier2", "verifier3", "challenger"];

function loadOrCreate(ethers) {
  let data;
  if (fs.existsSync(FILE)) data = JSON.parse(fs.readFileSync(FILE, "utf8"));
  else {
    data = {};
    for (const r of ROLES) data[r] = ethers.Wallet.createRandom().privateKey;
    fs.writeFileSync(FILE, JSON.stringify(data), { mode: 0o600 });
  }
  const out = {};
  for (const r of ROLES) out[r] = new ethers.Wallet(data[r], ethers.provider);
  return out;
}
module.exports = { loadOrCreate, ROLES };
