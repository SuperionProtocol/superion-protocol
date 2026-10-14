// Light e2e : createProposal (template setFees) sur Base Sepolia V2.1.
// Usage : npx hardhat run scripts/v2/e2e-create-proposal.cjs --network baseSepolia
const fs = require("fs");
const path = require("path");
const { ethers } = require("hardhat");

const A = {
  market: "0xe7e59308bC3f44E00f4B0546AF146ad8d662BE51",
  governor: "0x4032A0695F037b1E92CFA3120386010C31B6fe6E",
  staking: "0xA4924DF82bb5bE5C1357A3DA3b0657A3d5dC4630",
  timelock: "0x50072Fdc8b05972Bfa5BB73472208172470e84a0",
};
const OUT = path.join(__dirname, "..", "..", "deployments", "app-v21.propose.e2e.json");

(async () => {
  if ((await ethers.provider.getNetwork()).chainId !== 84532n) throw new Error("Base Sepolia uniquement");
  const [admin] = await ethers.getSigners();
  const gov = await ethers.getContractAt("SuperionGovernor", A.governor);
  const market = await ethers.getContractAt("SuperionJobMarketplaceV2", A.market);
  const staking = await ethers.getContractAt("SuperionStakingV2", A.staking);

  const thr = await gov.proposalThreshold();
  const votes = await staking.getVotes(admin.address);
  const clock = await gov.clock();
  const quorum = await gov.quorum(clock - 1n);
  const p = await market.params();
  const out = {
    startedAt: new Date().toISOString(),
    proposer: admin.address,
    threshold: ethers.formatEther(thr),
    proposerVotes: ethers.formatEther(votes),
    quorum: ethers.formatEther(quorum),
    feeBpsOnChain: Number(p.feeBps),
    burnShareBpsOnChain: Number(p.burnShareBps),
    notes: [],
    txs: {},
    checks: {},
  };

  if (votes < thr) {
    out.checks.createProposal = "BLOQUÉ : votes < proposalThreshold";
    out.notes.push(`Seuil ${out.threshold} stSUPER, proposant ${out.proposerVotes}. Impossible de createProposal sans plus de stake délégué.`);
    fs.writeFileSync(OUT, JSON.stringify(out, null, 2));
    console.log(JSON.stringify(out, null, 2));
    return;
  }

  // Encode setFees comme l'UI (même valeurs actuelles = no-op économique si exécuté).
  const feeBps = Number(p.feeBps);
  const burnShareBps = Number(p.burnShareBps);
  const calldata = market.interface.encodeFunctionData("setFees", [feeBps, burnShareBps]);
  const desc =
    `setFees(${feeBps}, ${burnShareBps})\n` +
    `e2e-create-proposal ${out.startedAt} — template UI Phase 2 (no-op si exécuté).`;

  // Vérifier l'encodage setParams aussi (static, sans envoyer)
  const tuple = [
    p.feeBps, p.burnShareBps, p.challengePeriod, p.seedRevealDelay, p.seedRevealWindow,
    p.voteCommitWindow, p.voteRevealWindow, p.arbitrationWindow, p.committeeSize,
    p.providerStakeBps, p.slashVerifierBps, p.slashChallengerBps,
    p.minVerifierStake, p.verifierPenalty, p.challengeBond,
  ];
  const cdParams = market.interface.encodeFunctionData("setParams", [tuple]);
  out.checks.encode_setFees = calldata.slice(0, 10);
  out.checks.encode_setParams = cdParams.slice(0, 10);
  out.checks.encode_arbitrate = market.interface.encodeFunctionData("arbitrate", [1n, true]).slice(0, 10);

  const role = await market.ARBITER_ROLE();
  out.checks.timelockIsArbiter = await market.hasRole(role, A.timelock);

  try {
    const gas = await gov.propose.estimateGas([A.market], [0], [calldata], desc);
    const tx = await gov.propose([A.market], [0], [calldata], desc, {
      gasLimit: (gas * 13n) / 10n + 50000n,
    });
    const rc = await tx.wait();
    out.txs.createProposal_setFees = tx.hash;
    const ev = rc.logs.map((l) => { try { return gov.interface.parseLog(l); } catch { return null; } }).find((e) => e && e.name === "ProposalCreated");
    out.proposalId = ev ? ev.args[0].toString() : null;
    out.checks.createProposal = "OK";
    out.notes.push(
      "Proposition créée. Quorum actuel ≈ " + out.quorum +
      " stSUPER pour l’adoption (le create ne dépend que du seuil). Vote/queue/execute hors de ce script light."
    );
  } catch (e) {
    let name = e.revert && e.revert.name;
    if (!name && e.data) { try { name = gov.interface.parseError(e.data).name; } catch {} }
    out.checks.createProposal = "REVERT " + (name || e.shortMessage || e.message);
    out.notes.push(String(e.shortMessage || e.message));
  }

  fs.writeFileSync(OUT, JSON.stringify(out, null, 2));
  console.log(JSON.stringify(out, null, 2));
})();
