const fs = require("fs"); const path = require("path");
const { ethers } = require("hardhat");
const { loadOrCreate } = require("./wallets.cjs");
const OUT = path.join(__dirname, "..", "..", "deployments", "app-v21.e2e.json");
const out = JSON.parse(fs.readFileSync(OUT, "utf8")); const save = () => fs.writeFileSync(OUT, JSON.stringify(out, null, 2));
const coder = ethers.AbiCoder.defaultAbiCoder();
(async () => {
  const W = loadOrCreate(ethers);
  const mk = await ethers.getContractAt("SuperionJobMarketplaceV2", "0xe7e59308bC3f44E00f4B0546AF146ad8d662BE51");
  const id = 6n;
  const c = await mk.committeeOf(id);
  const byAddr = Object.fromEntries(Object.values(W).map((w) => [w.address.toLowerCase(), w]));
  const salts = {};
  await Promise.all(c.map(async (m) => {
    const w = byAddr[m.toLowerCase()]; salts[m] = ethers.hexlify(ethers.randomBytes(32));
    const h = ethers.keccak256(coder.encode(["bool", "bytes32", "address", "uint256"], [true, salts[m], m, id]));
    const k = mk.connect(w); const g = await k.commitVote.estimateGas(id, h);
    const tx = await k.commitVote(id, h, { gasLimit: g * 13n / 10n + 15000n }); await tx.wait();
    out.txs[`job6_commitVote_${m.slice(0, 8)}`] = tx.hash; console.log("commit", m, tx.hash);
  }));
  save();
  fs.writeFileSync("/tmp/salts6.json", JSON.stringify(salts));
})().catch((e) => { console.error("ECHEC", e.shortMessage || e.message); process.exit(1); });
