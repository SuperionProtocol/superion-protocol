const { expect } = require("chai");
const { ethers } = require("hardhat");
const { loadFixture, time, impersonateAccount, setBalance } = require("@nomicfoundation/hardhat-network-helpers");
const { StandardMerkleTree } = require("@openzeppelin/merkle-tree");
const { VRF_DEFAULTS, deployVrfMock, deployCore, deployDistribution, allocationAmounts } = require("../scripts/v2/lib.cjs");
const { S, YEAR, DAY, MARKETPLACE_PARAMS_TESTNET: MP, GOV_TESTNET: GOV, TOTAL_SUPPLY } = require("../scripts/v2/config.cjs");

const Status = { None: 0, Open: 1, Assigned: 2, Completed: 3, Disputed: 4, Finalized: 5, Refunded: 6, Cancelled: 7 };
const BPS = 10000n;
const VOTE_WINDOWS = () => MP.voteCommitWindow + MP.voteRevealWindow;

function seedCommit(seed) {
  return ethers.keccak256(ethers.AbiCoder.defaultAbiCoder().encode(["bytes32"], [seed]));
}
function voteCommit(providerValid, salt, voter, jobId) {
  return ethers.keccak256(ethers.AbiCoder.defaultAbiCoder().encode(
    ["bool", "bytes32", "address", "uint256"],
    [providerValid, salt, voter, jobId]
  ));
}
function freshSeed(label = "s") {
  return ethers.id(label + Math.random().toString());
}

async function fixture() {
  const [admin, creator, provider, v1, v2, v3, v4, challenger, alice, bob, team, outsider] = await ethers.getSigners();
  const token = await (await ethers.getContractFactory("SuperionToken")).deploy(admin.address);
  const superToken = await token.getAddress();
  const core = await deployCore(ethers, { superToken, deployer: admin, guardian: admin.address, marketParams: MP, gov: GOV });
  const { staking, timelock, governor, market } = core;
  // V2-fixes : ces tests historiques valident la logique V2.1 de base ; on y désactive l'appel
  // (appealWindow = 0) et le délai de sortie vérificateur. Les nouveaux mécanismes sont testés
  // avec les valeurs par défaut dans test/v2-fixes.test.js.
  {
    const tlAddr = await timelock.getAddress();
    await impersonateAccount(tlAddr);
    await setBalance(tlAddr, ethers.parseEther("1"));
    const sp = await market.securityParams();
    await market.connect(await ethers.getSigner(tlAddr)).setSecurityParams({
      stakeToValueBps: sp.stakeToValueBps, maxRerolls: sp.maxRerolls, verifierCooldown: 0,
      appealWindow: 0, appealCommitteeSize: sp.appealCommitteeSize, appealBondBps: sp.appealBondBps,
    });
  }
  const stAddr = await staking.getAddress();
  const mAddr = await market.getAddress();

  for (const [s, amt] of [[creator, 100000], [provider, 50000], [v1, 10000], [v2, 10000], [v3, 10000], [v4, 10000], [challenger, 20000], [alice, 200000], [bob, 200000]]) {
    await token.transfer(s.address, S(amt));
    await token.connect(s).approve(stAddr, ethers.MaxUint256);
    await token.connect(s).approve(mAddr, ethers.MaxUint256);
  }
  const stake = async (s, amt) => {
    await staking.connect(s).stake(S(amt));
  };
  return { vrf: core.vrf.mock, admin, creator, provider, v1, v2, v3, v4, challenger, alice, bob, team, outsider, token, staking, timelock, governor, market, stake, verifiers: [v1, v2, v3, v4] };
}

async function withVerifiers() {
  const f = await loadFixture(fixture);
  for (const v of f.verifiers) { await f.stake(v, 2000); await f.market.connect(v).registerVerifier(); }
  await f.stake(f.provider, 5000);
  await f.stake(f.alice, 2000);
  await f.stake(f.bob, 3000);
  // délai d'éligibilité rewards (M-05)
  await time.increase(GOV.rewardEligibilityDelay + 1);
  return f;
}

async function fulfillDraw(f, id) {
  const r = (await f.market.pendingDraw(id)).requestId;
  await f.vrf.fulfillRandomWords(r, await f.market.getAddress());
}

