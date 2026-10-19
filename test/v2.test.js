const { expect } = require("chai");
const { ethers } = require("hardhat");
const { loadFixture, time, impersonateAccount, setBalance } = require("@nomicfoundation/hardhat-network-helpers");
const { StandardMerkleTree } = require("@openzeppelin/merkle-tree");
const { deployCore, deployDistribution, allocationAmounts } = require("../scripts/v2/lib.cjs");
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
  return { admin, creator, provider, v1, v2, v3, v4, challenger, alice, bob, team, outsider, token, staking, timelock, governor, market, stake, verifiers: [v1, v2, v3, v4] };
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

async function completedJob(f, budget = 1000) {
  const id = await f.market.nextJobId();
  await f.market.connect(f.creator).createJob(S(budget), 3600, "ipfs://job");
  await f.market.connect(f.provider).assignJob(id);
  await f.market.connect(f.provider).submitResult(id, "ipfs://result");
  return id;
}

/** Conteste + révèle le comité ; retourne { id, committee, seed } */
async function challengeAndSelect(f, id, challenger = f.challenger) {
  const seed = freshSeed("challenge-" + id.toString());
  await f.market.connect(challenger).challengeJob(id, seedCommit(seed));
  await time.increase(MP.seedRevealDelay + 1);
  await f.market.connect(challenger).revealCommittee(id, seed);
  const committee = await f.market.committeeOf(id);
  return { committee, seed };
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

describe("Superion V2.1", function () {
  describe("Câblage des rôles", function () {
    it("le déployeur n'a plus de rôle admin ; Timelock admin ; marketplace opérateur", async function () {
      const { admin, staking, timelock, governor, market } = await loadFixture(fixture);
      const tl = await timelock.getAddress();
      expect(await staking.hasRole(await staking.DEFAULT_ADMIN_ROLE(), admin.address)).to.equal(false);
      expect(await staking.hasRole(await staking.DEFAULT_ADMIN_ROLE(), tl)).to.equal(true);
      expect(await staking.hasRole(await staking.OPERATOR_ROLE(), await market.getAddress())).to.equal(true);
      expect(await market.hasRole(await market.DEFAULT_ADMIN_ROLE(), admin.address)).to.equal(false);
      expect(await market.hasRole(await market.DEFAULT_ADMIN_ROLE(), tl)).to.equal(true);
      expect(await market.hasRole(await market.ARBITER_ROLE(), tl)).to.equal(true);
      expect(await market.hasRole(await market.PAUSER_ROLE(), admin.address)).to.equal(true);
      expect(await timelock.hasRole(await timelock.DEFAULT_ADMIN_ROLE(), admin.address)).to.equal(false);
      expect(await timelock.hasRole(await timelock.PROPOSER_ROLE(), await governor.getAddress())).to.equal(true);
      expect(await timelock.hasRole(await timelock.EXECUTOR_ROLE(), ethers.ZeroAddress)).to.equal(true);
      expect(await timelock.hasRole(await timelock.CANCELLER_ROLE(), admin.address)).to.equal(true);
      expect(await governor.CLOCK_MODE()).to.equal("mode=timestamp");
      expect(await governor.quorumAbsoluteMin()).to.equal(GOV.quorumAbsoluteMin);
      expect(await staking.rewardEligibilityDelay()).to.equal(GOV.rewardEligibilityDelay);
    });
  });

  describe("StakingV2 (stSUPER)", function () {
    it("stake : stSUPER 1:1, auto-délégation (votes), non transférable", async function () {
      const f = await loadFixture(fixture);
      await f.stake(f.alice, 1000);
      expect(await f.staking.balanceOf(f.alice.address)).to.equal(S(1000));
      expect(await f.staking.getVotes(f.alice.address)).to.equal(S(1000));
      await expect(f.staking.connect(f.alice).transfer(f.bob.address, 1)).to.be.revertedWithCustomError(f.staking, "NonTransferable");
      await expect(f.staking.connect(f.alice).approve(f.bob.address, 1)).to.be.revertedWithCustomError(f.staking, "NonTransferable");
      await expect(f.staking.connect(f.alice).stake(0)).to.be.revertedWithCustomError(f.staking, "ZeroAmount");
    });

    it("désengagement : votes retirés immédiatement, retrait après 14 jours (V2-fixes)", async function () {
      const f = await loadFixture(fixture);
      await f.stake(f.alice, 1000);
      await f.staking.connect(f.alice).requestUnstake(S(400));
      expect(await f.staking.getVotes(f.alice.address)).to.equal(S(600));
      await expect(f.staking.connect(f.alice).completeUnstake()).to.be.revertedWithCustomError(f.staking, "UnbondingNotFinished");
      await time.increase(7 * DAY);
      await expect(f.staking.connect(f.alice).completeUnstake()).to.be.revertedWithCustomError(f.staking, "UnbondingNotFinished");
      await time.increase(7 * DAY);
      const before = await f.token.balanceOf(f.alice.address);
      await f.staking.connect(f.alice).completeUnstake();
      expect(await f.token.balanceOf(f.alice.address)).to.equal(before + S(400));
      await stakingInvariant(f);
    });

    it("récompenses au prorata après délai d'éligibilité ; sniping flash bloqué", async function () {
      const f = await loadFixture(fixture);
      await f.stake(f.alice, 1000);
      await f.stake(f.bob, 3000);
      await time.increase(GOV.rewardEligibilityDelay + 1);
      // Interaction pendant/après délai : aligne paid (écarte RPT du délai si touché)
      await f.staking.connect(f.alice).claimRewards();
      await f.staking.connect(f.bob).claimRewards();

      await f.token.connect(f.creator).approve(await f.staking.getAddress(), ethers.MaxUint256);
      await f.staking.connect(f.creator).depositRewards(S(400));
      expect(await f.staking.earned(f.alice.address)).to.equal(S(100));
      expect(await f.staking.earned(f.bob.address)).to.equal(S(300));

      // sniper : stake juste avant un dépôt → earned 0 et claim refusé pendant le délai
      await f.stake(f.challenger, 10000);
      await f.staking.connect(f.creator).depositRewards(S(500));
      expect(await f.staking.earned(f.challenger.address)).to.equal(0);
      await expect(f.staking.connect(f.challenger).claimRewards()).to.be.revertedWithCustomError(f.staking, "RewardsNotEligible");

      // supply = 14000 ; alice conserve 100 + part du 2e dépôt
      expect(await f.staking.earned(f.alice.address)).to.be.closeTo(S(100) + (S(500) * S(1000)) / S(14000), 1000n);

      // Après le délai, une interaction du sniper aligne paid → il rate le dépôt de la fenêtre
      await time.increase(GOV.rewardEligibilityDelay + 1);
      await f.staking.connect(f.challenger).claimRewards();
      expect(await f.staking.earned(f.challenger.address)).to.equal(0);

      const before = await f.token.balanceOf(f.alice.address);
      const owed = await f.staking.earned(f.alice.address);
      await f.staking.connect(f.alice).claimRewards();
      expect(await f.token.balanceOf(f.alice.address)).to.equal(before + owed);
      await stakingInvariant(f);
    });

    it("récompenses mises en attente sans staker puis distribuées ; reste d'arrondi reporté", async function () {
      const f = await loadFixture(fixture);
      await f.token.connect(f.creator).approve(await f.staking.getAddress(), ethers.MaxUint256);
      await f.staking.connect(f.creator).depositRewards(S(100));
      expect(await f.staking.queuedRewards()).to.equal(S(100));
      await f.stake(f.alice, 3);
      await time.increase(GOV.rewardEligibilityDelay + 1);
      await f.staking.connect(f.alice).claimRewards(); // sync — écarte le queued qui a été distribué au stake mint path
      // At stake time, _distribute isn't called; queued stays until next deposit
      await f.staking.connect(f.creator).depositRewards(1n);
      // After sync, alice accrues from this deposit
      expect(await f.staking.earned(f.alice.address)).to.be.closeTo(S(100), 10n);
      expect(await f.staking.queuedRewards()).to.be.lt(10n);
      await stakingInvariant(f);
    });

    it("verrous et slash réservés à l'opérateur ; stake verrouillé non retirable", async function () {
      const f = await loadFixture(fixture);
      await f.stake(f.alice, 2000);
      await expect(f.staking.connect(f.alice).lock(f.alice.address, 1)).to.be.revertedWithCustomError(f.staking, "AccessControlUnauthorizedAccount");
      await expect(f.staking.connect(f.alice).slash(f.alice.address, 1)).to.be.revertedWithCustomError(f.staking, "AccessControlUnauthorizedAccount");
      await f.market.connect(f.alice).registerVerifier(); // verrouille 1000
      expect(await f.staking.availableStake(f.alice.address)).to.equal(S(1000));
      await expect(f.staking.connect(f.alice).requestUnstake(S(1001))).to.be.revertedWithCustomError(f.staking, "InsufficientUnlocked");
      await f.staking.connect(f.alice).requestUnstake(S(1000));
    });
  });

  describe("MarketplaceV2 — chemin optimiste et frais", function () {
    it("finalisation après la fenêtre : 2,5 % de frais, 50 % brûlés, 50 % aux stakers", async function () {
      const f = await withVerifiers();
      const id = await completedJob(f, 1000);
      expect(await f.staking.lockedStake(f.provider.address)).to.equal(S(1000));
      await expect(f.market.finalizeJob(id)).to.be.revertedWithCustomError(f.market, "TooEarly");
      await time.increase(MP.challengePeriod + 1);

      const supply0 = await f.token.totalSupply();
      const prov0 = await f.token.balanceOf(f.provider.address);
      const aliceE0 = await f.staking.earned(f.alice.address);
      await expect(f.market.connect(f.outsider).finalizeJob(id))
        .to.emit(f.market, "JobFinalized").withArgs(id, f.provider.address, S(975), S(25), S("12.5"), S("12.5"));
      expect(await f.token.totalSupply()).to.equal(supply0 - S("12.5"));
      expect(await f.token.balanceOf(f.provider.address)).to.equal(prov0 + S(975));
      expect(await f.staking.lockedStake(f.provider.address)).to.equal(0);
      // provider 5000 + alice 2000 + bob 3000 + 4*2000 verifiers = 18000
      const totalStaked = await f.staking.totalSupply();
      expect(totalStaked).to.equal(S(18000));
      const aliceGain = (await f.staking.earned(f.alice.address)) - aliceE0;
      expect(aliceGain).to.be.closeTo((S("12.5") * S(2000)) / totalStaked, 10n ** 6n);
      expect((await f.market.jobs(id)).status).to.equal(Status.Finalized);
      await stakingInvariant(f);
    });

    it("assignJob exige un stake disponible >= collatéral", async function () {
      const f = await withVerifiers();
      await f.market.connect(f.creator).createJob(S(4000), 3600, "a");
      await f.market.connect(f.creator).createJob(S(4000), 3600, "b");
      await f.market.connect(f.provider).assignJob(1);
      await expect(f.market.connect(f.provider).assignJob(2)).to.be.revertedWithCustomError(f.staking, "InsufficientUnlocked");
      await expect(f.market.connect(f.outsider).assignJob(2)).to.be.revertedWithCustomError(f.staking, "InsufficientUnlocked");
    });

    it("feeBps et burnShareBps figés à la création du job (M-03)", async function () {
      const f = await withVerifiers();
      await f.market.connect(f.creator).createJob(S(1000), 3600, "a");
      const tl = await asTimelock(f);
      await f.market.connect(tl).setFees(1000, 10000); // 10 % fee, 100 % burn — n'affecte pas le job déjà créé
      await f.market.connect(f.provider).assignJob(1);
      await f.market.connect(f.provider).submitResult(1, "r");
      await time.increase(MP.challengePeriod + 1);
      // fee figé 2,5 %, burnShare figé 50 % → burned 12.5, toStakers 12.5
      await expect(f.market.finalizeJob(1)).to.emit(f.market, "JobFinalized").withArgs(1, f.provider.address, S(975), S(25), S("12.5"), S("12.5"));
    });

    it("annulation (Open) et récupération après échéance", async function () {
      const f = await withVerifiers();
      await f.market.connect(f.creator).createJob(S(100), 3600, "a");
      await expect(f.market.connect(f.outsider).cancelJob(1)).to.be.revertedWithCustomError(f.market, "NotAllowed");
      await f.market.connect(f.creator).cancelJob(1);
      expect((await f.market.jobs(1)).status).to.equal(Status.Cancelled);
      await f.market.connect(f.creator).createJob(S(100), 600, "b");
      await f.market.connect(f.provider).assignJob(2);
      await expect(f.market.connect(f.creator).reclaimExpired(2)).to.be.revertedWithCustomError(f.market, "InvalidState");
      await time.increase(601);
      await expect(f.market.connect(f.provider).submitResult(2, "late")).to.be.revertedWithCustomError(f.market, "InvalidState");
      const c0 = await f.token.balanceOf(f.creator.address);
      await f.market.connect(f.creator).reclaimExpired(2);
      expect(await f.token.balanceOf(f.creator.address)).to.equal(c0 + S(100));
      expect(await f.staking.lockedStake(f.provider.address)).to.equal(0);
    });

    it("pause (gardien) bloque création et assignation, pas la finalisation", async function () {
      const f = await withVerifiers();
      const id = await completedJob(f);
      await f.market.connect(f.admin).pause();
      await expect(f.market.connect(f.creator).createJob(S(1), 60, "x")).to.be.revertedWithCustomError(f.market, "EnforcedPause");
      await time.increase(MP.challengePeriod + 1);
      await f.market.finalizeJob(id);
      await expect(f.market.connect(f.outsider).pause()).to.be.revertedWithCustomError(f.market, "AccessControlUnauthorizedAccount");
    });
  });

  describe("MarketplaceV2 — commit-reveal comité et votes", function () {
    it("comité tiré après reveal du seed ; exclus créateur/fournisseur/contestataire", async function () {
      const f = await withVerifiers();
      const id = await completedJob(f);
      await expect(f.market.connect(f.provider).challengeJob(id, seedCommit(freshSeed()))).to.be.revertedWithCustomError(f.market, "NotAllowed");
      const { committee } = await challengeAndSelect(f, id, f.v1);
      expect(committee.length).to.equal(3);
      expect(committee).to.not.include(f.v1.address);
      expect(new Set(committee).size).to.equal(3);
      for (const m of committee) expect((await f.market.verifiers(m)).duties).to.equal(1);
    });

    it("seed non révélé → expire, caution brûlée, job finalisable", async function () {
      const f = await withVerifiers();
      const id = await completedJob(f, 100);
      const seed = freshSeed("expire");
      await f.market.connect(f.challenger).challengeJob(id, seedCommit(seed));
      await expect(f.market.connect(f.challenger).revealCommittee(id, seed)).to.be.revertedWithCustomError(f.market, "TooEarly");
      await time.increase(MP.seedRevealWindow + 1);
      const supply0 = await f.token.totalSupply();
      await expect(f.market.expireUnrevealedChallenge(id))
        .to.emit(f.market, "ChallengeExpired").withArgs(id, f.challenger.address, S(25));
      expect(await f.token.totalSupply()).to.equal(supply0 - S(25));
      expect((await f.market.jobs(id)).status).to.equal(Status.Completed);
      await f.market.finalizeJob(id);
      expect((await f.market.jobs(id)).status).to.equal(Status.Finalized);
    });

    it("contestation rejetée 2 contre 1 : commit-reveal votes, caution aux majoritaires, minoritaire pénalisé", async function () {
      const f = await withVerifiers();
      const id = await completedJob(f, 1000);
      const { committee } = await challengeAndSelect(f, id);
      const [a, b, c] = committee;
      await expect(f.market.connect(f.outsider).commitVote(id, ethers.id("x"))).to.be.revertedWithCustomError(f.market, "NotAllowed");

      await castCommitteeVotes(f, id, committee, [true, true, false]);

      const supply0 = await f.token.totalSupply();
      const a0 = await f.token.balanceOf(a);
      const prov0 = await f.token.balanceOf(f.provider.address);
      const cStake0 = await f.staking.balanceOf(c);
      await expect(f.market.resolveDispute(id)).to.emit(f.market, "DisputeResolved").withArgs(id, true, false)
        .and.to.emit(f.market, "VerifierPenalized").withArgs(id, c, S(100));
      expect(await f.token.balanceOf(a)).to.equal(a0 + S("12.5")); // caution 25 / 2
      expect(await f.token.balanceOf(f.provider.address)).to.equal(prov0 + S(975));
      expect(await f.staking.balanceOf(c)).to.equal(cStake0 - S(100));
      expect((await f.market.verifiers(c)).bond).to.equal(S(900));
      // 900 < 1000 : éjecté
      expect((await f.market.verifiers(c)).indexPlus1).to.equal(0);
      expect(await f.market.verifierCount()).to.equal(3);
      // brûlé : 12.5 (frais) + 100 (pénalité)
      expect(await f.token.totalSupply()).to.equal(supply0 - S("12.5") - S(100));
      await stakingInvariant(f);
    });

    it("contestation fondée 3-0 : créateur remboursé, fournisseur slashé", async function () {
      const f = await withVerifiers();
      const id = await completedJob(f, 1000);
      const { committee } = await challengeAndSelect(f, id);
      await castCommitteeVotes(f, id, committee, [false, false, false]);
      const supply0 = await f.token.totalSupply();
      const cr0 = await f.token.balanceOf(f.creator.address);
      const ch0 = await f.token.balanceOf(f.challenger.address);
      const m0 = await f.token.balanceOf(committee[0]);
      const pStake0 = await f.staking.balanceOf(f.provider.address);
      const votes0 = await f.staking.getVotes(f.provider.address);
      await expect(f.market.resolveDispute(id)).to.emit(f.market, "ProviderSlashed");
      expect(await f.token.balanceOf(f.creator.address)).to.equal(cr0 + S(1000));
      // caution 25 rendue + 10% slash = 100
      expect(await f.token.balanceOf(f.challenger.address)).to.equal(ch0 + S(25) + S(100));
      const share = S(200) / 3n;
      expect(await f.token.balanceOf(committee[0])).to.equal(m0 + share);
      expect(await f.staking.balanceOf(f.provider.address)).to.equal(pStake0 - S(1000));
      expect(await f.staking.getVotes(f.provider.address)).to.equal(votes0 - S(1000));
      expect(await f.staking.lockedStake(f.provider.address)).to.equal(0);
      const burned = S(700) + (S(200) - share * 3n);
      expect(await f.token.totalSupply()).to.equal(supply0 - burned);
      expect((await f.market.jobs(id)).status).to.equal(Status.Refunded);
      for (const m of committee) expect((await f.market.verifiers(m)).duties).to.equal(0);
      await stakingInvariant(f);
    });

    it("vérificateur absent (non-reveal) pénalisé ; clôture après fin du reveal", async function () {
      const f = await withVerifiers();
      const id = await completedJob(f, 1000);
      const { committee } = await challengeAndSelect(f, id);
      const [a, b, c] = committee;
      // seuls a et b commit+reveal
      const saltA = ethers.id("a"), saltB = ethers.id("b");
      await f.market.connect(await ethers.getSigner(a)).commitVote(id, voteCommit(true, saltA, a, id));
      await f.market.connect(await ethers.getSigner(b)).commitVote(id, voteCommit(true, saltB, b, id));
      await time.increase(MP.voteCommitWindow + 1);
      await f.market.connect(await ethers.getSigner(a)).revealVote(id, true, saltA);
      await f.market.connect(await ethers.getSigner(b)).revealVote(id, true, saltB);
      await expect(f.market.resolveDispute(id)).to.be.revertedWithCustomError(f.market, "TooEarly");
      await time.increase(MP.voteRevealWindow + 1);
      await expect(f.market.connect(await ethers.getSigner(c)).revealVote(id, true, ethers.id("x"))).to.be.revertedWithCustomError(f.market, "TooLate");
      await expect(f.market.resolveDispute(id)).to.emit(f.market, "VerifierPenalized").withArgs(id, c, S(100));
    });

    it("pas de majorité : arbitre Timelock après le vote ; sinon issue neutre", async function () {
      const f = await withVerifiers();
      const id = await completedJob(f, 1000);
      const { committee } = await challengeAndSelect(f, id);
      const [a, b, c] = committee;
      // a true, b false, c absent → pas de majorité (besoin 2)
      const saltA = ethers.id("a"), saltB = ethers.id("b");
      await f.market.connect(await ethers.getSigner(a)).commitVote(id, voteCommit(true, saltA, a, id));
      await f.market.connect(await ethers.getSigner(b)).commitVote(id, voteCommit(false, saltB, b, id));
      await time.increase(MP.voteCommitWindow + 1);
      await f.market.connect(await ethers.getSigner(a)).revealVote(id, true, saltA);
      await f.market.connect(await ethers.getSigner(b)).revealVote(id, false, saltB);
      const tl = await asTimelock(f);
      await expect(f.market.connect(tl).arbitrate(id, false)).to.be.revertedWithCustomError(f.market, "TooEarly");
      await time.increase(MP.voteRevealWindow + 1);
      await expect(f.market.resolveDispute(id)).to.be.revertedWithCustomError(f.market, "NoMajority");
      await expect(f.market.connect(f.admin).arbitrate(id, false)).to.be.revertedWithCustomError(f.market, "AccessControlUnauthorizedAccount");
      await expect(f.market.resolveStale(id)).to.be.revertedWithCustomError(f.market, "TooEarly");
      await expect(f.market.connect(tl).arbitrate(id, false)).to.emit(f.market, "DisputeResolved").withArgs(id, false, true);
      expect((await f.market.verifiers(a)).bond).to.equal(S(900));
      expect((await f.market.verifiers(c)).bond).to.equal(S(900));
      expect((await f.market.verifiers(b)).bond).to.equal(S(1000));

      // second litige : personne ne tranche → issue neutre
      const id2 = await completedJob(f, 100);
      await challengeAndSelect(f, id2);
      await time.increase(VOTE_WINDOWS() + MP.arbitrationWindow + 2);
      await expect(f.market.connect(tl).arbitrate(id2, true)).to.be.revertedWithCustomError(f.market, "TooLate");
      const cr0 = await f.token.balanceOf(f.creator.address);
      const ch0 = await f.token.balanceOf(f.challenger.address);
      const p0 = await f.staking.balanceOf(f.provider.address);
      await f.market.resolveStale(id2);
      expect(await f.token.balanceOf(f.creator.address)).to.equal(cr0 + S(100));
      expect(await f.token.balanceOf(f.challenger.address)).to.equal(ch0 + S(25));
      expect(await f.staking.balanceOf(f.provider.address)).to.equal(p0);
      expect(await f.staking.lockedStake(f.provider.address)).to.equal(0);
    });

    it("sortie d'un vérificateur : caution bloquée tant qu'il siège", async function () {
      const f = await withVerifiers();
      const id = await completedJob(f, 100);
      const { committee } = await challengeAndSelect(f, id);
      const [a, b, c] = committee;
      const sa = await ethers.getSigner(a);
      await f.market.connect(sa).exitVerifier();
      expect((await f.market.verifiers(a)).indexPlus1).to.equal(0);
      expect(await f.staking.lockedStake(a)).to.equal(S(1000));
      await castCommitteeVotes(f, id, committee, [true, true, true]);
      await f.market.resolveDispute(id);
      await f.market.connect(sa).exitVerifier();
      expect(await f.staking.lockedStake(a)).to.equal(0);
      await f.market.connect(sa).registerVerifier();
      expect(await f.market.verifierCount()).to.equal(4);
    });

    it("aucun vérificateur : comité vide après reveal, arbitre requis", async function () {
      const f = await loadFixture(fixture);
      await f.stake(f.provider, 5000);
      await time.increase(GOV.rewardEligibilityDelay + 1);
      const id = await completedJob(f, 100);
      const seed = freshSeed("empty");
      await f.market.connect(f.challenger).challengeJob(id, seedCommit(seed));
      await time.increase(MP.seedRevealDelay + 1);
      await f.market.connect(f.challenger).revealCommittee(id, seed);
      expect((await f.market.committeeOf(id)).length).to.equal(0);
      await time.increase(VOTE_WINDOWS() + 1);
      await expect(f.market.resolveDispute(id)).to.be.revertedWithCustomError(f.market, "NoMajority");
      const tl = await asTimelock(f);
      await f.market.connect(tl).arbitrate(id, true);
      expect((await f.market.jobs(id)).status).to.equal(Status.Finalized);
    });
  });

  describe("Paramètres gouvernables", function () {
    it("seul le Timelock modifie les paramètres ; plafonds et challengeBond min", async function () {
      const f = await loadFixture(fixture);
      await expect(f.market.connect(f.admin).setFees(300, 5000)).to.be.revertedWithCustomError(f.market, "AccessControlUnauthorizedAccount");
      const tl = await asTimelock(f);
      await expect(f.market.connect(tl).setFees(1001, 5000)).to.be.revertedWithCustomError(f.market, "InvalidParams");
      await expect(f.market.connect(tl).setFees(100, 10001)).to.be.revertedWithCustomError(f.market, "InvalidParams");
      await expect(f.market.connect(tl).setParams({ ...MP, committeeSize: 4 })).to.be.revertedWithCustomError(f.market, "InvalidParams");
      await expect(f.market.connect(tl).setParams({ ...MP, slashVerifierBps: 6000, slashChallengerBps: 5000 })).to.be.revertedWithCustomError(f.market, "InvalidParams");
      await expect(f.market.connect(tl).setParams({ ...MP, challengeBond: 0 })).to.be.revertedWithCustomError(f.market, "InvalidParams");
      await f.market.connect(tl).setFees(1000, 0);
      expect((await f.market.params()).feeBps).to.equal(1000);
    });
  });

  describe("Gouvernance (Governor + Timelock)", function () {
    async function proposeFee(f, proposer, fee, burn, desc) {
      const target = await f.market.getAddress();
      const data = f.market.interface.encodeFunctionData("setFees", [fee, burn]);
      await f.governor.connect(proposer).propose([target], [0], [data], desc);
      const descHash = ethers.id(desc);
      const pid = await f.governor.hashProposal([target], [0], [data], descHash);
      return { target, data, descHash, pid };
    }

    it("proposition -> vote -> file -> exécution : frais à 3 %", async function () {
      const f = await loadFixture(fixture);
      await f.stake(f.alice, 100000);
      await f.stake(f.bob, 1000);
      await time.increase(GOV.rewardEligibilityDelay + 1);
      await time.increase(1);
      await expect(f.governor.connect(f.outsider).propose([await f.market.getAddress()], [0], ["0x"], "x"))
        .to.be.revertedWithCustomError(f.governor, "GovernorInsufficientProposerVotes");
      const p = await proposeFee(f, f.alice, 300, 6000, "Frais 3 %, 60 % brûlés");
      expect(await f.governor.state(p.pid)).to.equal(0);
      await time.increase(GOV.votingDelay + 1);
      expect(await f.governor.state(p.pid)).to.equal(1);
      await f.governor.connect(f.alice).castVote(p.pid, 1);
      await f.governor.connect(f.bob).castVote(p.pid, 0);
      await time.increase(GOV.votingPeriod + 1);
      expect(await f.governor.state(p.pid)).to.equal(4);
      await f.governor.queue([p.target], [0], [p.data], p.descHash);
      expect(await f.governor.state(p.pid)).to.equal(5);
      await expect(f.governor.execute([p.target], [0], [p.data], p.descHash)).to.be.reverted;
      await time.increase(GOV.timelockDelay + 1);
      await f.governor.connect(f.outsider).execute([p.target], [0], [p.data], p.descHash);
      expect(await f.governor.state(p.pid)).to.equal(7);
      const params = await f.market.params();
      expect(params.feeBps).to.equal(300);
      expect(params.burnShareBps).to.equal(6000);
    });

    it("quorum non atteint -> rejetée ; gardien peut annuler ; plancher absolu", async function () {
      const f = await loadFixture(fixture);
      await f.stake(f.alice, 100000);
      await f.stake(f.bob, 500); // sous le plancher absolu de 1000
      await time.increase(GOV.rewardEligibilityDelay + 1);
      await time.increase(1);
      const p = await proposeFee(f, f.alice, 300, 5000, "quorum test");
      // alice proposes; only bob votes with 500 < quorumAbsoluteMin 1000
      await time.increase(GOV.votingDelay + 1);
      await f.governor.connect(f.bob).castVote(p.pid, 1);
      await time.increase(GOV.votingPeriod + 1);
      expect(await f.governor.state(p.pid)).to.equal(3); // Defeated (quorum)

      const p2 = await proposeFee(f, f.alice, 500, 5000, "veto test");
      await time.increase(GOV.votingDelay + 1);
      await f.governor.connect(f.alice).castVote(p2.pid, 1);
      await time.increase(GOV.votingPeriod + 1);
      await f.governor.queue([p2.target], [0], [p2.data], p2.descHash);
      const opId = await f.timelock.hashOperationBatch([p2.target], [0], [p2.data], ethers.ZeroHash, await (async () => {
        const govAddr = await f.governor.getAddress();
        const salt = ethers.zeroPadBytes(govAddr, 32);
        return ethers.toBeHex(BigInt(salt) ^ BigInt(p2.descHash), 32);
      })());
      expect(await f.timelock.isOperationPending(opId)).to.equal(true);
      await f.timelock.connect(f.admin).cancel(opId);
      expect(await f.governor.state(p2.pid)).to.equal(2);
    });

    it("votes figés au snapshot (anti flash-stake)", async function () {
      const f = await loadFixture(fixture);
      await f.stake(f.alice, 10000);
      await time.increase(GOV.rewardEligibilityDelay + 1);
      await time.increase(1);
      const p = await proposeFee(f, f.alice, 300, 5000, "snapshot");
      await time.increase(GOV.votingDelay + 1);
      await f.stake(f.bob, 100000);
      await f.governor.connect(f.bob).castVote(p.pid, 0);
      const [against, forV] = await f.governor.proposalVotes(p.pid);
      expect(against).to.equal(0);
      expect(forV).to.equal(0);
    });
  });

  describe("Répartition & vesting", function () {
    async function distFixture() {
      const f = await loadFixture(fixture);
      const start = BigInt(await time.latest()) + 10n;
      const tree = StandardMerkleTree.of([[f.alice.address, S(4000).toString()], [f.bob.address, S(6000).toString()]], ["address", "uint256"]);
      const deadline = start + BigInt(30 * DAY);
      const tl = await f.timelock.getAddress();
      const out = await deployDistribution(ethers, {
        superToken: await f.token.getAddress(), funder: f.admin, timelock: tl, team: f.team.address,
        foundation: f.admin.address, start, airdropRoot: tree.root, airdropDeadline: deadline,
      });
      const b = Object.fromEntries(out.buckets.map((x) => [x.key, x]));
      return { ...f, out, b, start, tree, deadline, tl };
    }

    it("pourcentages = 100 % et montants exacts (1 Md)", async function () {
      const a = allocationAmounts();
      expect(a.reduce((s, x) => s + x.amount, 0n)).to.equal(TOTAL_SUPPLY);
      const f = await distFixture();
      expect(await f.token.balanceOf(f.b.ecosystem.vesting)).to.equal(S(370_000_000));
      expect(await f.token.balanceOf(f.b.team.vesting)).to.equal(S(160_000_000));
      expect(await f.token.balanceOf(f.b.treasury.vesting)).to.equal(S(170_000_000));
      expect(await f.token.balanceOf(f.b.community.airdrop)).to.equal(S(10_000));
      expect(await f.token.balanceOf(f.tl)).to.equal(S(170_000_000) - S(10_000));
    });

    it("équipe : rien avant cliff 12 mois, 25 % au cliff, linéaire 4 ans", async function () {
      const f = await distFixture();
      const v = await ethers.getContractAt("SuperionVesting", f.b.team.vesting);
      const tokenAddr = await f.token.getAddress();
      expect(await v.owner()).to.equal(f.team.address);
      const total = S(160_000_000);
      const at = (t) => v["vestedAmount(address,uint64)"](tokenAddr, t);
      expect(await at(f.start + BigInt(YEAR) - 1n)).to.equal(0);
      expect(await at(f.start + BigInt(YEAR))).to.equal(total / 4n);
      expect(await at(f.start + BigInt(2 * YEAR))).to.equal(total / 2n);
      expect(await at(f.start + BigInt(4 * YEAR))).to.equal(total);
      await time.increaseTo(f.start + BigInt(YEAR) - 5n);
      expect(await v["releasable(address)"](tokenAddr)).to.equal(0);
      await time.increaseTo(f.start + BigInt(2 * YEAR));
      await v["release(address)"](tokenAddr);
      expect(await f.token.balanceOf(f.team.address)).to.be.closeTo(total / 2n, S(10));
    });

    it("écosystème linéaire 4 ans ; trésorerie cliff 6 mois / 3 ans", async function () {
      const f = await distFixture();
      const tokenAddr = await f.token.getAddress();
      const eco = await ethers.getContractAt("SuperionVesting", f.b.ecosystem.vesting);
      const tre = await ethers.getContractAt("SuperionVesting", f.b.treasury.vesting);
      expect(await eco.owner()).to.equal(f.tl);
      expect(await eco["vestedAmount(address,uint64)"](tokenAddr, f.start + BigInt(YEAR))).to.equal(S(370_000_000) / 4n);
      expect(await tre["vestedAmount(address,uint64)"](tokenAddr, f.start + BigInt(YEAR / 2) - 1n)).to.equal(0);
      expect(await tre["vestedAmount(address,uint64)"](tokenAddr, f.start + BigInt(3 * YEAR))).to.equal(S(170_000_000));
    });

    it("airdrop Merkle : réclamation, double refusée, sweep ; amount 0 refusé", async function () {
      const f = await distFixture();
      const air = await ethers.getContractAt("SuperionMerkleAirdrop", f.b.community.airdrop);
      let proof;
      for (const [i, v] of f.tree.entries()) if (v[0] === f.alice.address) proof = f.tree.getProof(i);
      await expect(air.claim(f.alice.address, S(5000), proof)).to.be.revertedWithCustomError(air, "InvalidProof");
      await expect(air.claim(f.alice.address, 0, proof)).to.be.revertedWithCustomError(air, "ZeroAmount");
      const a0 = await f.token.balanceOf(f.alice.address);
      await air.connect(f.outsider).claim(f.alice.address, S(4000), proof);
      expect(await f.token.balanceOf(f.alice.address)).to.equal(a0 + S(4000));
      await expect(air.claim(f.alice.address, S(4000), proof)).to.be.revertedWithCustomError(air, "AlreadyClaimed");
      await expect(air.sweep()).to.be.revertedWithCustomError(air, "ClaimOpen");
      await time.increaseTo(f.deadline + 1n);
      const t0 = await f.token.balanceOf(f.tl);
      await air.sweep();
      expect(await f.token.balanceOf(f.tl)).to.equal(t0 + S(6000));
    });
  });
});
