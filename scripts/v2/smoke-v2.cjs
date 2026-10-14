// Smoke test de bout en bout V2 — TESTNET UNIQUEMENT.
// npx hardhat run scripts/v2/smoke-v2.cjs --network baseSepolia
const fs = require("fs");
const path = require("path");
const { ethers, network } = require("hardhat");
const { S } = require("./config.cjs");
const { loadOrCreate } = require("./wallets.cjs");
const { withRetry } = require("./lib.cjs");

const fmt = (x) => ethers.formatUnits(x, 18);
const results = { steps: [], txs: {} };
let local = false;

// RPC public équilibré : on lit l'état AU BLOC du reçu (avec réessais) pour éviter les nœuds en retard.
async function at(fn, blockNumber) {
  return withRetry(async () => {
    try { return await fn({ blockTag: blockNumber }); } catch (e) { throw new Error("could not decode / retry: " + e.message); }
  }, 10);
}
let lastBlock = 0;
async function send(label, fn) {
  const tx = await withRetry(fn);
  const rc = await tx.wait();
  lastBlock = Math.max(lastBlock, rc.blockNumber);
  if (rc.status !== 1) throw new Error(`${label} a échoué`);
  results.txs[label] = tx.hash;
  console.log(`  ${label}: ${tx.hash}`);
  return rc;
}
function step(msg, data = {}) { console.log(`• ${msg}`, Object.keys(data).length ? JSON.stringify(data) : ""); results.steps.push({ msg, ...data }); }

async function waitUntil(ts, why) {
  for (;;) {
    const now = (await ethers.provider.getBlock("latest")).timestamp;
    if (now > ts) return;
    if (local) { await network.provider.send("evm_setNextBlockTimestamp", [ts + 1]); await network.provider.send("evm_mine"); return; }
    const s = Math.min(30, ts - now + 2);
    console.log(`  … attente ${ts - now + 1}s (${why})`);
    await new Promise((r) => setTimeout(r, s * 1000));
  }
}