async function completedJob(f, budget = 1000) {
  const id = await f.market.nextJobId();
  await f.market.connect(f.creator).createJob(S(budget), 3600, "ipfs://job");
  await f.market.connect(f.provider).assignJob(id);
  await f.market.connect(f.provider).submitResult(id, "ipfs://result");
  return id;
}

/** Conteste + révèle le comité ; retourne { id, committee, seed } */
async function challengeAndSelect(f, id, challenger = f.challenger) {
  await f.market.connect(challenger).challengeJob(id);
  await fulfillDraw(f, id);
  const committee = await f.market.committeeOf(id);
  return { committee };
}

/** Commit + reveal des votes. votes[i] = bool providerValid pour committee[i] */
async function castCommitteeVotes(f, id, committee, votes) {
  const salts = [];
  for (let i = 0; i < committee.length; i++) {
    const salt = ethers.id("salt-" + id + "-" + i);
    salts.push(salt);
    const voter = await ethers.getSigner(committee[i]);
    const h = voteCommit(votes[i], salt, committee[i], id);
    await f.market.connect(voter).commitVote(id, h);
  }
  await time.increase(MP.voteCommitWindow + 1);
  for (let i = 0; i < committee.length; i++) {
    const voter = await ethers.getSigner(committee[i]);
    await f.market.connect(voter).revealVote(id, votes[i], salts[i]);
  }
}

async function stakingInvariant(f) {
  const bal = await f.token.balanceOf(await f.staking.getAddress());
  const sum = (await f.staking.totalSupply()) + (await f.staking.totalUnbonding()) + (await f.staking.totalRewardsOwed()) + (await f.staking.queuedRewards());
  expect(bal).to.equal(sum);
}

async function asTimelock(f) {
  const addr = await f.timelock.getAddress();
  await impersonateAccount(addr);
  await setBalance(addr, ethers.parseEther("1"));
  return ethers.getSigner(addr);
}

// ---------------------------------------------------------------------------
// Tests "hardening" : attaques, régressions HARDENING-01/02, fuzz/invariants.
// Le projet utilise Hardhat (pas Foundry) : le fuzz est fait avec un PRNG à graine fixe
// (reproductible) — FUZZ_RUNS=n pour augmenter le nombre d'itérations.
// ---------------------------------------------------------------------------
const FUZZ_RUNS = Number(process.env.FUZZ_RUNS || 40);
function prng(seed) { let x = BigInt(seed) || 1n; return () => { x ^= x << 13n; x &= (1n << 64n) - 1n; x ^= x >> 7n; x ^= x << 17n; x &= (1n << 64n) - 1n; return x; }; }
const pick = (r, n) => Number(r() % BigInt(n));

async function marketInvariant(f, ids) {
  // Le solde SUPER du marketplace = budgets des jobs non clos + cautions des litiges en cours.
  let sum = 0n;
  for (const id of ids) {
    const j = await f.market.jobs(id);
    sum += j.budget;
    const d = await f.market.disputes(id);
    sum += d.bond;
  }
  expect(await f.token.balanceOf(await f.market.getAddress())).to.equal(sum);
}

