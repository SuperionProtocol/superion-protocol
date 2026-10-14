// Recette de bout en bout V2.1 (Base Sepolia) : mêmes appels que app.html.
// Usage : UI_JOB=<id> npx hardhat run scripts/v2/e2e-app-v21.cjs --network baseSepolia
const fs = require("fs");
const path = require("path");
const { ethers } = require("hardhat");
const { loadOrCreate } = require("./wallets.cjs");
const { withRetry, sleep } = require("./lib.cjs");

const A = {
  token: "0xf5a6F83CE27692A247C3B2d1b7e0a3C3234300b4",
  staking: "0xA4924DF82bb5bE5C1357A3DA3b0657A3d5dC4630",
  market: "0xe7e59308bC3f44E00f4B0546AF146ad8d662BE51",
  faucet: JSON.parse(fs.readFileSync(path.join(__dirname, "..", "..", "deployments", "faucet.baseSepolia.json"), "utf8")).faucet,
};
const OUT = path.join(__dirname, "..", "..", "deployments", "app-v21.e2e.json");
const out = { startedAt: new Date().toISOString(), txs: {}, checks: {}, notes: [] };
const save = () => fs.writeFileSync(OUT, JSON.stringify(out, null, 2));
const log = (m) => { console.log(m); };
const coder = ethers.AbiCoder.defaultAbiCoder();
const F = (v) => ethers.formatEther(v);

// Même logique que sendTx() de app.html : estimateGas (motif du refus avant signature) puis marge ×1,3.
async function send(label, contract, signer, method, args = []) {
  const c = contract.connect(signer);
  const hash = await withRetry(async () => {
    const gas = await c[method].estimateGas(...args);
    const tx = await c[method](...args, { gasLimit: (gas * 13n) / 10n + 15000n });
    const rc = await tx.wait();
    if (rc.status !== 1) throw new Error(label + " revert");
    return tx.hash;
  }, 4);
  out.txs[label] = hash; save();
  log(`${label}: ${hash}`);
  return hash;
}
async function expectRevert(label, contract, signer, method, args, errName) {
  try { await contract.connect(signer)[method].staticCall(...args); out.checks[label] = "PAS DE REVERT (inattendu)"; }
  catch (e) {
    let name = e.revert && e.revert.name;
    if (!name && e.data) { try { name = contract.interface.parseError(e.data).name; } catch {} }
    out.checks[label] = name === errName ? `revert ${name} (attendu)` : `revert ${name || e.shortMessage} (attendu : ${errName})`;
  }
  log(`${label}: ${out.checks[label]}`); save();
}
async function waitUntil(ts, why) {
  for (;;) {
    const b = await ethers.provider.getBlock("latest");
    if (b.timestamp > ts) return;
    const d = Number(ts) - b.timestamp + 3;
    log(`  attente ${d}s (${why})`);
    await sleep(Math.min(d, 30) * 1000);
  }
}