async function main() {
  const { chainId } = await ethers.provider.getNetwork();
  if (chainId !== 84532n && chainId !== 31337n) throw new Error(`REFUS : chainId ${chainId} (testnet uniquement)`);
  local = chainId === 31337n;
  const dep = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "..", "deployments", `v2.${network.name}.json`)));
  const [admin] = await ethers.getSigners();
  const w = loadOrCreate(ethers);
  const token = await ethers.getContractAt("SuperionToken", dep.superToken, admin);
  const staking = await ethers.getContractAt("SuperionStakingV2", dep.contracts.stakingV2, admin);
  const market = await ethers.getContractAt("SuperionJobMarketplaceV2", dep.contracts.marketplaceV2, admin);
  const governor = await ethers.getContractAt("SuperionGovernor", dep.contracts.governor, admin);
  const stAddr = dep.contracts.stakingV2, mkAddr = dep.contracts.marketplaceV2;
  const P = await market.params();

  // ---------- 1. Préparation des portefeuilles ----------
  step("Financement des portefeuilles de test (ETH + SUPER)");
  const funding = { provider: 5000, verifier1: 1000, verifier2: 1000, verifier3: 1000, challenger: 100 };
  for (const [role, amt] of Object.entries(funding)) {
    const a = w[role].address;
    if ((await ethers.provider.getBalance(a)) < ethers.parseEther("0.0015")) await send(`eth_${role}`, () => admin.sendTransaction({ to: a, value: ethers.parseEther("0.002") }));
    const need = S(amt) - (await token.balanceOf(a)) - (await staking.balanceOf(a));
    if (need > 0n) await send(`super_${role}`, () => token.transfer(a, need));
  }

  step("Stake admin (pouvoir de vote + récompenses)");
  if ((await staking.balanceOf(admin.address)) < S(100000)) {
    await send("admin_approve_staking", () => token.approve(stAddr, ethers.MaxUint256));
    await send("admin_stake", () => staking.stake(S(100000)));
  }
  await send("admin_approve_market", () => token.approve(mkAddr, ethers.MaxUint256));

  for (const r of ["provider", "verifier1", "verifier2", "verifier3"]) {
    const s = w[r];
    const amt = S(funding[r]);
    const cur = await staking.balanceOf(s.address);
    if (cur < amt) {
      await send(`${r}_approve`, () => token.connect(s).approve(stAddr, ethers.MaxUint256));
      await send(`${r}_stake`, () => staking.connect(s).stake(amt - cur));
    }
    if (r.startsWith("verifier") && (await market.verifiers(s.address)).indexPlus1 === 0n) await send(`${r}_register`, () => market.connect(s).registerVerifier());
  }
  await send("challenger_approve", () => token.connect(w.challenger).approve(mkAddr, ethers.MaxUint256));
  step("Vérificateurs enregistrés", { count: (await at((o) => market.verifierCount(o), lastBlock)).toString() });

  // ---------- 2. Proposition de gouvernance (tôt, pour paralléliser les attentes) ----------
  const desc = `Superion V2 smoke: frais 2.5% -> 3% (${new Date().toISOString()})`;
  const calldata = market.interface.encodeFunctionData("setFees", [300, Number(P.burnShareBps)]);
  const descHash = ethers.id(desc);
  await waitUntil((await ethers.provider.getBlock("latest")).timestamp + 1, "checkpoint de vote");
  const rp = await send("gov_propose", () => governor.propose([mkAddr], [0], [calldata], desc));
  const pid = await governor.hashProposal([mkAddr], [0], [calldata], descHash);
  results.proposalId = pid.toString();
  const snap = await at((o) => governor.proposalSnapshot(pid, o), rp.blockNumber);
  const pdl = await at((o) => governor.proposalDeadline(pid, o), rp.blockNumber);
  step("Proposition créée", { proposalId: pid.toString(), snapshot: snap.toString(), deadline: pdl.toString() });

  // ---------- 3. Jobs ----------
  const evt = (rc, name) => rc.logs.map((l) => { try { return market.interface.parseLog(l); } catch { return null; } }).find((e) => e && e.name === name);
  const newJob = async (label, budget) => {
    const rcC = await send(`${label}_create`, () => market.createJob(S(budget), 7200, `ipfs://superion-v2-smoke/${label}`));
    const id = evt(rcC, "JobCreated").args.jobId;
    await send(`${label}_assign`, () => market.connect(w.provider).assignJob(id));
    await send(`${label}_submit`, () => market.connect(w.provider).submitResult(id, `ipfs://superion-v2-smoke/${label}/result`));
    return id;
  };
  const job1 = await newJob("job1_optimiste", 1000);
  const job2 = await newJob("job2_litige_valide", 1000);
  const job3 = await newJob("job3_litige_fraude", 500);
  results.jobs = { job1: job1.toString(), job2: job2.toString(), job3: job3.toString() };
  step("Jobs créés", results.jobs);

  const rc2 = await send("job2_challenge", () => market.connect(w.challenger).challengeJob(job2));
  const rc3 = await send("job3_challenge", () => market.connect(w.challenger).challengeJob(job3));
  const c2 = [...evt(rc2, "JobChallenged").args.committee], c3 = [...evt(rc3, "JobChallenged").args.committee];
  step("Comités tirés", { job2: c2, job3: c3 });
  const signerOf = (a) => Object.values(w).find((s) => s.address === a);

  // job2 : 2 votes "valide", le dernier membre vote contre (minoritaire -> pénalisé)
  for (let i = 0; i < c2.length; i++) await send(`job2_vote_${i}`, () => market.connect(signerOf(c2[i])).castVote(job2, i < c2.length - 1));
  // job3 : tous "invalide" -> fournisseur slashé
  for (let i = 0; i < c3.length; i++) await send(`job3_vote_${i}`, () => market.connect(signerOf(c3[i])).castVote(job3, false));

  const s0 = await at((o) => token.totalSupply(o), lastBlock);
  const rewards0 = await at((o) => staking.earned(admin.address, o), lastBlock);
  const prov0 = await at((o) => token.balanceOf(w.provider.address, o), lastBlock);
  const r2 = await send("job2_resolve", () => market.resolveDispute(job2));
  const s1 = await at((o) => token.totalSupply(o), r2.blockNumber);
  const fin2 = evt(r2, "JobFinalized").args;
  step("Litige job2 tranché (fournisseur valide, 2 contre 1)", {
    burned: fmt(s0 - s1), payout: fmt(fin2.payout), fee: fmt(fin2.fee), feeBurned: fmt(fin2.burned), toStakers: fmt(fin2.toStakers),
    providerReceived: fmt((await at((o) => token.balanceOf(w.provider.address, o), r2.blockNumber)) - prov0),
    minorityBondLeft: fmt((await at((o) => market.verifiers(c2[c2.length - 1], o), r2.blockNumber)).bond),
  });
  const pStake0 = await at((o) => staking.balanceOf(w.provider.address, o), r2.blockNumber);
  const r3 = await send("job3_resolve", () => market.resolveDispute(job3));
  const s2 = await at((o) => token.totalSupply(o), r3.blockNumber);
  step("Litige job3 tranché (fraude, 3-0)", { burned: fmt(s1 - s2), providerSlashed: fmt(pStake0 - (await at((o) => staking.balanceOf(w.provider.address, o), r3.blockNumber))) });

  // ---------- 4. Finalisation optimiste du job1 ----------
  const j1 = await at((o) => market.jobs(job1, o), r3.blockNumber);
  await waitUntil(Number(j1.challengeDeadline), "fenêtre de contestation job1");
  const r1 = await send("job1_finalize", () => market.finalizeJob(job1));
  const s3 = await at((o) => token.totalSupply(o), r1.blockNumber);
  const fin1 = evt(r1, "JobFinalized").args;
  step("Job1 finalisé sans contestation", { burned: fmt(s2 - s3), payout: fmt(fin1.payout), fee: fmt(fin1.fee), feeBurned: fmt(fin1.burned), toStakers: fmt(fin1.toStakers) });
  const rewards1 = await at((o) => staking.earned(admin.address, o), r1.blockNumber);
  step("Récompenses stakers", { adminEarnedDelta: fmt(rewards1 - rewards0), stakedTotal: fmt(await at((o) => staking.totalSupply(o), r1.blockNumber)) });
  await send("admin_claim_rewards", () => staking.claimRewards());
  results.supply = { before: fmt(s0), after: fmt(s3), burnedTotal: fmt(s0 - s3) };

  // ---------- 5. Gouvernance : vote, file, exécution ----------
  await waitUntil(Number(snap), "délai avant vote");
  await send("gov_vote_admin", () => governor.castVote(pid, 1));
  await send("gov_vote_provider", () => governor.connect(w.provider).castVote(pid, 0));
  await waitUntil(Number(pdl) + 2, "période de vote");
  const bn = (await ethers.provider.getBlock("latest")).number;
  step("Vote clos", { state: (await at((o) => governor.state(pid, o), bn)).toString(), votes: (await at((o) => governor.proposalVotes(pid, o), bn)).map(fmt) });
  const rq = await send("gov_queue", () => governor.queue([mkAddr], [0], [calldata], descHash));
  const eta = await at((o) => governor.proposalEta(pid, o), rq.blockNumber);
  await waitUntil(Number(eta) + 2, "délai du timelock");
  const rx = await send("gov_execute", () => governor.execute([mkAddr], [0], [calldata], descHash));
  step("Proposition exécutée", { state: (await at((o) => governor.state(pid, o), rx.blockNumber)).toString(), feeBps: (await at((o) => market.params(o), rx.blockNumber)).feeBps.toString() });

  const file = path.join(__dirname, "..", "..", "deployments", `v2.${network.name}.smoke.json`);
  fs.writeFileSync(file, JSON.stringify(results, (k, v) => (typeof v === "bigint" ? v.toString() : v), 2));
  console.log(`\nÉcrit : ${file}`);
}

main().catch((e) => {
  console.error(e);
  const file = path.join(__dirname, "..", "..", "deployments", `v2.${network.name}.smoke.partial.json`);
  fs.writeFileSync(file, JSON.stringify(results, (k, v) => (typeof v === "bigint" ? v.toString() : v), 2));
  process.exitCode = 1;
});