describe("Hardening — scénarios d'attaque", function () {
  async function evilSetup() {
    const [admin, provider, keeper] = await ethers.getSigners();
    const evil = await (await ethers.getContractFactory("ReentrantToken")).deploy();
    const eAddr = await evil.getAddress();
    const staking = await (await ethers.getContractFactory("SuperionStakingV2")).deploy(eAddr, admin.address, 60);
    const vrf = await deployVrfMock(ethers, admin);
    const market = await (await ethers.getContractFactory("SuperionJobMarketplaceV2")).deploy(
      eAddr, await staking.getAddress(), admin.address, admin.address, admin.address, { ...MP, providerStakeBps: 0 },
      vrf.coordinator, { ...VRF_DEFAULTS, keyHash: vrf.keyHash, subId: vrf.subId });
    await staking.grantRole(await staking.OPERATOR_ROLE(), await market.getAddress());
    const mAddr = await market.getAddress();
    await evil.mint(eAddr, S(1000));
    await evil.selfApprove(mAddr, ethers.MaxUint256);
    const createData = market.interface.encodeFunctionData("createJob", [S(100), 3600, "ipfs://evil"]);
    await evil.exec(mAddr, createData);
    return { admin, provider, keeper, evil, staking, market, mAddr, eAddr };
  }

  it("ré-entrée bloquée : cancelJob rappelé pendant le remboursement", async function () {
    const { evil, market, mAddr, eAddr } = await evilSetup();
    const cancel = market.interface.encodeFunctionData("cancelJob", [1]);
    await evil.arm(mAddr, cancel);
    await evil.exec(mAddr, cancel);
    expect(await evil.attempts()).to.equal(1n);
    expect(await evil.lastOk()).to.equal(false); // ReentrancyGuard
    expect(await evil.balanceOf(eAddr)).to.equal(S(1000)); // remboursé une seule fois
    expect((await market.jobs(1)).status).to.equal(Status.Cancelled);
  });

  it("ré-entrée bloquée : double finalizeJob pendant le paiement", async function () {
    const { evil, market, mAddr, provider, keeper } = await evilSetup();
    await market.connect(provider).assignJob(1);
    await market.connect(provider).submitResult(1, "ipfs://r");
    await time.increase(MP.challengePeriod + 1);
    await evil.arm(mAddr, market.interface.encodeFunctionData("finalizeJob", [1]));
    await market.connect(keeper).finalizeJob(1);
    expect(await evil.lastOk()).to.equal(false);
    expect(await evil.balanceOf(provider.address)).to.equal(S(100) - S(100) * BigInt(MP.feeBps) / BPS);
    await expect(market.finalizeJob(1)).to.be.revertedWithCustomError(market, "InvalidState");
  });

  it("double finalisation / finalisation après litige refusées", async function () {
    const f = await withVerifiers();
    const id = await completedJob(f);
    await time.increase(MP.challengePeriod + 1);
    await f.market.finalizeJob(id);
    await expect(f.market.finalizeJob(id)).to.be.revertedWithCustomError(f.market, "InvalidState");
    await expect(f.market.connect(f.challenger).challengeJob(id)).to.be.revertedWithCustomError(f.market, "InvalidState");
    const id2 = await completedJob(f);
    const { committee } = await challengeAndSelect(f, id2);
    await castCommitteeVotes(f, id2, committee, [false, false, false]);
    await f.market.resolveDispute(id2);
    await expect(f.market.resolveDispute(id2)).to.be.revertedWithCustomError(f.market, "InvalidState");
    await expect(f.market.finalizeJob(id2)).to.be.revertedWithCustomError(f.market, "InvalidState");
    await expect(f.market.connect(f.creator).reclaimExpired(id2)).to.be.revertedWithCustomError(f.market, "InvalidState");
  });

  it("slash / lock / unlock non autorisés refusés (seul le marketplace est opérateur)", async function () {
    const f = await withVerifiers();
    for (const fn of ["slash", "lock", "unlock"]) {
      await expect(f.staking.connect(f.outsider)[fn](f.provider.address, 1)).to.be.revertedWithCustomError(f.staking, "AccessControlUnauthorizedAccount");
    }
    await expect(f.staking.connect(f.admin).slash(f.provider.address, 1)).to.be.revertedWithCustomError(f.staking, "AccessControlUnauthorizedAccount");
  });

  it("arbitrage / paramètres / pause non autorisés refusés", async function () {
    const f = await withVerifiers();
    const id = await completedJob(f);
    await challengeAndSelect(f, id);
    await expect(f.market.connect(f.outsider).arbitrate(id, false)).to.be.revertedWithCustomError(f.market, "AccessControlUnauthorizedAccount");
    await expect(f.market.connect(f.admin).setFees(0, 0)).to.be.revertedWithCustomError(f.market, "AccessControlUnauthorizedAccount");
    await expect(f.market.connect(f.outsider).pause()).to.be.revertedWithCustomError(f.market, "AccessControlUnauthorizedAccount");
  });

  it("collusion : vote copié inutilisable, double vote et non-membre refusés", async function () {
    const f = await withVerifiers();
    const id = await completedJob(f);
    const { committee } = await challengeAndSelect(f, id);
    const [a, b] = await Promise.all(committee.slice(0, 2).map((x) => ethers.getSigner(x)));
    const salt = ethers.id("a");
    const h = voteCommit(true, salt, a.address, id);
    await f.market.connect(a).commitVote(id, h);
    await expect(f.market.connect(a).commitVote(id, h)).to.be.revertedWithCustomError(f.market, "NotAllowed");
    await f.market.connect(b).commitVote(id, h); // b copie le commit de a
    await expect(f.market.connect(f.outsider).commitVote(id, h)).to.be.revertedWithCustomError(f.market, "NotAllowed");
    await time.increase(MP.voteCommitWindow + 1);
    await expect(f.market.connect(b).revealVote(id, true, salt)).to.be.revertedWithCustomError(f.market, "BadCommit");
    await expect(f.market.connect(a).revealVote(id, false, salt)).to.be.revertedWithCustomError(f.market, "BadCommit");
    await f.market.connect(a).revealVote(id, true, salt);
    await expect(f.market.connect(a).revealVote(id, true, salt)).to.be.revertedWithCustomError(f.market, "NotAllowed");
  });

  it("collusion : parties au job jamais tirées au comité même si vérificatrices", async function () {
    const f = await withVerifiers();
    // creator, challenger et provider deviennent vérificateurs
    for (const s of [f.creator, f.challenger]) { await f.stake(s, 2000); await f.market.connect(s).registerVerifier(); }
    await f.stake(f.provider, 2000); await f.market.connect(f.provider).registerVerifier();
    for (let k = 0; k < 4; k++) {
      const id = await completedJob(f, 100);
      const { committee } = await challengeAndSelect(f, id);
      for (const s of [f.creator, f.challenger, f.provider]) expect(committee).to.not.include(s.address);
    }
  });

  it("collusion (limite documentée) : 2 vérificateurs complices sur 3 imposent l'issue ; l'honnête est pénalisé", async function () {
    const f = await withVerifiers();
    const id = await completedJob(f);
    const { committee } = await challengeAndSelect(f, id);
    expect(committee.length).to.equal(3);
    await castCommitteeVotes(f, id, committee, [false, false, true]);
    await expect(f.market.resolveDispute(id)).to.emit(f.market, "VerifierPenalized").withArgs(id, committee[2], S(100));
  });

  it("VRF-01 : seul le coordinateur peut livrer l'aléa ; une réponse inconnue est ignorée", async function () {
    const f = await withVerifiers();
    const id = await completedJob(f);
    await f.market.connect(f.challenger).challengeJob(id);
    const req = (await f.market.pendingDraw(id)).requestId;
    // le contestataire (ou n'importe qui) ne peut pas injecter son propre aléa
    await expect(f.market.connect(f.challenger).rawFulfillRandomWords(req, [7n]))
      .to.be.revertedWithCustomError(f.market, "OnlyCoordinatorCanFulfill");
    expect((await f.market.disputes(id)).committeeSelected).to.equal(false);
    await fulfillDraw(f, id);
    expect((await f.market.committeeOf(id)).length).to.equal(3);
  });

  it("VRF-01 : le comité dépend uniquement du mot VRF (même mot -> même comité, plus de blockhash)", async function () {
    const f = await withVerifiers();
    const id1 = await completedJob(f);
    const id2 = await completedJob(f);
    await f.market.connect(f.challenger).challengeJob(id1);
    await ethers.provider.send("hardhat_mine", ["0x40", "0x1"]); // blocs différents
    await f.market.connect(f.challenger).challengeJob(id2);
    const m = await f.market.getAddress();
    await f.vrf.fulfillRandomWordsWithOverride((await f.market.pendingDraw(id1)).requestId, m, [12345n]);
    await f.vrf.fulfillRandomWordsWithOverride((await f.market.pendingDraw(id2)).requestId, m, [12345n]);
    expect(await f.market.committeeOf(id1)).to.deep.equal(await f.market.committeeOf(id2));
  });
});