(async () => {
  if ((await ethers.provider.getNetwork()).chainId !== 84532n) throw new Error("Base Sepolia uniquement");
  const [admin] = await ethers.getSigners();
  const W = loadOrCreate(ethers);
  const token = await ethers.getContractAt("SuperionToken", A.token);
  const staking = await ethers.getContractAt("SuperionStakingV2", A.staking);
  const market = await ethers.getContractAt("SuperionJobMarketplaceV2", A.market);
  const faucet = await ethers.getContractAt("SuperFaucet", A.faucet);
  const p = await market.params();
  out.params = { feeBps: p.feeBps.toString(), burnShareBps: p.burnShareBps.toString(), challengePeriod: p.challengePeriod.toString(), challengeBond: F(p.challengeBond) };
  const supply0 = await token.totalSupply();

  // 1. Faucet (challenger)
  const ch = W.challenger, pv = W.provider;
  const next = await faucet.nextDripAt(ch.address);
  if (BigInt(next) <= BigInt((await ethers.provider.getBlock("latest")).timestamp)) await send("faucet_drip_challenger", faucet, ch, "drip");
  else out.notes.push("challenger déjà servi par le faucet (cooldown)");
  await expectRevert("faucet_drip_again", faucet, ch, "drip", [], "CooldownActive");

  // 2. Stake + délégation (challenger)
  const amtStake = ethers.parseEther("50");
  if ((await token.allowance(ch.address, A.staking)) < amtStake) await send("approve_staking_challenger", token, ch, "approve", [A.staking, amtStake]);
  await send("stake_50_challenger", staking, ch, "stake", [amtStake]);
  await send("delegate_self_challenger", staking, ch, "delegate", [ch.address]);

  // 3. Vérificateur 1 : sortie (caution 900 libérée) puis réinscription (1000) -> 3 vérificateurs
  const v1 = W.verifier1;
  const info1 = await market.verifiers(v1.address);
  if (Number(info1.indexPlus1) === 0) {
    if (info1.bond > 0n) await send("verifier1_exitVerifier", market, v1, "exitVerifier");
    await send("verifier1_registerVerifier", market, v1, "registerVerifier");
  }
  out.checks.verifierCount = (await market.verifierCount()).toString();

  // 4. Job UI (créé par l'app) : le prestataire s'assigne et livre
  const uiJob = process.env.UI_JOB ? BigInt(process.env.UI_JOB) : 0n;
  if (uiJob) {
    await send(`uiJob${uiJob}_assignJob_provider`, market, pv, "assignJob", [uiJob]);
    await send(`uiJob${uiJob}_submitResult_provider`, market, pv, "submitResult", [uiJob, "keccak256:" + ethers.id("resultat job UI " + uiJob)]);
  }

  // 5. Job optimiste (client = challenger)
  const budget1 = ethers.parseEther("10");
  await send("approve_market_challenger", token, ch, "approve", [A.market, budget1 + p.challengeBond]);
  const id1 = await market.nextJobId();
  await send(`job${id1}_createJob_challenger`, market, ch, "createJob", [budget1, 3600, "ipfs://superion-e2e-optimiste-" + Date.now()]);
  await send(`job${id1}_assignJob_provider`, market, pv, "assignJob", [id1]);
  await send(`job${id1}_submitResult_provider`, market, pv, "submitResult", [id1, "keccak256:" + ethers.id("resultat optimiste " + id1)]);

  // 6. Job contesté (client = admin, contestataire = challenger)
  const budget2 = ethers.parseEther("20");
  await send("approve_market_admin", token, admin, "approve", [A.market, budget2]);
  const id2 = await market.nextJobId();
  await send(`job${id2}_createJob_admin`, market, admin, "createJob", [budget2, 3600, "ipfs://superion-e2e-litige-" + Date.now()]);
  await send(`job${id2}_assignJob_provider`, market, pv, "assignJob", [id2]);
  await send(`job${id2}_submitResult_provider`, market, pv, "submitResult", [id2, "keccak256:" + ethers.id("resultat litige " + id2)]);
  const seed = ethers.hexlify(ethers.randomBytes(32));
  const seedCommit = ethers.keccak256(coder.encode(["bytes32"], [seed]));
  await send(`job${id2}_challengeJob_challenger`, market, ch, "challengeJob", [id2, seedCommit]);
  const d0 = await market.disputes(id2);
  await waitUntil(Number(d0.seedRevealEarliest) - 1, "seedRevealDelay");
  await send(`job${id2}_revealCommittee_challenger`, market, ch, "revealCommittee", [id2, seed]);
  // Le RPC public peut être en retard d'un bloc : relire jusqu'à voir le comité.
  const committee = await withRetry(async () => { const c = await market.committeeOf(id2); if (!c.length && (await market.verifierCount()) > 0n) throw new Error("execution reverted (lecture en retard)"); return c; }, 6);
  out.checks[`job${id2}_committee`] = committee.join(", ");
  const byAddr = Object.fromEntries(Object.values(W).map((w) => [w.address.toLowerCase(), w]));
  const salts = {};
  for (const m of committee) {
    const w = byAddr[m.toLowerCase()];
    salts[m] = ethers.hexlify(ethers.randomBytes(32));
    const h = ethers.keccak256(coder.encode(["bool", "bytes32", "address", "uint256"], [true, salts[m], m, id2]));
    await send(`job${id2}_commitVote_${m.slice(0, 8)}`, market, w, "commitVote", [id2, h]);
  }
  const d1 = await market.disputes(id2);
  await waitUntil(Number(d1.voteCommitDeadline), "voteCommitWindow");
  for (const m of committee) await send(`job${id2}_revealVote_${m.slice(0, 8)}`, market, byAddr[m.toLowerCase()], "revealVote", [id2, true, salts[m]]);
  await send(`job${id2}_resolveDispute`, market, ch, "resolveDispute", [id2]);
  out.checks[`job${id2}_status`] = (await market.jobs(id2)).status.toString();

  // 7. Finalisation après la fenêtre de contestation (ouvert à tous)
  const j1 = await market.jobs(id1);
  await waitUntil(Number(j1.challengeDeadline), "challengePeriod job optimiste");
  await send(`job${id1}_finalizeJob`, market, ch, "finalizeJob", [id1]);
  out.checks[`job${id1}_status`] = (await market.jobs(id1)).status.toString();

  // 8. Récompenses (prestataire, staker de longue date)
  const earned = await staking.earned(pv.address);
  out.checks.provider_earned_before_claim = F(earned);
  await send("claimRewards_provider", staking, pv, "claimRewards");

  // 9. Sortie de stake : demande (7 jours ensuite)
  await send("requestUnstake_1_challenger", staking, ch, "requestUnstake", [ethers.parseEther("1")]);
  await expectRevert("completeUnstake_before_7d", staking, ch, "completeUnstake", [], "UnbondingNotFinished");

  out.checks.burned_during_run = F(supply0 - (await token.totalSupply()));
  out.checks.faucet_balance = F(await token.balanceOf(A.faucet));
  out.uiJob = uiJob.toString(); out.optimisticJob = id1.toString(); out.disputedJob = id2.toString();
  out.finishedAt = new Date().toISOString(); save();
  log("FIN OK");
})().catch((e) => { console.error("ECHEC", e.shortMessage || e.message); out.error = String(e.shortMessage || e.message); save(); process.exit(1); });
