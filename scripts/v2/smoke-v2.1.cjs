// Smoke V2.1 — commit-reveal comité + votes. TESTNET UNIQUEMENT.
// npx hardhat run scripts/v2/smoke-v2.1.cjs --network baseSepolia
const fs = require("fs");
const path = require("path");
const { ethers, network } = require("hardhat");
const { S, MARKETPLACE_PARAMS_TESTNET: MP, GOV_TESTNET: GOV } = require("./config.cjs");
const { loadOrCreate } = require("./wallets.cjs");
const { withRetry } = require("./lib.cjs");

const fmt = (x) => ethers.formatUnits(x, 18);
const results = { version: "2.1", steps: [], txs: {} };
let local = false;

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
  if (rc.status !== 1) throw new Error(`${label} a échoué (status=${rc.status}, gasUsed=${rc.gasUsed})`);
  results.txs[label] = tx.hash;
  console.log(`  ${label}: ${tx.hash}`);
  return rc;
}
const STAKE_GAS = { gasLimit: 500_000n };
const HI_GAS = { gasLimit: 1_200_000n };
function step(msg, data = {}) { console.log(`• ${msg}`, Object.keys(data).length ? JSON.stringify(data) : ""); results.steps.push({ msg, ...data }); }

async function waitUntil(ts, why) {
  for (;;) {
    const now = (await ethers.provider.getBlock("latest")).timestamp;
    if (now > ts) return;
    if (local) { await network.provider.send("evm_setNextBlockTimestamp", [ts + 1]); await network.provider.send("evm_mine"); return; }
    const s = Math.min(30, Math.max(3, ts - now + 2));
    console.log(`  … attente ${ts - now + 1}s (${why})`);
    await new Promise((r) => setTimeout(r, s * 1000));
  }
}

function seedCommit(seed) {
  return ethers.keccak256(ethers.AbiCoder.defaultAbiCoder().encode(["bytes32"], [seed]));
}
function voteCommit(providerValid, salt, voter, jobId) {
  return ethers.keccak256(ethers.AbiCoder.defaultAbiCoder().encode(
    ["bool", "bytes32", "address", "uint256"], [providerValid, salt, voter, jobId]
  ));
}

