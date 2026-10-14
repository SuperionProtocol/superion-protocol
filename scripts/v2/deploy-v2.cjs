// Déploiement Superion V2 — TESTNET UNIQUEMENT (Base Sepolia 84532, ou réseau local hardhat 31337).
// Usage : npx hardhat run scripts/v2/deploy-v2.cjs --network baseSepolia
const fs = require("fs");
const path = require("path");
const { ethers, network } = require("hardhat");
const { StandardMerkleTree } = require("@openzeppelin/merkle-tree");
const { deployCore, deployDistribution, allocationAmounts } = require("./lib.cjs");
const { MARKETPLACE_PARAMS_TESTNET, GOV_TESTNET, S, DAY } = require("./config.cjs");
const { loadOrCreate } = require("./wallets.cjs");

const SEPOLIA_SUPER = "0xf5a6F83CE27692A247C3B2d1b7e0a3C3234300b4";
const ALLOWED = { 84532n: "baseSepolia", 31337n: "hardhat" };

async function main() {
  const { chainId } = await ethers.provider.getNetwork();
  if (!ALLOWED[chainId]) throw new Error(`REFUS : chainId ${chainId} non autorisé (testnet uniquement)`);
  const [rawSigner] = await ethers.getSigners();
  // NonceManager : évite les erreurs de nonce avec un RPC public équilibré entre plusieurs nœuds
  const deployer = new ethers.NonceManager(rawSigner);
  deployer.address = rawSigner.address;
  // Reprise après interruption : EXISTING='{"SuperionStakingV2":"0x..",...}'
  const existing = process.env.EXISTING ? JSON.parse(process.env.EXISTING) : {};
  const log = (m) => console.log(m);
  log(`Réseau ${network.name} (${chainId}) — déployeur ${deployer.address}`);

  let superToken = SEPOLIA_SUPER;
  if (chainId === 31337n) {
    const t = await (await ethers.getContractFactory("SuperionToken", deployer)).deploy(deployer.address);
    await t.waitForDeployment();
    superToken = await t.getAddress();
    log(`(local) SuperionToken @ ${superToken}`);
  }
  const token = await ethers.getContractAt("SuperionToken", superToken, deployer);
  const supply0 = await token.totalSupply();
  const bal0 = await token.balanceOf(deployer.address);
  const doneDist = process.env.EXISTING_DIST ? JSON.parse(process.env.EXISTING_DIST) : {};
  const needed = allocationAmounts().filter((b) => b.beneficiary !== "foundation" && !(doneDist[b.key] || {}).funded).reduce((a, b) => a + b.amount, 0n);
  log(`SUPER totalSupply ${ethers.formatUnits(supply0, 18)} ; solde admin ${ethers.formatUnits(bal0, 18)} ; à répartir ${ethers.formatUnits(needed, 18)}`);
  if (bal0 < needed + S(100000)) throw new Error("solde SUPER insuffisant");

  const core = await deployCore(ethers, {
    superToken, deployer, guardian: deployer.address, marketParams: MARKETPLACE_PARAMS_TESTNET, gov: GOV_TESTNET, log, existing,
  });
  const tl = await core.timelock.getAddress();

  // Airdrop démo : admin + portefeuilles de test
  const w = loadOrCreate(ethers);
  const claims = [[deployer.address, S(4000)], [w.provider.address, S(2000)], [w.verifier1.address, S(1000)], [w.verifier2.address, S(1000)], [w.verifier3.address, S(1000)], [w.challenger.address, S(1000)]];
  const tree = StandardMerkleTree.of(claims.map(([a, v]) => [a, v.toString()]), ["address", "uint256"]);
  const now = process.env.VEST_START ? BigInt(process.env.VEST_START) : BigInt((await ethers.provider.getBlock("latest")).timestamp);
  const existingDist = process.env.EXISTING_DIST ? JSON.parse(process.env.EXISTING_DIST) : {};
  const dist = await deployDistribution(ethers, {
    superToken, funder: deployer, timelock: tl, team: deployer.address, foundation: deployer.address,
    start: now, airdropRoot: tree.root, airdropDeadline: now + BigInt(30 * DAY), log, existing: existingDist,
  });

  const out = {
    network: network.name, chainId: Number(chainId), deployedAt: new Date().toISOString(), deployer: deployer.address,
    superToken,
    contracts: {
      stakingV2: await core.staking.getAddress(),
      timelock: tl,
      governor: await core.governor.getAddress(),
      marketplaceV2: await core.market.getAddress(),
    },
    params: {
      marketplace: Object.fromEntries(Object.entries(MARKETPLACE_PARAMS_TESTNET).map(([k, v]) => [k, v.toString()])),
      governance: Object.fromEntries(Object.entries(GOV_TESTNET).map(([k, v]) => [k, v.toString()])),
    },
    distribution: dist.buckets,
    airdrop: { root: tree.root, claims: claims.map(([a, v]) => ({ account: a, amount: v.toString() })), tree: tree.dump() },
    txs: { ...core.txs, ...dist.txs },
    constructorArgs: {
      stakingV2: [superToken, deployer.address, GOV_TESTNET.rewardEligibilityDelay],
      timelock: [GOV_TESTNET.timelockDelay, [], [ethers.ZeroAddress], deployer.address],
      governor: [await core.staking.getAddress(), tl, GOV_TESTNET.votingDelay, GOV_TESTNET.votingPeriod, GOV_TESTNET.proposalThreshold.toString(), GOV_TESTNET.quorumPercent, GOV_TESTNET.quorumAbsoluteMin.toString()],
      marketplaceV2: [superToken, await core.staking.getAddress(), tl, deployer.address, tl, MARKETPLACE_PARAMS_TESTNET],
    },
  };
  const dir = path.join(__dirname, "..", "..", "deployments");
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `v2.1.${network.name}.json`);
  // alias legacy
  const alias = path.join(dir, `v2.${network.name}.json`);
  const json = JSON.stringify(out, (k, v) => (typeof v === "bigint" ? v.toString() : v), 2);
  fs.writeFileSync(file, json);
  fs.writeFileSync(alias, json);
  log(`\nÉcrit : ${file} (+ alias ${alias})`);
  log(`Solde SUPER admin restant : ${ethers.formatUnits(await token.balanceOf(deployer.address), 18)}`);
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
