const fs = require("fs"); const path = require("path");
const { ethers } = require("hardhat");
const { loadOrCreate } = require("./wallets.cjs");
const { sleep, withRetry } = require("./lib.cjs");
const OUT = path.join(__dirname, "..", "..", "deployments", "app-v21.e2e.json");
const out = JSON.parse(fs.readFileSync(OUT, "utf8")); const save = () => fs.writeFileSync(OUT, JSON.stringify(out, null, 2));
const F = (v) => ethers.formatEther(v);
async function send(label, c, w, m, args = []) {
  const h = await withRetry(async () => { const k = c.connect(w); const g = await k[m].estimateGas(...args); const tx = await k[m](...args, { gasLimit: g * 13n / 10n + 15000n }); const rc = await tx.wait(); if (rc.status !== 1) throw new Error("revert"); return tx.hash; }, 4);
  out.txs[label] = h; save(); console.log(label, h); return h;
}
async function expectRevert(label, c, w, m, args, name) {
  try { await c.connect(w)[m].staticCall(...args); out.checks[label] = "PAS DE REVERT"; }
  catch (e) { let n = e.revert && e.revert.name; if (!n && e.data) { try { n = c.interface.parseError(e.data).name; } catch {} } out.checks[label] = (n === name ? "revert " + n + " (attendu)" : "revert " + (n || e.shortMessage) + " (attendu : " + name + ")"); }
  console.log(label, out.checks[label]); save();
}
async function waitUntil(ts, why) { for (;;) { const b = await ethers.provider.getBlock("latest"); if (b.timestamp > Number(ts)) return; const d = Number(ts) - b.timestamp + 3; console.log("attente", d, why); await sleep(Math.min(d, 20) * 1000); } }
(async () => {
  const W = loadOrCreate(ethers);
  const [admin] = await ethers.getSigners();
  const mk = await ethers.getContractAt("SuperionJobMarketplaceV2", "0xe7e59308bC3f44E00f4B0546AF146ad8d662BE51");
  const stk = await ethers.getContractAt("SuperionStakingV2", "0xA4924DF82bb5bE5C1357A3DA3b0657A3d5dC4630");
  const tok = await ethers.getContractAt("SuperionToken", "0xf5a6F83CE27692A247C3B2d1b7e0a3C3234300b4");
  const fct = await ethers.getContractAt("SuperFaucet", JSON.parse(fs.readFileSync("deployments/faucet.baseSepolia.json")).faucet);
  const salts = JSON.parse(fs.readFileSync("/tmp/salts6.json"));
  const byAddr = Object.fromEntries(Object.values(W).map((w) => [w.address.toLowerCase(), w]));
  const id = 6n; const d = await mk.disputes(id);
  out.checks.job6_committee = Object.keys(salts).join(", ");
  await waitUntil(d.voteCommitDeadline, "voteCommitWindow");
  await Promise.all(Object.entries(salts).map(([m, s]) => send(`job6_revealVote_${m.slice(0, 8)}`, mk, byAddr[m.toLowerCase()], "revealVote", [id, true, s])));
  await sleep(3000);
  await send("job6_resolveDispute", mk, W.challenger, "resolveDispute", [id]);
  out.checks.job6_status = (await withRetry(async () => { const s = (await mk.jobs(id)).status; if (s === 4n) throw new Error("execution reverted lag"); return s; })).toString();
  const j5 = await mk.jobs(5n);
  await waitUntil(j5.challengeDeadline, "challengePeriod job 5");
  await send("job5_finalizeJob", mk, W.challenger, "finalizeJob", [5n]);
  out.checks.job5_status = (await mk.jobs(5n)).status.toString();
  out.checks.provider_earned_before_claim = F(await stk.earned(W.provider.address));
  await send("claimRewards_provider", stk, W.provider, "claimRewards");
  await send("requestUnstake_1_challenger", stk, W.challenger, "requestUnstake", [ethers.parseEther("1")]);
  await expectRevert("completeUnstake_before_7d", stk, W.challenger, "completeUnstake", [], "UnbondingNotFinished");
  await expectRevert("faucet_drip_again", fct, W.challenger, "drip", [], "CooldownActive");
  out.checks.faucet_balance = F(await tok.balanceOf(fct.target));
  out.uiJob = "4"; out.optimisticJob = "5"; out.disputedJob = "6";
  out.notes.push("Le script principal a lu un comité vide (RPC public en retard) juste après revealCommittee ; reprise manuelle (commit/reveal/resolve) avec les mêmes appels. Correctif : relecture avec réessai.");
  delete out.error; out.finishedAt = new Date().toISOString(); save(); console.log("FIN OK");
})().catch((e) => { console.error("ECHEC", e.shortMessage || e.message); process.exit(1); });
