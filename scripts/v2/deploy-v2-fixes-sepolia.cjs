// Déploiement Superion V2-fixes CORE (staking 14 j + marketplace appel/re-tirage/gel) — Base Sepolia UNIQUEMENT.
// Ne redistribue PAS l'offre (vestings V2 déjà financés). Admin garde les rôles gardien.
// Usage : npx hardhat run scripts/v2/deploy-v2.1-core.cjs --network baseSepolia
const fs = require("fs");
const path = require("path");
const { ethers, network } = require("hardhat");
const { deployCore } = require("./lib.cjs");
const { MARKETPLACE_PARAMS_TESTNET, GOV_TESTNET } = require("./config.cjs");

const SEPOLIA_SUPER = "0xf5a6F83CE27692A247C3B2d1b7e0a3C3234300b4";
const ALLOWED = { 84532n: "baseSepolia", 31337n: "hardhat" };

async function main() {
  const { chainId } = await ethers.provider.getNetwork();
  if (!ALLOWED[chainId]) throw new Error(`REFUS : chainId ${chainId} non autorisé (testnet uniquement)`);
  const [rawSigner] = await ethers.getSigners();
  const deployer = new ethers.NonceManager(rawSigner);
  deployer.address = rawSigner.address;
  const existing = process.env.EXISTING ? JSON.parse(process.env.EXISTING) : {};
  const log = (m) => console.log(m);
  log(`V2.1 CORE — ${network.name} (${chainId}) — déployeur ${deployer.address}`);

  let superToken = SEPOLIA_SUPER;
  if (chainId === 31337n) {
    const t = await (await ethers.getContractFactory("SuperionToken", deployer)).deploy(deployer.address);
    await t.waitForDeployment();
    superToken = await t.getAddress();
    log(`(local) SuperionToken @ ${superToken}`);
  }

  const eth = await ethers.provider.getBalance(deployer.address);
  log(`ETH déployeur : ${ethers.formatEther(eth)}`);
  if (eth < ethers.parseEther("0.01")) throw new Error("ETH insuffisant pour déployer");

  const core = await deployCore(ethers, {
    superToken, deployer, guardian: deployer.address,
    marketParams: MARKETPLACE_PARAMS_TESTNET, gov: GOV_TESTNET, log, existing,
  });
  const tl = await core.timelock.getAddress();

  const out = {
    version: "2.1-fixes",
    network: network.name,
    chainId: Number(chainId),
    deployedAt: new Date().toISOString(),
    deployer: deployer.address,
    superToken,
    note: "Core only — pas de redistribution token (vestings V2 inchangés). Admin=Timelock, gardien=deployer (PAUSER+CANCELLER).",
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
    txs: core.txs,
    constructorArgs: {
      stakingV2: [superToken, deployer.address, GOV_TESTNET.rewardEligibilityDelay],
      timelock: [GOV_TESTNET.timelockDelay, [], [ethers.ZeroAddress], deployer.address],
      governor: [
        await core.staking.getAddress(), tl,
        GOV_TESTNET.votingDelay, GOV_TESTNET.votingPeriod,
        GOV_TESTNET.proposalThreshold.toString(), GOV_TESTNET.quorumPercent,
        GOV_TESTNET.quorumAbsoluteMin.toString(),
      ],
      marketplaceV2: [superToken, await core.staking.getAddress(), tl, deployer.address, tl, MARKETPLACE_PARAMS_TESTNET],
    },
    previousV2: {
      stakingV2: "0x3BB43582ABca413d43a21F0E83C03FB242d6A2d2",
      timelock: "0xa47Cd880622E1B39b63BCE1f96CC4e095428910a",
      governor: "0x878042F1fbcCe748eCEe3C8222aF5634f4391BEf",
      marketplaceV2: "0xd389dE5c46BB9957A5FAf628fa637c2dF3A07962",
    },
  };

  const dir = path.join(__dirname, "..", "..", "deployments");
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `v2-fixes.${network.name}.json`);
  const json = JSON.stringify(out, (k, v) => (typeof v === "bigint" ? v.toString() : v), 2);
  fs.writeFileSync(file, json);
  // Pointer l'alias smoke vers V2.1
  // (pas d alias smoke : déploiement parallèle V2-fixes)
  log(`\nÉcrit : ${file}`);
  log(JSON.stringify(out.contracts, null, 2));
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
