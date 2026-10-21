// VRF-01 — Déploiement Base Sepolia UNIQUEMENT : core V2-fixes + Chainlink VRF v2.5 (abonnement payé en ETH natif).
// Étapes (reprenables, état dans deployments/vrf.baseSepolia.json) :
//   1. createSubscription + fundSubscriptionWithNative sur le coordinateur officiel Base Sepolia
//   2. deployCore (Staking, Timelock, Governor, Marketplace VRF) — le déployeur garde provisoirement l'admin du Timelock
//   3. addConsumer(subId, marketplace)
//   4. bootstrap : le Timelock accepte la propriété VRF du marketplace (schedule + execute, délai 300 s)
//   5. le déployeur renonce à PROPOSER et à l'admin du Timelock
// Usage : npx hardhat run scripts/v2/deploy-vrf-sepolia.cjs --network baseSepolia
const fs = require("fs");
const path = require("path");
const { ethers, network } = require("hardhat");
const { deployCore, waitTx, sleep, VRF_DEFAULTS } = require("./lib.cjs");
const { MARKETPLACE_PARAMS_TESTNET, GOV_TESTNET } = require("./config.cjs");

// Valeurs officielles https://docs.chain.link/vrf/v2-5/supported-networks (consultées le 2026-10-21)
const VRF_BASE_SEPOLIA = {
  coordinator: "0x5C210eF41CD1a72de73bF76eC39637bB0d3d7BEE",
  keyHash: "0x9e1344a1247c8a1785d0a4681a27152bffdb43666ae5bf7d14d24a5efd44bf71", // 30 gwei
  linkToken: "0xE4aB69C077896252FAFBD49EFD26B5D171A32410",
};
const SUPER = "0xf5a6F83CE27692A247C3B2d1b7e0a3C3234300b4";
const FUND_NATIVE = ethers.parseEther(process.env.VRF_FUND || "0.02");
const VRF_CONFIG = { ...VRF_DEFAULTS, callbackGasLimit: 500_000, requestConfirmations: 1, requestTimeout: 600, nativePayment: true };
const OUT = path.join(__dirname, "..", "..", "deployments", "vrf.baseSepolia.json");

const COORD_ABI = [
  "function createSubscription() returns (uint256)",
  "function fundSubscriptionWithNative(uint256) payable",
  "function addConsumer(uint256,address)",
  "function getSubscription(uint256) view returns (uint96 balance, uint96 nativeBalance, uint64 reqCount, address subOwner, address[] consumers)",
  "event SubscriptionCreated(uint256 indexed subId, address owner)",
];