describe("Hardening — fuzz / invariants (PRNG reproductible)", function () {
  it(`staking : solde = supply + unbonding + rewards dus + en attente (${FUZZ_RUNS} actions)`, async function () {
    const f = await loadFixture(fixture);
    const r = prng(0xC0FFEE);
    const users = [f.alice, f.bob, f.v1, f.v2];
    for (let i = 0; i < FUZZ_RUNS; i++) {
      const u = users[pick(r, users.length)];
      const op = pick(r, 5);
      const amt = S(1 + pick(r, 500));
      if (op === 0) await f.staking.connect(u).stake(amt);
      else if (op === 1) { const av = await f.staking.availableStake(u.address); if (av > 0n) await f.staking.connect(u).requestUnstake(av < amt ? av : amt); }
      else if (op === 2) await f.staking.connect(u).depositRewards(S(1 + pick(r, 50)) + BigInt(pick(r, 1000)));
      else if (op === 3) { await time.increase(1 + pick(r, 3 * DAY)); if ((await f.staking.unbonding(u.address)).amount > 0n) { try { await f.staking.connect(u).completeUnstake(); } catch (_) {} } }
      else { try { await f.staking.connect(u).claimRewards(); } catch (_) {} }
      await stakingInvariant(f);
    }
  });

  it(`marketplace : conservation des fonds sur ${Math.ceil(FUZZ_RUNS / 4)} jobs aléatoires`, async function () {
    const f = await withVerifiers();
    const r = prng(0xBADA55);
    const ids = [];
    const supply0 = await f.token.totalSupply();
    let burned = 0n;
    for (let i = 0; i < Math.ceil(FUZZ_RUNS / 4); i++) {
      const budget = 1 + pick(r, 1500);
      const id = await f.market.nextJobId();
      await f.market.connect(f.creator).createJob(S(budget), 3600, "ipfs://j");
      ids.push(id);
      const path = pick(r, 5);
      if (path === 0) { await f.market.connect(f.creator).cancelJob(id); }
      else {
        const av = await f.staking.availableStake(f.provider.address);
        if (av < S(budget)) { await f.token.transfer(f.provider.address, S(budget)); await f.staking.connect(f.provider).stake(S(budget)); }
        await f.market.connect(f.provider).assignJob(id);
        if (path === 1) { await time.increase(3601); await f.market.connect(f.creator).reclaimExpired(id); }
        else {
          await f.market.connect(f.provider).submitResult(id, "ipfs://r");
          if (path === 2) { await time.increase(MP.challengePeriod + 1); await f.market.finalizeJob(id); }
          else if (path === 3) {
            // VRF non servi : relance après timeout puis comité unanime
            await f.market.connect(f.challenger).challengeJob(id);
            await time.increase(VRF_DEFAULTS.requestTimeout + 1);
            await f.market.retryDraw(id);
            const { committee } = { committee: (await fulfillDraw(f, id), await f.market.committeeOf(id)) };
            await castCommitteeVotes(f, id, committee, committee.map(() => true));
            if (committee.length > 0) await f.market.resolveDispute(id);
            else { await time.increase(MP.voteRevealWindow + 1); await f.market.connect(await asTimelock(f)).arbitrate(id, true); }
          }
          else {
            const { committee } = await challengeAndSelect(f, id);
            const votes = committee.map(() => pick(r, 2) === 0);
            await castCommitteeVotes(f, id, committee, votes);
            const yes = votes.filter(Boolean).length;
            if (yes * 2 > votes.length || (votes.length - yes) * 2 > votes.length) await f.market.resolveDispute(id);
          }
        }
      }
      await marketInvariant(f, ids);
      await stakingInvariant(f);
      // statut final cohérent : un job clos n'a plus de budget
      const j = await f.market.jobs(id);
      if ([Status.Finalized, Status.Refunded, Status.Cancelled].includes(Number(j.status))) expect(j.budget).to.equal(0n);
    }
    // l'offre totale ne peut que baisser (burn), jamais augmenter
    expect(await f.token.totalSupply()).to.be.lte(supply0);
  });

  it(`paramètres : setParams aléatoires — jamais d'état hors bornes (${FUZZ_RUNS} essais)`, async function () {
    const f = await loadFixture(fixture);
    const tl = await asTimelock(f);
    const r = prng(42);
    for (let i = 0; i < FUZZ_RUNS; i++) {
      const p = { ...MP,
        feeBps: pick(r, 1500), burnShareBps: pick(r, 12000), seedRevealDelay: pick(r, 600), seedRevealWindow: pick(r, 900),
        committeeSize: pick(r, 18), slashVerifierBps: pick(r, 8000), slashChallengerBps: pick(r, 8000) };
      try { await f.market.connect(tl).setParams(p); } catch (_) {}
      const q = await f.market.params();
      expect(q.feeBps).to.be.lte(1000n);
      expect(q.burnShareBps).to.be.lte(10000n);
      expect(q.committeeSize % 2n).to.equal(1n);
      expect(q.slashVerifierBps + q.slashChallengerBps).to.be.lte(10000n);
    }
  });
});
