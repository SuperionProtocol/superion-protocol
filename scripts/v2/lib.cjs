// Déploiement V2 partagé par les tests et le script Sepolia.
const { DISTRIBUTION, TOTAL_SUPPLY } = require("./config.cjs");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Le compte admin Sepolia est délégué EIP-7702 : une seule transaction "en vol" autorisée.
// On réessaie si le nœud RPC signale encore la précédente comme en attente.
async function withRetry(fn, tries = 8) {
  for (let i = 0; ; i++) {
    try { return await fn(); } catch (e) {
      const m = String(e && (e.message || e));
      if (i >= tries || !/in-flight|nonce too low|replacement|underpriced|could not decode|execution reverted|header not found|missing trie node/i.test(m)) throw e;
      await sleep(3000 * (i + 1));
    }
  }
}

async function waitTx(txPromise, log, label) {
  const tx = await (typeof txPromise === "function" ? withRetry(txPromise) : txPromise);
  const rc = await tx.wait();
  if (log) log(`${label}: ${tx.hash}`);
  return { tx, rc, hash: tx.hash };
}

/**
 * Déploie StakingV2, Timelock, Governor, MarketplaceV2 et câble les rôles.
 * Le déployeur n'a plus aucun rôle admin à la fin (tout passe par le Timelock),
 * sauf `guardian` : PAUSER du marketplace + CANCELLER du timelock (veto d'urgence, révocable par la gouvernance).
 */
const ROLE = {
  DEFAULT_ADMIN: "0x" + "00".repeat(32),
  PROPOSER: null, CANCELLER: null, OPERATOR: null,
};

/** VRF-01 : config VRF par défaut (testnet / tests). keyHash/subId/coordinateur fournis par l'appelant. */
const VRF_DEFAULTS = { callbackGasLimit: 1_500_000, requestConfirmations: 1, requestTimeout: 600, nativePayment: true };

/** Tests uniquement (chainId 31337) : déploie le mock officiel Chainlink VRFCoordinatorV2_5Mock + abonnement natif. */
async function deployVrfMock(ethers, deployer) {
  const { chainId } = await ethers.provider.getNetwork();
  if (chainId !== 31337n) throw new Error("mock VRF réservé au réseau local");
  const M = await ethers.getContractFactory("VRFCoordinatorV2_5Mock", deployer);
  const mock = await M.deploy(ethers.parseEther("0.0001"), 1_000_000_000n, 4_000_000_000_000_000n);
  await mock.waitForDeployment();
  const rc = await (await mock.createSubscription()).wait();
  const subId = rc.logs.map((l) => { try { return mock.interface.parseLog(l); } catch { return null; } })
    .find((e) => e && e.name === "SubscriptionCreated").args.subId;
  await (await mock.fundSubscriptionWithNative(subId, { value: ethers.parseEther("100") })).wait();
  return { mock, coordinator: await mock.getAddress(), subId, keyHash: ethers.id("superion-test-keyhash") };
}

async function deployCore(ethers, { superToken, deployer, guardian, marketParams, gov, log, existing = {}, vrf }) {
  ROLE.PROPOSER = ethers.id("PROPOSER_ROLE");
  ROLE.CANCELLER = ethers.id("CANCELLER_ROLE");
  ROLE.OPERATOR = ethers.id("OPERATOR_ROLE");
  const txs = {};
  const dep = await deployer.getAddress();
  const d = async (name, args) => {
    if (existing[name]) {
      if (log) log(`${name} (existant) @ ${existing[name]}`);
      return ethers.getContractAt(name, existing[name], deployer);
    }
    const F = await ethers.getContractFactory(name, deployer);
    const c = await withRetry(() => F.deploy(...args));
    await c.deploymentTransaction().wait();
    await c.waitForDeployment();
    txs[`deploy_${name}`] = c.deploymentTransaction().hash;
    if (log) log(`${name} @ ${await c.getAddress()} (${c.deploymentTransaction().hash})`);
    return c;
  };

  const staking = await d("SuperionStakingV2", [superToken, dep, gov.rewardEligibilityDelay]);
  const stAddr = await staking.getAddress();
  const timelock = await d("SuperionTimelock", [gov.timelockDelay, [], [ethers.ZeroAddress], dep]);
  const tl = await timelock.getAddress();
  const governor = await d("SuperionGovernor", [
    stAddr, tl, gov.votingDelay, gov.votingPeriod, gov.proposalThreshold, gov.quorumPercent, gov.quorumAbsoluteMin,
  ]);
  let vrfMock;
  if (!vrf) { vrfMock = await deployVrfMock(ethers, deployer); vrf = vrfMock; }
  const vrfConfig = { ...VRF_DEFAULTS, ...(vrf.config || {}), keyHash: vrf.keyHash, subId: vrf.subId };
  const market = await d("SuperionJobMarketplaceV2", [superToken, stAddr, tl, guardian, tl, marketParams, vrf.coordinator, vrfConfig]);
  const gAddr = await governor.getAddress();
  const mAddr = await market.getAddress();

  // Envoi idempotent (rôles déjà en place = ignoré). Les identifiants de rôles sont calculés
  // localement (pas de lecture RPC, le RPC public peut être en retard).
  const grant = async (label, c, role, who) => {
    if (await c.hasRole(role, who).catch(() => false)) { if (log) log(`${label}: déjà fait`); return; }
    txs[label] = (await waitTx(() => c.grantRole(role, who), log, label)).hash;
  };
  const renounce = async (label, c, role) => {
    if (!(await c.hasRole(role, dep).catch(() => true))) { if (log) log(`${label}: déjà fait`); return; }
    txs[label] = (await waitTx(() => c.renounceRole(role, dep), log, label)).hash;
  };

  // Timelock : le Governor propose/annule ; tout le monde peut exécuter ; le gardien peut annuler.
  await grant("tl_grant_proposer_governor", timelock, ROLE.PROPOSER, gAddr);
  await grant("tl_grant_canceller_governor", timelock, ROLE.CANCELLER, gAddr);
  if (guardian && guardian !== ethers.ZeroAddress) await grant("tl_grant_canceller_guardian", timelock, ROLE.CANCELLER, guardian);
  // StakingV2 : le marketplace verrouille/slashe ; admin -> Timelock
  await grant("st_grant_operator_market", staking, ROLE.OPERATOR, mAddr);
  await grant("st_grant_admin_timelock", staking, ROLE.DEFAULT_ADMIN, tl);
  await renounce("st_renounce_admin_deployer", staking, ROLE.DEFAULT_ADMIN);
  // Marketplace : admin = Timelock dès le constructeur (ARBITER_ROLE aussi)
  // Timelock : le déployeur renonce à son rôle admin (le timelock s'administre lui-même)
  if (vrfMock) await (await vrfMock.mock.addConsumer(vrfMock.subId, mAddr)).wait();
  // VRF-01 : la propriété VRF (setCoordinator) part au Timelock ; il doit appeler acceptOwnership()
  // (en test : signer imposteur ; sur testnet : bootstrap timelock avant renonciation, cf. deploy-vrf-sepolia.cjs).
  if ((await market.owner()) === dep && !existing.SuperionJobMarketplaceV2) {
    txs.mk_transfer_vrf_owner_timelock = (await waitTx(() => market.transferOwnership(tl), log, "mk_transfer_vrf_owner_timelock")).hash;
  }
  if (!vrf.keepTimelockAdmin) await renounce("tl_renounce_admin_deployer", timelock, ROLE.DEFAULT_ADMIN);

  return { staking, timelock, governor, market, txs, vrf: vrfMock, vrfConfig };
}