async function main() {
  const { chainId } = await ethers.provider.getNetwork();
  if (chainId !== 84532n && chainId !== 31337n) throw new Error(`REFUS : chainId ${chainId}`);
  local = chainId === 31337n;
  const depFile = path.join(__dirname, "..", "..", "deployments", `v2.1.${network.name}.json`);
  const dep = JSON.parse(fs.readFileSync(depFile));
  const [admin] = await ethers.getSigners();
  const w = loadOrCreate(ethers);
  const token = await ethers.getContractAt("SuperionToken", dep.superToken, admin);
  const staking = await ethers.getContractAt("SuperionStakingV2", dep.contracts.stakingV2, admin);
  const market = await ethers.getContractAt("SuperionJobMarketplaceV2", dep.contracts.marketplaceV2, admin);
  const governor = await ethers.getContractAt("SuperionGovernor", dep.contracts.governor, admin);
  const stAddr = dep.contracts.stakingV2, mkAddr = dep.contracts.marketplaceV2;
  const P = await market.params();
  const minStake = P.minVerifierStake;

  step("Financement portefeuilles (ETH + SUPER)");
  const funding = { provider: 5000, verifier1: 2000, verifier2: 2000, verifier3: 2000, challenger: 100 };
  for (const [role, amt] of Object.entries(funding)) {
    const a = w[role].address;
    if ((await ethers.provider.getBalance(a)) < ethers.parseEther("0.001"))
      await send(`eth_${role}`, () => admin.sendTransaction({ to: a, value: ethers.parseEther("0.003") }));
    const need = S(amt) - (await token.balanceOf(a)) - (await staking.balanceOf(a));
    if (need > 0n) await send(`super_${role}`, () => token.transfer(a, need));
  }

  step("Stake admin + vérificateurs (attendre éligibilité rewards)");
  if ((await staking.balanceOf(admin.address)) < S(100000)) {
    await send("admin_approve_staking", () => token.approve(stAddr, ethers.MaxUint256));
    await send("admin_stake", () => staking.stake(S(100000), STAKE_GAS));
  }
  await send("admin_approve_market", () => token.approve(mkAddr, ethers.MaxUint256));

  for (const r of ["provider", "verifier1", "verifier2", "verifier3"]) {
    const s = w[r];
    const amt = S(funding[r]);
    let cur = await withRetry(() => staking.balanceOf(s.address));
    if (cur < amt) {
      await send(`${r}_approve`, () => token.connect(s).approve(stAddr, ethers.MaxUint256));
      await send(`${r}_stake`, () => staking.connect(s).stake(amt - cur, STAKE_GAS));
      cur = amt; // évite relecture RPC en retard
    }
    if (r.startsWith("verifier") && (await withRetry(() => market.verifiers(s.address))).indexPlus1 === 0n) {
      // Ne pas re-lire availableStake (RPC public peut être en retard) : registerVerifier revert sinon.
      await send(`${r}_register`, () => market.connect(s).registerVerifier());
    }
  }
  await send("challenger_approve", () => token.connect(w.challenger).approve(mkAddr, ethers.MaxUint256));

  // Attendre éligibilité rewards (M-05)
  const elig = Number((await staking.rewardEligibleAt(admin.address)).toString()) || (await ethers.provider.getBlock("latest")).timestamp;
  await waitUntil(elig + 2, "éligibilité rewards");
  step("Vérificateurs", { count: (await market.verifierCount()).toString() });

  // Gouvernance tôt
  const desc = `Superion V2.1 smoke: frais -> 3% (${new Date().toISOString()})`;
  const calldata = market.interface.encodeFunctionData("setFees", [300, Number(P.burnShareBps)]);
  const descHash = ethers.id(desc);
  await waitUntil((await ethers.provider.getBlock("latest")).timestamp + 1, "checkpoint vote");
  const rp = await send("gov_propose", () => governor.propose([mkAddr], [0], [calldata], desc));
  const pid = await governor.hashProposal([mkAddr], [0], [calldata], descHash);
  results.proposalId = pid.toString();
  const snap = await at((o) => governor.proposalSnapshot(pid, o), rp.blockNumber);
  const pdl = await at((o) => governor.proposalDeadline(pid, o), rp.blockNumber);
  step("Proposition", { proposalId: pid.toString() });

  const evt = (rc, name) => rc.logs.map((l) => { try { return market.interface.parseLog(l); } catch { return null; } }).find((e) => e && e.name === name);
  const newJob = async (label, budget) => {
    const rcC = await send(`${label}_create`, () => market.createJob(S(budget), 7200, `ipfs://v21-smoke/${label}`));
    const id = evt(rcC, "JobCreated").args.jobId;
    await send(`${label}_assign`, () => market.connect(w.provider).assignJob(id));
    await send(`${label}_submit`, () => market.connect(w.provider).submitResult(id, `ipfs://v21-smoke/${label}/result`));
    return id;
  };
  const job1 = await newJob("job1_optimiste", 1000);
  const job2 = await newJob("job2_litige_valide", 1000);
  const job3 = await newJob("job3_litige_fraude", 500);
  results.jobs = { job1: job1.toString(), job2: job2.toString(), job3: job3.toString() };

  const challengeSelect = async (label, jobId) => {
    const seed = ethers.id(`${label}-${Date.now()}`);
    await send(`${label}_challenge`, () => market.connect(w.challenger).challengeJob(jobId, seedCommit(seed)));
    const d = await market.disputes(jobId);
    await waitUntil(Number(d.seedRevealEarliest) + 1, `seed reveal ${label}`);
    const rc = await send(`${label}_reveal_committee`, () => market.connect(w.challenger).revealCommittee(jobId, seed));
    const committee = [...evt(rc, "CommitteeSelected").args.committee];
    return committee;
  };

  const c2 = await challengeSelect("job2", job2);
  const c3 = await challengeSelect("job3", job3);
  step("Comités", { job2: c2, job3: c3 });
  const signerOf = (a) => Object.values(w).find((s) => s.address === a);

  // Votes commit-reveal
  const voteFlow = async (label, jobId, committee, voteFns) => {
    const salts = committee.map((_, i) => ethers.id(`${label}-salt-${i}`));
    for (let i = 0; i < committee.length; i++) {
      const h = voteCommit(voteFns[i], salts[i], committee[i], jobId);
      await send(`${label}_commit_${i}`, () => market.connect(signerOf(committee[i])).commitVote(jobId, h));
    }
    const d = await market.disputes(jobId);
    await waitUntil(Number(d.voteCommitDeadline) + 1, `vote reveal ${label}`);
    for (let i = 0; i < committee.length; i++) {
      await send(`${label}_reveal_${i}`, () => market.connect(signerOf(committee[i])).revealVote(jobId, voteFns[i], salts[i]));
    }
  };

  await voteFlow("job2", job2, c2, c2.map((_, i) => i < c2.length - 1)); // 2 true, 1 false
  await voteFlow("job3", job3, c3, c3.map(() => false));

  const s0 = await at((o) => token.totalSupply(o), lastBlock);
  const rewards0 = await at((o) => staking.earned(admin.address, o), lastBlock);
  const prov0 = await at((o) => token.balanceOf(w.provider.address, o), lastBlock);
  const r2 = await send("job2_resolve", () => market.resolveDispute(job2, HI_GAS));
  const s1 = await at((o) => token.totalSupply(o), r2.blockNumber);
  const fin2 = evt(r2, "JobFinalized").args;
  step("Litige job2 (2 contre 1)", {
    burned: fmt(s0 - s1), payout: fmt(fin2.payout), feeBurned: fmt(fin2.burned),
    minorityBond: fmt((await at((o) => market.verifiers(c2[c2.length - 1], o), r2.blockNumber)).bond),
  });

  const pStake0 = await at((o) => staking.balanceOf(w.provider.address, o), r2.blockNumber);
  const r3 = await send("job3_resolve", () => market.resolveDispute(job3, HI_GAS));
  const s2 = await at((o) => token.totalSupply(o), r3.blockNumber);
  step("Litige job3 (fraude 3-0)", {
    burned: fmt(s1 - s2),
    providerSlashed: fmt(pStake0 - (await at((o) => staking.balanceOf(w.provider.address, o), r3.blockNumber))),
  });

  const j1 = await at((o) => market.jobs(job1, o), r3.blockNumber);
  await waitUntil(Number(j1.challengeDeadline) + 1, "challenge job1");
  const r1 = await send("job1_finalize", () => market.finalizeJob(job1, HI_GAS));
  const s3 = await at((o) => token.totalSupply(o), r1.blockNumber);
  const fin1 = evt(r1, "JobFinalized").args;
  step("Job1 optimiste", { burned: fmt(s2 - s3), payout: fmt(fin1.payout), toStakers: fmt(fin1.toStakers) });
  const rewards1 = await at((o) => staking.earned(admin.address, o), r1.blockNumber);
  step("Récompenses", { adminDelta: fmt(rewards1 - rewards0) });
  if (rewards1 > rewards0) await send("admin_claim_rewards", () => staking.claimRewards());
  results.supply = { before: fmt(s0), after: fmt(s3), burnedTotal: fmt(s0 - s3) };

  await waitUntil(Number(snap) + 1, "délai vote gov");
  await send("gov_vote_admin", () => governor.castVote(pid, 1));
  await send("gov_vote_provider", () => governor.connect(w.provider).castVote(pid, 0));
  await waitUntil(Number(pdl) + 2, "fin vote gov");
  const bn = (await ethers.provider.getBlock("latest")).number;
  step("Vote clos", { state: (await at((o) => governor.state(pid, o), bn)).toString() });
  const rq = await send("gov_queue", () => governor.queue([mkAddr], [0], [calldata], descHash));
  const eta = await at((o) => governor.proposalEta(pid, o), rq.blockNumber);
  await waitUntil(Number(eta) + 2, "timelock");
  const rx = await send("gov_execute", () => governor.execute([mkAddr], [0], [calldata], descHash));
  step("Gov exécutée", { feeBps: (await at((o) => market.params(o), rx.blockNumber)).feeBps.toString() });

  const file = path.join(__dirname, "..", "..", "deployments", `v2.1.${network.name}.smoke.json`);
  fs.writeFileSync(file, JSON.stringify(results, (k, v) => (typeof v === "bigint" ? v.toString() : v), 2));
  console.log(`\nÉcrit : ${file}`);
}

main().catch((e) => {
  console.error(e);
  const file = path.join(__dirname, "..", "..", "deployments", `v2.1.${network.name}.smoke.partial.json`);
  fs.writeFileSync(file, JSON.stringify(results, (k, v) => (typeof v === "bigint" ? v.toString() : v), 2));
  process.exitCode = 1;
});
