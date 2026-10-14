// Déploie le SuperFaucet (TESTNET UNIQUEMENT) et l'alimente depuis l'admin.
// Usage : npx hardhat run scripts/v2/deploy-faucet.cjs --network baseSepolia
const fs = require("fs");
const path = require("path");
const hre = require("hardhat");
const { ethers } = hre;
const { waitTx, withRetry } = require("./lib.cjs");

const SUPER = "0xf5a6F83CE27692A247C3B2d1b7e0a3C3234300b4";
const DRIP = ethers.parseEther("100");
const COOLDOWN = 24 * 3600;
const FUND = ethers.parseEther("100000");
const OUT = path.join(__dirname, "..", "..", "deployments", "faucet.baseSepolia.json");

(async () => {
  const net = await ethers.provider.getNetwork();
  if (net.chainId !== 84532n) throw new Error(`Refus : chainId ${net.chainId} (Base Sepolia 84532 uniquement)`);
  const [admin] = await ethers.getSigners();
  const adminAddr = await admin.getAddress();
  const out = fs.existsSync(OUT) ? JSON.parse(fs.readFileSync(OUT, "utf8")) : { network: "baseSepolia", chainId: 84532, token: SUPER, txs: {} };
  const log = (m) => console.log(m);

  let faucet;
  if (out.faucet) {
    faucet = await ethers.getContractAt("SuperFaucet", out.faucet, admin);
    log(`SuperFaucet (existant) @ ${out.faucet}`);
  } else {
    const F = await ethers.getContractFactory("SuperFaucet", admin);
    faucet = await withRetry(() => F.deploy(SUPER, adminAddr, DRIP, COOLDOWN));
    const rc = await faucet.deploymentTransaction().wait();
    out.faucet = await faucet.getAddress();
    out.deployBlock = rc.blockNumber;
    out.owner = adminAddr;
    out.constructorArgs = [SUPER, adminAddr, DRIP.toString(), COOLDOWN];
    out.deployedAt = new Date().toISOString();
    out.txs.deploy = faucet.deploymentTransaction().hash;
    fs.writeFileSync(OUT, JSON.stringify(out, null, 2));
    log(`SuperFaucet @ ${out.faucet} (${out.txs.deploy})`);
  }

  const token = await ethers.getContractAt("SuperionToken", SUPER, admin);
  const bal = await token.balanceOf(out.faucet);
  if (bal < FUND) {
    const need = FUND - bal;
    out.txs.fund = (await waitTx(() => token.transfer(out.faucet, need), log, "fund (transfer)")).hash;
    out.funded = ethers.formatEther(FUND);
    fs.writeFileSync(OUT, JSON.stringify(out, null, 2));
  } else log("déjà alimenté");
  log(`solde faucet : ${ethers.formatEther(await token.balanceOf(out.faucet))} SUPER`);
  fs.mkdirSync(path.join(__dirname, "..", "..", "deployments", "verify-args-faucet"), { recursive: true });
  fs.writeFileSync(path.join(__dirname, "..", "..", "deployments", "verify-args-faucet", "superFaucet.cjs"),
    `module.exports = ${JSON.stringify(out.constructorArgs, null, 1)};\n`);
})().catch((e) => { console.error(e.shortMessage || e.message); process.exit(1); });
