// VRF-01 — Litige de bout en bout sur Base Sepolia avec Chainlink VRF v2.5 (réel) :
//   contestation -> requête VRF -> comité tiré dans le callback -> 1 vérificateur ne révèle pas
//   -> rerollNonRevealers (caution ENTIÈRE saisie) -> 2e requête VRF -> nouveau membre vote -> résolution.
// Portefeuilles éphémères dans .vrf-e2e-wallets.json (mode 600, gitignoré, jamais affichés).
// Reprenable : état dans deployments/vrf.baseSepolia.json (clé e2e).
const fs = require("fs");
const path = require("path");
const { ethers } = require("hardhat");
const { waitTx, withRetry, sleep } = require("./lib.cjs");

const OUT = path.join(__dirname, "..", "..", "deployments", "vrf.baseSepolia.json");
const WFILE = path.join(__dirname, "..", "..", ".vrf-e2e-wallets.json");
const ROLES = ["provider", "challenger", "v1", "v2", "v3", "v4", "v5"];
const S = (n) => ethers.parseUnits(String(n), 18);
const enc = ethers.AbiCoder.defaultAbiCoder();
const voteCommit = (v, salt, voter, id) => ethers.keccak256(enc.encode(["bool", "bytes32", "address", "uint256"], [v, salt, voter, id]));

