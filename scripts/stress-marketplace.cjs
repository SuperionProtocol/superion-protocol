const hre = require("hardhat");

const JOBS_ADDR = "0x079a7B21C71C448A96E425e598e1C3fEb824d49d";
const STAKING_ADDR = "0xD10E6f73a676a1562d18ef93D86bd3D85786Fe50";
const TOKEN_ADDR = "0xf5a6F83CE27692A247C3B2d1b7e0a3C3234300b4";
const EXPECTED_ADMIN = "0xE60322A5543C2bAD26115053B586d9679F4A939f";

// Distinct small budgets. Sum = 19 SUPER. Assign all before any slash.
const NEW_BUDGETS = [8, 5, 3, 2, 1];
// Slash the three larger ones; pay the two smaller ones (plus any pre-existing job as a win unless we still need slash samples).
const SLASH_BUDGETS = new Set(["8", "5", "3"]);
const DURATION = 24 * 60 * 60;
const STATUS = ["Open", "Assigned", "Completed", "Challenged", "Finalized", "Cancelled"];

const jobsAbi = [
  "function nextJobId() view returns (uint256)",
  "function jobs(uint256) view returns (address creator, address provider, uint256 budget, uint256 createdAt, uint256 deadline, uint8 status, string jobURI, string resultURI, uint256 challengeDeadline)",
  "function createJob(uint256 budget, uint256 duration, string jobURI) returns (uint256)",
  "function assignJob(uint256 jobId)",
  "function submitResult(uint256 jobId, string resultURI)",
  "function finalizeJob(uint256 jobId, bool providerWins)",
  "function VERIFIER_ROLE() view returns (bytes32)",
  "function hasRole(bytes32 role, address account) view returns (bool)",
  "event JobCreated(uint256 indexed jobId, address indexed creator, uint256 budget, string jobURI)",
  "event JobAssigned(uint256 indexed jobId, address indexed provider)",
  "event JobCompleted(uint256 indexed jobId, string resultURI)",
  "event JobFinalized(uint256 indexed jobId, address indexed winner, uint256 amount)",
  "event ProviderSlashed(uint256 indexed jobId, address indexed provider, uint256 amount)",
];

const tokenAbi = [
  "function balanceOf(address) view returns (uint256)",
  "function allowance(address,address) view returns (uint256)",
  "function decimals() view returns (uint8)",
  "function approve(address,uint256) returns (bool)",
];

const stakingAbi = ["function getStake(address) view returns (uint256)"];