/** Calcule les montants de la répartition (somme exacte = offre totale). */
function allocationAmounts(totalSupply = TOTAL_SUPPLY) {
  const pctSum = DISTRIBUTION.reduce((a, b) => a + b.pct, 0);
  if (pctSum !== 100) throw new Error(`répartition = ${pctSum} % (≠ 100)`);
  return DISTRIBUTION.map((b) => ({ ...b, amount: (totalSupply * BigInt(b.pct)) / 100n }));
}

/**
 * Déploie les VestingWallets + l'airdrop démo et les finance depuis `funder` (testnet).
 * La part "foundation" reste chez `foundation` (le Safe sur mainnet, l'admin sur testnet).
 */
async function deployDistribution(ethers, { superToken, funder, timelock, team, foundation, start, airdropRoot, airdropDeadline, log, existing = {} }) {
  const token = await ethers.getContractAt("SuperionToken", superToken, funder);
  const who = { timelock, team, foundation };
  const out = { buckets: [], txs: {} };
  for (const b of allocationAmounts()) {
    const entry = { key: b.key, label: b.label, pct: b.pct, amount: b.amount.toString(), beneficiary: who[b.beneficiary] };
    const ex = existing[b.key] || {};
    if (b.vesting) {
      if (ex.vesting) {
        entry.vesting = ex.vesting;
        if (log) log(`Vesting ${b.key} (existant) @ ${entry.vesting}`);
      } else {
        const F = await ethers.getContractFactory("SuperionVesting", funder);
        const v = await withRetry(() => F.deploy(b.label, who[b.beneficiary], start, b.vesting.duration, b.vesting.cliff));
        await v.deploymentTransaction().wait();
        await v.waitForDeployment();
        entry.vesting = await v.getAddress();
        out.txs[`deploy_vesting_${b.key}`] = v.deploymentTransaction().hash;
        if (log) log(`Vesting ${b.key} @ ${entry.vesting}`);
      }
      entry.start = Number(start); entry.duration = b.vesting.duration; entry.cliff = b.vesting.cliff;
      if (!ex.funded) out.txs[`fund_${b.key}`] = (await waitTx(() => token.transfer(entry.vesting, b.amount), log, `fund_${b.key}`)).hash;
    } else if (b.beneficiary === "foundation") {
      entry.note = "reste chez la fondation (Safe sur mainnet / admin sur testnet)";
    } else {
      let direct = b.amount;
      if (b.airdropDemo && airdropRoot) {
        if (ex.airdrop) entry.airdrop = ex.airdrop;
        else {
          const F = await ethers.getContractFactory("SuperionMerkleAirdrop", funder);
          const a = await withRetry(() => F.deploy(superToken, airdropRoot, airdropDeadline, timelock));
          await a.deploymentTransaction().wait();
          await a.waitForDeployment();
          entry.airdrop = await a.getAddress();
          out.txs.deploy_airdrop = a.deploymentTransaction().hash;
          if (log) log(`Airdrop @ ${entry.airdrop}`);
        }
        entry.airdropAmount = b.airdropDemo.toString();
        if (!ex.funded) out.txs.fund_airdrop = (await waitTx(() => token.transfer(entry.airdrop, b.airdropDemo), log, "fund_airdrop")).hash;
        direct -= b.airdropDemo;
      }
      if (!ex.funded) out.txs[`fund_${b.key}`] = (await waitTx(() => token.transfer(who[b.beneficiary], direct), log, `fund_${b.key}`)).hash;
    }
    out.buckets.push(entry);
  }
  return out;
}

module.exports = { ROLE, VRF_DEFAULTS, deployVrfMock, deployCore, deployDistribution, allocationAmounts, waitTx, withRetry, sleep };