async function main() {
  const { chainId } = await ethers.provider.getNetwork();
  if (chainId !== 84532n) throw new Error("Base Sepolia uniquement");
  const st = JSON.parse(fs.readFileSync(OUT, "utf8"));
  st.e2e = st.e2e || { txs: {} };
  const E = st.e2e, T = E.txs;
  const save = () => fs.writeFileSync(OUT, JSON.stringify(st, null, 2) + "\n");
  const log = (m) => console.log(new Date().toISOString(), m);
  const [deployer] = await ethers.getSigners();
  let wk;
  if (fs.existsSync(WFILE)) wk = JSON.parse(fs.readFileSync(WFILE, "utf8"));
  else { wk = {}; for (const r of ROLES) wk[r] = ethers.Wallet.createRandom().privateKey; fs.writeFileSync(WFILE, JSON.stringify(wk), { mode: 0o600 }); }
  const W = {}; for (const r of ROLES) W[r] = new ethers.Wallet(wk[r], ethers.provider);
  const byAddr = Object.fromEntries(ROLES.map((r) => [W[r].address.toLowerCase(), W[r]]));
  E.wallets = Object.fromEntries(ROLES.map((r) => [r, W[r].address]));

  const token = await ethers.getContractAt("SuperionToken", st.superToken, deployer);
  const market = await ethers.getContractAt("SuperionJobMarketplaceV2", st.contracts.marketplaceV2, deployer);
  const staking = await ethers.getContractAt("SuperionStakingV2", st.contracts.stakingV2, deployer);
  const M = st.contracts.marketplaceV2, ST = st.contracts.stakingV2;
  const step = async (key, fn) => { if (T[key]) return; T[key] = (await waitTx(fn, log, key)).hash; save(); };

  // 1. financement + inscription des vérificateurs
  for (const r of ROLES) {
    await step(`fund_eth_${r}`, () => deployer.sendTransaction({ to: W[r].address, value: ethers.parseEther("0.0006") }));
    const amt = r.startsWith("v") ? S(1000) : r === "provider" ? S(100) : S(50);
    await step(`fund_super_${r}`, () => token.transfer(W[r].address, amt));
  }
  for (const r of ["v1", "v2", "v3", "v4", "v5", "provider"]) {
    const amt = r === "provider" ? S(100) : S(1000);
    await step(`approve_st_${r}`, () => token.connect(W[r]).approve(ST, ethers.MaxUint256));
    await step(`stake_${r}`, () => staking.connect(W[r]).stake(amt));
    if (r !== "provider") await step(`register_${r}`, () => market.connect(W[r]).registerVerifier());
  }
  await step("approve_mk_challenger", () => token.connect(W.challenger).approve(M, ethers.MaxUint256));
  await step("approve_mk_creator", () => token.approve(M, ethers.MaxUint256));

  // 2. job -> résultat -> contestation (requête VRF)
  if (!E.jobId) {
    E.jobId = (await market.nextJobId()).toString();
    await step("createJob", () => market.createJob(S(50), 3600, "ipfs://superion-vrf-e2e"));
    save();
  }
  const id = BigInt(E.jobId);
  await step("assignJob", () => market.connect(W.provider).assignJob(id));
  await step("submitResult", () => market.connect(W.provider).submitResult(id, "ipfs://superion-vrf-e2e-result"));
  await step("challengeJob", () => market.connect(W.challenger).challengeJob(id));

  const waitDraw = async (label) => {
    const req = (await market.pendingDraw(id)).requestId;
    if (req !== 0n) { E[`${label}_requestId`] = req.toString(); save(); }
    log(`${label} : attente du callback VRF (requestId ${E[`${label}_requestId`]})…`);
    const t0 = Date.now();
    while (!(await withRetry(() => market.disputes(id))).committeeSelected) {
      if (Date.now() - t0 > Number(process.env.VRF_WAIT_MIN || 20) * 60 * 1000) throw new Error("VRF non servi dans le délai — vérifier le solde de l'abonnement");
      await sleep(10000);
    }
    // RPC public : eth_getLogs limité à 200 blocs -> balayage par tranches
    let evs = []; const head = await ethers.provider.getBlockNumber();
    for (let to = head; to > head - 4000 && !evs.length; to -= 200) {
      evs = await withRetry(() => market.queryFilter(market.filters.DrawFulfilled(id, BigInt(E[`${label}_requestId`])), to - 199, to));
    }
    if (evs.length) { E[`${label}_fulfillTx`] = evs[0].transactionHash; E[`${label}_randomWord`] = evs[0].args.randomWord.toString(); }
    E[`${label}_fulfillDelaySec`] = E[`${label}_fulfillDelaySec`] || Math.round((Date.now() - t0) / 1000);
    E[`${label}_committee`] = [...(await market.committeeOf(id))]; save();
    log(`${label} : comité ${E[`${label}_committee`].join(", ")} (tx ${E[`${label}_fulfillTx`]})`);
  };
  if (!E.draw1_committee) await waitDraw("draw1");
  const c = E.draw1_committee;
  const waitUntil = async (ts) => { for (;;) { const b = await ethers.provider.getBlock("latest"); if (b.timestamp > Number(ts)) return; log(`attente ${Number(ts) - b.timestamp + 1} s`); await sleep(Math.min(60, Number(ts) - b.timestamp + 3) * 1000); } };

  // 3. votes : c0 valide, c1 invalide, c2 commit puis NE RÉVÈLE PAS
  const salts = c.map((a) => ethers.id("vrf-e2e-" + a + E.jobId));
  const plan = [true, false, true];
  for (let i = 0; i < 3; i++) await step(`commit_${i}`, () => market.connect(byAddr[c[i].toLowerCase()]).commitVote(id, voteCommit(plan[i], salts[i], c[i], id)));
  await waitUntil((await market.disputes(id)).voteCommitDeadline);
  for (let i = 0; i < 2; i++) await step(`reveal_${i}`, () => market.connect(byAddr[c[i].toLowerCase()]).revealVote(id, plan[i], salts[i]));
  if (!T.rerollNonRevealers) {
    await waitUntil((await market.jobs(id)).disputeDeadline);
    E.nonRevealer = c[2];
    E.nonRevealerBondBefore = (await market.verifiers(c[2])).bond.toString();
    await step("rerollNonRevealers", () => market.rerollNonRevealers(id));
    E.nonRevealerBondAfter = (await withRetry(() => market.verifiers(c[2]))).bond.toString(); save();
  }
  if (!E.draw2_committee) await waitDraw("draw2");
  const newcomer = E.draw2_committee.find((a) => !c.includes(a));
  E.newcomer = newcomer; save();
  const ns = ethers.id("vrf-e2e-new-" + newcomer + E.jobId);
  await step("commit_newcomer", () => market.connect(byAddr[newcomer.toLowerCase()]).commitVote(id, voteCommit(true, ns, newcomer, id)));
  await waitUntil((await market.disputes(id)).voteCommitDeadline);
  await step("reveal_newcomer", () => market.connect(byAddr[newcomer.toLowerCase()]).revealVote(id, true, ns));

  // 4. résolution après la fenêtre d'appel (appealWindow)
  const aw = (await market.securityParams()).appealWindow;
  await waitUntil((await market.jobs(id)).disputeDeadline + aw);
  await step("resolveDispute", () => market.resolveDispute(id));
  E.finalStatus = Number((await withRetry(() => market.jobs(id))).status); // 5 = Finalized
  E.completedAt = new Date().toISOString(); save();
  log(`FIN : statut ${E.finalStatus}`);
}
main().catch((e) => { console.error(e); process.exit(1); });