async function main() {
  const { chainId } = await ethers.provider.getNetwork();
  if (chainId !== 84532n) throw new Error(`REFUS : chainId ${chainId} (Base Sepolia uniquement)`);
  const [raw] = await ethers.getSigners();
  const dep = new ethers.NonceManager(raw); dep.address = raw.address;
  const st = fs.existsSync(OUT) ? JSON.parse(fs.readFileSync(OUT, "utf8")) : { txs: {} };
  const save = () => fs.writeFileSync(OUT, JSON.stringify(st, null, 2) + "\n");
  const log = (m) => console.log(m);
  Object.assign(st, { version: "2.1-fixes-vrf", network: network.name, chainId: 84532, deployer: raw.address, superToken: SUPER,
    vrf: { ...VRF_BASE_SEPOLIA, ...(st.vrf || {}), config: VRF_CONFIG, docs: "https://docs.chain.link/vrf/v2-5/supported-networks" } });
  log(`ETH déployeur : ${ethers.formatEther(await ethers.provider.getBalance(raw.address))}`);
  const coord = new ethers.Contract(VRF_BASE_SEPOLIA.coordinator, COORD_ABI, dep);

  if (!st.vrf.subId) {
    const r = await waitTx(() => coord.createSubscription(), log, "vrf_createSubscription");
    const ev = r.rc.logs.map((l) => { try { return coord.interface.parseLog(l); } catch { return null; } }).find((e) => e && e.name === "SubscriptionCreated");
    st.vrf.subId = ev.args.subId.toString(); st.txs.vrf_createSubscription = r.hash; save();
  }
  log(`subId ${st.vrf.subId}`);
  if (!st.txs.vrf_fundNative) {
    st.txs.vrf_fundNative = (await waitTx(() => coord.fundSubscriptionWithNative(st.vrf.subId, { value: FUND_NATIVE }), log, "vrf_fundNative")).hash;
    st.vrf.fundedNative = ethers.formatEther(FUND_NATIVE); save();
  }

  if (!st.contracts) {
    const core = await deployCore(ethers, {
      superToken: SUPER, deployer: dep, guardian: raw.address, marketParams: MARKETPLACE_PARAMS_TESTNET, gov: GOV_TESTNET, log,
      vrf: { coordinator: VRF_BASE_SEPOLIA.coordinator, keyHash: VRF_BASE_SEPOLIA.keyHash, subId: BigInt(st.vrf.subId), config: VRF_CONFIG, keepTimelockAdmin: true },
    });
    st.contracts = {
      stakingV2: await core.staking.getAddress(), timelock: await core.timelock.getAddress(),
      governor: await core.governor.getAddress(), marketplaceV2: await core.market.getAddress(),
    };
    Object.assign(st.txs, core.txs);
    st.deployedAt = new Date().toISOString(); save();
  }
  const C = st.contracts;
  const market = await ethers.getContractAt("SuperionJobMarketplaceV2", C.marketplaceV2, dep);
  const tl = await ethers.getContractAt("SuperionTimelock", C.timelock, dep);

  if (!st.txs.vrf_addConsumer) { st.txs.vrf_addConsumer = (await waitTx(() => coord.addConsumer(st.vrf.subId, C.marketplaceV2), log, "vrf_addConsumer")).hash; save(); }

  // Bootstrap : Timelock.acceptOwnership() sur le marketplace (propriété VRF / setCoordinator).
  const PROPOSER = await tl.PROPOSER_ROLE(), ADMIN = await tl.DEFAULT_ADMIN_ROLE();
  const data = market.interface.encodeFunctionData("acceptOwnership");
  const salt = ethers.id("superion-vrf-accept-ownership");
  if ((await market.owner()) !== C.timelock) {
    if (!st.txs.tl_schedule_accept) {
      if (!(await tl.hasRole(PROPOSER, raw.address))) st.txs.tl_grant_proposer_deployer_tmp = (await waitTx(() => tl.grantRole(PROPOSER, raw.address), log, "tl_grant_proposer_deployer_tmp")).hash;
      st.txs.tl_schedule_accept = (await waitTx(() => tl.schedule(C.marketplaceV2, 0, data, ethers.ZeroHash, salt, GOV_TESTNET.timelockDelay), log, "tl_schedule_accept")).hash; save();
    }
    const id = await tl.hashOperation(C.marketplaceV2, 0, data, ethers.ZeroHash, salt);
    while (!(await tl.isOperationReady(id))) { log("attente délai Timelock…"); await sleep(30000); }
    st.txs.tl_execute_accept = (await waitTx(() => tl.execute(C.marketplaceV2, 0, data, ethers.ZeroHash, salt), log, "tl_execute_accept")).hash; save();
  }
  if (await tl.hasRole(PROPOSER, raw.address)) { st.txs.tl_revoke_proposer_deployer = (await waitTx(() => tl.renounceRole(PROPOSER, raw.address), log, "tl_renounce_proposer_deployer")).hash; save(); }
  if (await tl.hasRole(ADMIN, raw.address)) { st.txs.tl_renounce_admin_deployer = (await waitTx(() => tl.renounceRole(ADMIN, raw.address), log, "tl_renounce_admin_deployer")).hash; save(); }

  st.checks = {
    marketOwner: await market.owner(),
    marketAdminIsTimelock: await market.hasRole(ADMIN, C.timelock),
    deployerTimelockAdmin: await tl.hasRole(ADMIN, raw.address),
    coordinator: await market.s_vrfCoordinator(),
    codeSizeMarket: ((await ethers.provider.getCode(C.marketplaceV2)).length - 2) / 2,
  };
  const sub = await coord.getSubscription(st.vrf.subId);
  st.vrf.subscription = { nativeBalance: ethers.formatEther(sub.nativeBalance), owner: sub.subOwner, consumers: sub.consumers };
  save();
  log(JSON.stringify(st.checks, null, 2));
}
main().catch((e) => { console.error(e); process.exit(1); });