function fmt(amount, decimals) {
  return hre.ethers.formatUnits(amount, decimals);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function send(label, txPromise) {
  const tx = await txPromise;
  const receipt = await tx.wait();
  if (!receipt || receipt.status !== 1) {
    throw new Error(`${label} reverted or missing receipt (tx ${tx ? tx.hash : "?"})`);
  }
  console.log(`${label} tx: ${receipt.hash} block=${receipt.blockNumber} gas=${receipt.gasUsed.toString()}`);
  // Public Base Sepolia RPC can serve eth_call behind the receipt node. Wait until
  // the reported head is at least this block, twice in a row.
  for (let i = 0; i < 40; i++) {
    const head = await hre.ethers.provider.getBlockNumber();
    if (head >= receipt.blockNumber) {
      const head2 = await hre.ethers.provider.getBlockNumber();
      if (head2 >= receipt.blockNumber) break;
    }
    await sleep(500);
    if (i === 39) console.log("WARN head still behind receipt", label, receipt.hash);
  }
  return receipt;
}

function findEvent(receipt, iface, name) {
  for (const log of receipt.logs) {
    try {
      const parsed = iface.parseLog(log);
      if (parsed && parsed.name === name) return parsed;
    } catch (_) {
      /* not this contract/event */
    }
  }
  return null;
}

async function main() {
  const net = await hre.ethers.provider.getNetwork();
  if (Number(net.chainId) !== 84532) {
    throw new Error(`Wrong chain ${net.chainId}, expected 84532`);
  }

  const [me] = await hre.ethers.getSigners();
  if (me.address.toLowerCase() !== EXPECTED_ADMIN.toLowerCase()) {
    throw new Error(`Signer ${me.address} is not expected admin ${EXPECTED_ADMIN}`);
  }

  const jobs = await hre.ethers.getContractAt(jobsAbi, JOBS_ADDR, me);
  const token = await hre.ethers.getContractAt(tokenAbi, TOKEN_ADDR, me);
  const staking = await hre.ethers.getContractAt(stakingAbi, STAKING_ADDR, me);
  const iface = jobs.interface;

  const decimals = Number(await token.decimals());
  const unit = (n) => hre.ethers.parseUnits(String(n), decimals);

  const role = await jobs.VERIFIER_ROLE();
  const isVerifier = await jobs.hasRole(role, me.address);
  console.log("signer", me.address);
  console.log("chainId", net.chainId.toString());
  console.log("decimals", decimals);
  console.log("verifier", isVerifier);
  if (!isVerifier) throw new Error("Signer lacks VERIFIER_ROLE; cannot finalize");

  async function snapshot(tag) {
    const [stake, bal, mkt, nextId, eth] = await Promise.all([
      staking.getStake(me.address),
      token.balanceOf(me.address),
      token.balanceOf(JOBS_ADDR),
      jobs.nextJobId(),
      hre.ethers.provider.getBalance(me.address),
    ]);
    const row = {
      tag,
      stake: fmt(stake, decimals),
      superBalance: fmt(bal, decimals),
      marketplaceSuper: fmt(mkt, decimals),
      nextJobId: nextId.toString(),
      eth: hre.ethers.formatEther(eth),
    };
    console.log("SNAPSHOT", JSON.stringify(row));
    return { stake, bal, mkt, nextId, row };
  }

  const before = await snapshot("before");

  async function loadJob(id) {
    const j = await jobs.jobs(id);
    return {
      id,
      creator: j.creator,
      provider: j.provider,
      budget: j.budget,
      status: Number(j.status),
      statusName: STATUS[Number(j.status)] || String(j.status),
      jobURI: j.jobURI,
      deadline: j.deadline,
    };
  }

  async function listJobs() {
    const nextId = await jobs.nextJobId();
    const out = [];
    for (let id = 1n; id < nextId; id++) {
      out.push(await loadJob(id));
    }
    return out;
  }

  let existing = await listJobs();
  console.log(
    "EXISTING",
    JSON.stringify(
      existing.map((j) => ({
        id: j.id.toString(),
        status: j.statusName,
        budget: fmt(j.budget, decimals),
        creator: j.creator,
        provider: j.provider,
        jobURI: j.jobURI,
      }))
    )
  );

  // Create missing stress jobs. URI encodes the budget so a rerun does not double-spend.
  const activeStress = (jobsNow, budgetWhole) =>
    jobsNow.filter(
      (j) =>
        j.jobURI === `ipfs://superion-stress/b${budgetWhole}` &&
        j.status !== 4 &&
        j.status !== 5 &&
        j.creator.toLowerCase() === me.address.toLowerCase()
    );

  const toCreate = [];
  for (const b of NEW_BUDGETS) {
    if (activeStress(existing, b).length === 0) {
      // Also skip if a finalized stress job with this URI already exists (rerun).
      const any = existing.filter((j) => j.jobURI === `ipfs://superion-stress/b${b}`);
      if (any.length === 0) toCreate.push(b);
      else console.log(`skip create budget ${b}: stress job already exists id=${any.map((j) => j.id).join(",")}`);
    } else {
      console.log(`skip create budget ${b}: active stress job id=${activeStress(existing, b).map((j) => j.id.toString()).join(",")}`);
    }
  }

  const createSum = toCreate.reduce((a, b) => a + unit(b), 0n);
  console.log("toCreate", toCreate.join(","), "sum", fmt(createSum, decimals));

  if (createSum > before.bal) {
    throw new Error(
      `Liquid SUPER ${fmt(before.bal, decimals)} < needed ${fmt(createSum, decimals)}. Not staking extra.`
    );
  }

  const txs = { approve: null, create: [], assign: [], submit: [], finalize: [] };

  if (createSum > 0n) {
    const allowance = await token.allowance(me.address, JOBS_ADDR);
    if (allowance < createSum) {
      const receipt = await send("approve", token.approve(JOBS_ADDR, createSum));
      txs.approve = receipt.hash;
    } else {
      console.log("approve skipped, allowance", fmt(allowance, decimals));
    }

    for (const b of toCreate) {
      const uri = `ipfs://superion-stress/b${b}`;
      const receipt = await send(
        `createJob budget=${b}`,
        jobs.createJob(unit(b), DURATION, uri)
      );
      const ev = findEvent(receipt, iface, "JobCreated");
      const jobId = ev ? ev.args.jobId.toString() : "MISSING_EVENT";
      txs.create.push({ budget: b, hash: receipt.hash, jobId, event: Boolean(ev) });
      console.log(`created jobId=${jobId} budget=${b}`);
    }
  }

  const terminal = new Set([4, 5]);
  const stakeNow = await staking.getStake(me.address);
  console.log("stake before assigns", fmt(stakeNow, decimals));

  for (let pass = 0; pass < 6; pass++) {
    existing = await listJobs();
    const opens = existing
      .filter((j) => j.status === 0)
      .sort((a, b) => (a.budget > b.budget ? -1 : a.budget < b.budget ? 1 : Number(a.id - b.id)));
    if (opens.length === 0) break;
    console.log("open jobs pass", pass, opens.map((j) => j.id.toString()).join(","));
    for (const j of opens) {
      if (j.creator.toLowerCase() !== me.address.toLowerCase()) {
        console.log(`skip open job ${j.id} not ours`);
        continue;
      }
      const freshStake = await staking.getStake(me.address);
      const fresh = await loadJob(j.id);
      if (fresh.status !== 0) {
        console.log(`job ${j.id} no longer Open (${fresh.statusName})`);
        continue;
      }
      if (freshStake < fresh.budget) {
        console.log(
          `STOP assign job ${j.id}: stake ${fmt(freshStake, decimals)} < budget ${fmt(fresh.budget, decimals)}`
        );
        throw new Error(`Stake too low to assign job ${j.id}`);
      }
      const now = BigInt((await hre.ethers.provider.getBlock("latest")).timestamp);
      if (now >= fresh.deadline) {
        throw new Error(`Job ${j.id} deadline passed; cannot assign`);
      }
      const receipt = await send(`assignJob ${j.id}`, jobs.assignJob(j.id));
      const ev = findEvent(receipt, iface, "JobAssigned");
      txs.assign.push({
        jobId: j.id.toString(),
        budget: fmt(fresh.budget, decimals),
        hash: receipt.hash,
        event: Boolean(ev),
      });
      let confirmed = await loadJob(j.id);
      for (let i = 0; i < 20 && confirmed.status !== 1; i++) {
        await sleep(500);
        confirmed = await loadJob(j.id);
      }
      if (confirmed.status !== 1) {
        throw new Error(`assign job ${j.id} receipt mined but status still ${confirmed.statusName}`);
      }
    }
  }

  for (let pass = 0; pass < 6; pass++) {
    existing = await listJobs();
    const assigned = existing.filter((j) => j.status === 1);
    if (assigned.length === 0) break;
    console.log("assigned jobs pass", pass, assigned.map((j) => j.id.toString()).join(","));
    for (const j of assigned) {
      const fresh = await loadJob(j.id);
      if (fresh.status !== 1) continue;
      if (fresh.provider.toLowerCase() !== me.address.toLowerCase()) {
        console.log(`skip submit job ${j.id}: provider is ${fresh.provider}`);
        continue;
      }
      const resultURI = `ipfs://superion-stress/result/${j.id}`;
      const receipt = await send(`submitResult ${j.id}`, jobs.submitResult(j.id, resultURI));
      const ev = findEvent(receipt, iface, "JobCompleted");
      txs.submit.push({ jobId: j.id.toString(), hash: receipt.hash, event: Boolean(ev) });
      let confirmed = await loadJob(j.id);
      for (let i = 0; i < 20 && confirmed.status !== 2; i++) {
        await sleep(500);
        confirmed = await loadJob(j.id);
      }
      if (confirmed.status !== 2) {
        throw new Error(`submit job ${j.id} receipt mined but status still ${confirmed.statusName}`);
      }
    }
  }

    existing = await listJobs();
  const ready = existing.filter((j) => j.status === 2 || j.status === 3);

  // Decide providerWins: slash budgets 8/5/3 when those stress jobs are in the set.
  // Any other job (including pre-existing job 1) is a non-slash win, unless we have fewer than 2 slash candidates.
  function budgetWhole(j) {
    const human = fmt(j.budget, decimals);
    // budget may already be... no, still set until finalize.
    return human.split(".")[0];
  }

  const plan = ready.map((j) => {
    const whole = budgetWhole(j);
    const stress = j.jobURI.startsWith("ipfs://superion-stress/");
    const providerWins = !(stress && SLASH_BUDGETS.has(whole));
    return { job: j, providerWins, whole };
  });

  const slashCount = plan.filter((p) => !p.providerWins).length;
  const winCount = plan.filter((p) => p.providerWins).length;
  console.log(`finalize plan slash=${slashCount} win=${winCount}`);
  if (slashCount < 2 || winCount < 2) {
    console.log("WARNING: mix below 2/2 with current jobs; proceeding with available set");
  }

  // Finalize slash jobs one-by-one (largest first) so stake deltas are observable, then wins.
  plan.sort((a, b) => {
    if (a.providerWins !== b.providerWins) return a.providerWins ? 1 : -1;
    if (a.job.budget === b.job.budget) return Number(a.job.id - b.job.id);
    return a.job.budget > b.job.budget ? -1 : 1;
  });

  const finalizeReport = [];
  for (const p of plan) {
    const stakeBefore = await staking.getStake(me.address);
    const fresh = await loadJob(p.job.id);
    if (fresh.status !== 2 && fresh.status !== 3) {
      console.log(`skip finalize ${p.job.id}: status ${fresh.statusName}`);
      continue;
    }
    const label = `finalizeJob ${p.job.id} providerWins=${p.providerWins}`;
    const receipt = await send(label, jobs.finalizeJob(p.job.id, p.providerWins));
    const fin = findEvent(receipt, iface, "JobFinalized");
    const slash = findEvent(receipt, iface, "ProviderSlashed");
    let stakeAfter = await staking.getStake(me.address);
    // Slash accounting on the staking contract can lag one read on this RPC.
    if (!p.providerWins) {
      for (let i = 0; i < 20 && stakeAfter === stakeBefore; i++) {
        await sleep(500);
        stakeAfter = await staking.getStake(me.address);
      }
    }
    const delta = stakeBefore - stakeAfter;
    const row = {
      jobId: p.job.id.toString(),
      budget: fmt(fresh.budget, decimals),
      providerWins: p.providerWins,
      winner: fin ? fin.args.winner : null,
      finalizedAmount: fin ? fmt(fin.args.amount, decimals) : null,
      slashFired: Boolean(slash),
      slashAmount: slash ? fmt(slash.args.amount, decimals) : "0",
      slashProvider: slash ? slash.args.provider : null,
      stakeBefore: fmt(stakeBefore, decimals),
      stakeAfter: fmt(stakeAfter, decimals),
      stakeDelta: fmt(delta, decimals),
      hash: receipt.hash,
      jobFinalizedEvent: Boolean(fin),
      expectedWinner: p.providerWins ? fresh.provider : fresh.creator,
    };
    if (p.providerWins && slash) {
      row.abnormal = "slash event on providerWins=true";
    }
    if (!p.providerWins && !slash) {
      row.abnormal = "expected slash missing";
    }
    if (fin && fin.args.winner.toLowerCase() !== row.expectedWinner.toLowerCase()) {
      row.abnormal = (row.abnormal ? row.abnormal + "; " : "") + "winner mismatch";
    }
    finalizeReport.push(row);
    txs.finalize.push(row);
    console.log("FINALIZE", JSON.stringify(row));
  }

  const after = await snapshot("after");

  const summary = {
    signer: me.address,
    limitation: "single provider wallet only (admin is creator and provider)",
    decimals,
    jobsTouched: existing
      .filter((j) => !terminal.has(j.status) || j.jobURI.startsWith("ipfs://superion-stress/"))
      .map((j) => ({ id: j.id.toString(), uri: j.jobURI })),
    created: txs.create,
    approve: txs.approve,
    assign: txs.assign,
    submit: txs.submit,
    finalize: finalizeReport,
    before: before.row,
    after: after.row,
    superDelta: fmt(after.bal - before.bal, decimals),
    stakeDeltaTotal: fmt(before.stake - after.stake, decimals),
    marketplaceStuck: after.row.marketplaceSuper,
  };

  // Reload final job statuses for created + pre-existing non-skipped.
  const finalJobs = await listJobs();
  summary.allJobs = finalJobs.map((j) => ({
    id: j.id.toString(),
    status: j.statusName,
    budgetRemaining: fmt(j.budget, decimals),
    creator: j.creator,
    provider: j.provider,
    jobURI: j.jobURI,
  }));

  console.log("SUMMARY_JSON_START");
  console.log(JSON.stringify(summary, null, 2));
  console.log("SUMMARY_JSON_END");

  const fs = require("fs");
  fs.writeFileSync(
    "/workspace/superion-deploy/scripts/stress-marketplace-report.json",
    JSON.stringify(summary, null, 2)
  );
}

main().catch((e) => {
  console.error("STRESS_FAILED");
  console.error(e && e.stack ? e.stack : e);
  process.exit(1);
});
