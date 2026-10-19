// Tests des correctifs V2-fixes (suite à la revue Reddit).
const { expect } = require("chai");
const { ethers } = require("hardhat");
const { loadFixture, time, impersonateAccount, setBalance, mine } = require("@nomicfoundation/hardhat-network-helpers");
const { deployCore } = require("../scripts/v2/lib.cjs");
const { S, DAY, MARKETPLACE_PARAMS_TESTNET: MP, GOV_TESTNET: GOV } = require("../scripts/v2/config.cjs");

const Status = { Completed: 3, Disputed: 4, Finalized: 5, Refunded: 6 };
const enc = ethers.AbiCoder.defaultAbiCoder();
const seedCommit = (seed) => ethers.keccak256(enc.encode(["bytes32"], [seed]));
const voteCommit = (v, salt, voter, id) => ethers.keccak256(enc.encode(["bool", "bytes32", "address", "uint256"], [v, salt, voter, id]));
const VOTE_WINDOWS = MP.voteCommitWindow + MP.voteRevealWindow;

async function fixture() {
  const signers = await ethers.getSigners();
  const [admin, creator, provider, challenger, outsider] = signers;
  const vs = signers.slice(5, 15); // 10 vérificateurs
  const token = await (await ethers.getContractFactory("SuperionToken")).deploy(admin.address);
  const core = await deployCore(ethers, { superToken: await token.getAddress(), deployer: admin, guardian: admin.address, marketParams: MP, gov: GOV });
  const { staking, timelock, market } = core;
  const stAddr = await staking.getAddress(), mAddr = await market.getAddress();
  for (const [s, amt] of [[creator, 100000], [provider, 50000], [challenger, 20000], ...vs.map((v) => [v, 10000])]) {
    await token.transfer(s.address, S(amt));
    await token.connect(s).approve(stAddr, ethers.MaxUint256);
    await token.connect(s).approve(mAddr, ethers.MaxUint256);
  }
  for (const v of vs) { await staking.connect(v).stake(S(8000)); await market.connect(v).registerVerifier(); }
  await staking.connect(provider).stake(S(20000));
  await time.increase(GOV.rewardEligibilityDelay + 1);
  const tlAddr = await timelock.getAddress();
  await impersonateAccount(tlAddr);
  await setBalance(tlAddr, ethers.parseEther("1"));
  const tl = await ethers.getSigner(tlAddr);
  return { admin, creator, provider, challenger, outsider, vs, token, staking, market, tl };
}

async function completedJob(f, budget = 1000) {
  const id = await f.market.nextJobId();
  await f.market.connect(f.creator).createJob(S(budget), 3600, "ipfs://job");
  await f.market.connect(f.provider).assignJob(id);
  await f.market.connect(f.provider).submitResult(id, "ipfs://result");
  return id;
}
async function select(f, id, who, isAppeal = false) {
  const seed = ethers.id("seed" + Math.random());
  if (isAppeal) await f.market.connect(who).appeal(id, seedCommit(seed));
  else await f.market.connect(who).challengeJob(id, seedCommit(seed));
  await time.increase(MP.seedRevealDelay + 1);
  await f.market.connect(who).revealCommittee(id, seed);
  return f.market.committeeOf(id);
}
/** votes[i] : true/false = vote, null = commit sans reveal, undefined = absent */
async function vote(f, id, committee, votes) {
  const salts = [];
  for (let i = 0; i < committee.length; i++) {
    salts.push(ethers.id("salt" + i + Math.random()));
    if (votes[i] === undefined) continue;
    await f.market.connect(await ethers.getSigner(committee[i])).commitVote(id, voteCommit(!!votes[i], salts[i], committee[i], id));
  }
  await time.increase(MP.voteCommitWindow + 1);
  for (let i = 0; i < committee.length; i++) {
    if (votes[i] === undefined || votes[i] === null) continue;
    await f.market.connect(await ethers.getSigner(committee[i])).revealVote(id, votes[i], salts[i]);
  }
}
const bond = async (f, a) => (await f.market.verifiers(a)).bond;

describe("V2-fixes", function () {
  describe("FIX-1 : délai de reveal, slash du non-révélateur, re-tirage sans lui", function () {
    it("non-révélateur slashé, exclu, remplacé ; le nouveau comité tranche", async function () {
      const f = await loadFixture(fixture);
      const id = await completedJob(f);
      const c = await select(f, id, f.challenger);
      // a vote valide, b invalide, c commit mais ne révèle pas -> pas de majorité
      await vote(f, id, c, [true, false, null]);
      await expect(f.market.rerollNonRevealers(id)).to.be.revertedWithCustomError(f.market, "TooEarly");
      await time.increase(MP.voteRevealWindow + 1);
      await expect(f.market.rerollNonRevealers(id))
        .to.emit(f.market, "VerifierPenalized").withArgs(id, c[2], S(100))
        .and.to.emit(f.market, "CommitteeRerolled");
      expect(await bond(f, c[2])).to.equal(S(900));
      expect(await f.market.memberVote(id, c[2])).to.equal(5);
      expect((await f.market.verifiers(c[2])).duties).to.equal(0);
      const c2 = await f.market.committeeOf(id);
      expect(c2.length).to.equal(3);
      expect(c2).to.not.include(c[2]);
      const newcomer = c2.find((a) => a !== c[0] && a !== c[1]);
      expect(newcomer).to.not.equal(undefined);
      // a et b ont déjà voté (votes conservés) ; seul le nouveau vote
      const salt = ethers.id("n");
      await f.market.connect(await ethers.getSigner(newcomer)).commitVote(id, voteCommit(false, salt, newcomer, id));
      await time.increase(MP.voteCommitWindow + 1);
      await f.market.connect(await ethers.getSigner(newcomer)).revealVote(id, false, salt);
      await expect(f.market.resolveDispute(id)).to.be.revertedWithCustomError(f.market, "TooEarly"); // fenêtre d'appel
      await time.increase(MP.voteRevealWindow + 3600 + 1);
      await expect(f.market.resolveDispute(id)).to.emit(f.market, "DisputeResolved").withArgs(id, false, false);
    });

    it("re-tirage refusé si majorité, et limité à maxRerolls", async function () {
      const f = await loadFixture(fixture);
      const id = await completedJob(f);
      let c = await select(f, id, f.challenger);
      await vote(f, id, c, [true, true, undefined]);
      await time.increase(MP.voteRevealWindow + 1);
      await expect(f.market.rerollNonRevealers(id)).to.be.revertedWithCustomError(f.market, "HasMajority");

      const id2 = await completedJob(f);
      c = await select(f, id2, f.challenger);
      for (let r = 0; r < 2; r++) {
        await time.increase(VOTE_WINDOWS + 1);
        await f.market.rerollNonRevealers(id2);
      }
      await time.increase(VOTE_WINDOWS + 1);
      await expect(f.market.rerollNonRevealers(id2)).to.be.revertedWithCustomError(f.market, "InvalidState");
    });
  });

  describe("FIX-2a : caution vérificateur proportionnelle à la valeur du litige", function () {
    it("seuls les vérificateurs avec caution >= budget siègent ; top-up possible", async function () {
      const f = await loadFixture(fixture);
      expect(await f.market.requiredVerifierBond(S(5000))).to.equal(S(5000));
      expect(await f.market.requiredVerifierBond(S(10))).to.equal(S(1000)); // plancher minVerifierStake
      const [rich1, rich2] = f.vs;
      await f.market.connect(rich1).increaseVerifierBond(S(4000));
      await f.market.connect(rich2).increaseVerifierBond(S(4000));
      expect(await bond(f, rich1.address)).to.equal(S(5000));
      expect(await f.staking.lockedStake(rich1.address)).to.equal(S(5000));
      const id = await completedJob(f, 5000);
      const c = await select(f, id, f.challenger);
      expect([...c].sort()).to.deep.equal([rich1.address, rich2.address].sort());
      await expect(f.market.connect(f.outsider).increaseVerifierBond(S(1))).to.be.revertedWithCustomError(f.market, "InvalidState");
    });
  });

  describe("FIX-2b : appel avec caution plus élevée et comité de 5", function () {
    it("appel gagnant : verdict renversé, caution d'appel rendue, 1er comité pénalisé", async function () {
      const f = await loadFixture(fixture);
      const id = await completedJob(f, 1000);
      const c1 = await select(f, id, f.challenger);
      await vote(f, id, c1, [true, true, true]); // travail jugé valide
      await time.increase(MP.voteRevealWindow + 1);
      await expect(f.market.connect(f.provider).appeal(id, seedCommit(ethers.id("x")))).to.be.revertedWithCustomError(f.market, "NotAllowed");
      expect(await f.market.appealBondFor(id)).to.equal(S(200)); // 20 % de 1000 > 2 x 25
      const ch0 = await f.token.balanceOf(f.challenger.address);
      const c2 = await select(f, id, f.challenger, true);
      expect(c2.length).to.equal(5);
      for (const a of c2) expect([...c1]).to.not.include(a);
      expect(await f.market.firstCommitteeOf(id)).to.deep.equal(c1);
      await vote(f, id, c2, [false, false, false, true, false]);
      const cr0 = await f.token.balanceOf(f.creator.address);
      await expect(f.market.resolveDispute(id)).to.emit(f.market, "AppealSettled").withArgs(id, true, S(200));
      expect((await f.market.jobs(id)).status).to.equal(Status.Refunded);
      expect(await f.token.balanceOf(f.creator.address)).to.equal(cr0 + S(1000));
      // caution d'appel rendue + caution de contestation rendue + 10 % du slash fournisseur
      expect(await f.token.balanceOf(f.challenger.address)).to.equal(ch0 + S(25) + S(100));
      for (const a of c1) expect(await bond(f, a)).to.equal(S(900));
      expect(await bond(f, c2[3])).to.equal(S(900));
      for (const a of [...c1, ...c2]) expect((await f.market.verifiers(a)).duties).to.equal(0);
    });

    it("appel perdant : caution d'appel distribuée aux vérificateurs gagnants", async function () {
      const f = await loadFixture(fixture);
      const id = await completedJob(f, 1000);
      const c1 = await select(f, id, f.challenger);
      await vote(f, id, c1, [false, false, true]); // travail invalide -> le fournisseur perd
      await time.increase(MP.voteRevealWindow + 1);
      await expect(f.market.connect(f.challenger).appeal(id, seedCommit(ethers.id("x")))).to.be.revertedWithCustomError(f.market, "NotAllowed");
      const c2 = await select(f, id, f.provider, true);
      await vote(f, id, c2, [false, false, false, false, true]);
      const before = await Promise.all([c1[0], c2[0]].map((a) => f.token.balanceOf(a)));
      await expect(f.market.resolveDispute(id)).to.emit(f.market, "AppealSettled").withArgs(id, false, S(200));
      // 6 gagnants : pool = 200 (appel) + 20 % de 1000 (slash) = 400 -> 66,66.. chacun
      const share = (S(200) + S(200)) / 6n;
      expect(await f.token.balanceOf(c1[0])).to.equal(before[0] + share);
      expect(await f.token.balanceOf(c2[0])).to.equal(before[1] + share);
      expect(await bond(f, c1[2])).to.equal(S(900));
      expect(await bond(f, c2[4])).to.equal(S(900));
    });

    it("appel sans majorité : verdict initial maintenu ; seed d'appel non révélé : appel perdu", async function () {
      const f = await loadFixture(fixture);
      const id = await completedJob(f, 1000);
      const c1 = await select(f, id, f.challenger);
      await vote(f, id, c1, [true, true, false]);
      await time.increase(MP.voteRevealWindow + 1);
      const c2 = await select(f, id, f.creator, true);
      await vote(f, id, c2, [false, false, true, undefined, undefined]);
      await expect(f.market.resolveDispute(id)).to.be.revertedWithCustomError(f.market, "TooEarly");
      await time.increase(MP.voteRevealWindow + 1);
      await expect(f.market.resolveDispute(id)).to.emit(f.market, "DisputeResolved").withArgs(id, true, false);
      expect((await f.market.jobs(id)).status).to.equal(Status.Finalized);

      const id2 = await completedJob(f, 1000);
      const d1 = await select(f, id2, f.challenger);
      await vote(f, id2, d1, [true, true, true]);
      await time.increase(MP.voteRevealWindow + 1);
      await f.market.connect(f.challenger).appeal(id2, seedCommit(ethers.id("never")));
      await time.increase(MP.seedRevealWindow + 1);
      await expect(f.market.expireUnrevealedChallenge(id2)).to.emit(f.market, "AppealSettled").withArgs(id2, false, S(200));
      expect((await f.market.jobs(id2)).status).to.equal(Status.Finalized);
    });

    it("pas d'appel après la fenêtre ; résolution seulement après la fenêtre", async function () {
      const f = await loadFixture(fixture);
      const id = await completedJob(f, 1000);
      const c1 = await select(f, id, f.challenger);
      await vote(f, id, c1, [true, true, true]);
      await expect(f.market.connect(f.challenger).appeal(id, seedCommit(ethers.id("x")))).to.be.revertedWithCustomError(f.market, "TooEarly");
      await time.increase(MP.voteRevealWindow + 3600 + 1);
      await expect(f.market.connect(f.challenger).appeal(id, seedCommit(ethers.id("x")))).to.be.revertedWithCustomError(f.market, "TooLate");
      await f.market.resolveDispute(id);
    });
  });

  describe("FIX-3 : désengagement 14 j, gel des cautions, pause gardien des litiges suspects", function () {
    it("unbonding = 14 jours", async function () {
      const f = await loadFixture(fixture);
      expect(await f.staking.UNBONDING_PERIOD()).to.equal(14 * DAY);
    });

    it("caution vérificateur gelée pendant le litige puis 3 jours après", async function () {
      const f = await loadFixture(fixture);
      const id = await completedJob(f, 100);
      const c = await select(f, id, f.challenger);
      const a = await ethers.getSigner(c[0]);
      await f.market.connect(a).exitVerifier(); // retiré de la liste, caution reste verrouillée
      expect(await f.staking.lockedStake(c[0])).to.equal(S(1000));
      await vote(f, id, c, [true, true, true]);
      await time.increase(MP.voteRevealWindow + 3600 + 1);
      await f.market.resolveDispute(id);
      await expect(f.market.connect(a).exitVerifier()).to.be.revertedWithCustomError(f.market, "Cooldown");
      await expect(f.staking.connect(a).requestUnstake(S(8000))).to.be.revertedWithCustomError(f.staking, "InsufficientUnlocked");
      await time.increase(3 * DAY);
      await f.market.connect(a).exitVerifier();
      expect(await f.staking.lockedStake(c[0])).to.equal(0);
    });

    it("gardien gèle un litige suspect ; l'arbitre Timelock tranche ; gel unique et borné", async function () {
      const f = await loadFixture(fixture);
      const id = await completedJob(f, 1000);
      const c = await select(f, id, f.challenger);
      await vote(f, id, c, [true, true, false]);
      await expect(f.market.connect(f.outsider).freezeDispute(id)).to.be.revertedWithCustomError(f.market, "AccessControlUnauthorizedAccount");
      await expect(f.market.connect(f.admin).freezeDispute(id)).to.emit(f.market, "DisputeFrozen");
      await time.increase(MP.voteRevealWindow + 3600 + 1);
      await expect(f.market.resolveDispute(id)).to.be.revertedWithCustomError(f.market, "Frozen");
      await expect(f.market.connect(f.challenger).appeal(id, seedCommit(ethers.id("x")))).to.be.revertedWithCustomError(f.market, "Frozen");
      // l'arbitre renverse le verdict suspect : les 2 votants "valide" sont pénalisés
      await expect(f.market.connect(f.tl).arbitrate(id, false)).to.emit(f.market, "DisputeResolved").withArgs(id, false, true);
      expect(await bond(f, c[0])).to.equal(S(900));
      expect(await bond(f, c[2])).to.equal(S(1000));

      const id2 = await completedJob(f, 1000);
      const d = await select(f, id2, f.challenger);
      await vote(f, id2, d, [true, true, true]);
      await f.market.connect(f.admin).freezeDispute(id2);
      await f.market.connect(f.admin).unfreezeDispute(id2);
      await expect(f.market.connect(f.admin).freezeDispute(id2)).to.be.revertedWithCustomError(f.market, "InvalidState");
      await time.increase(MP.voteRevealWindow + 3600 + 1);
      await f.market.resolveDispute(id2);

      const id3 = await completedJob(f, 1000);
      const e = await select(f, id3, f.challenger);
      await vote(f, id3, e, [true, true, true]);
      await f.market.connect(f.admin).freezeDispute(id3);
      await time.increase(7 * DAY + 1); // gel expiré automatiquement
      await f.market.resolveDispute(id3);
    });
  });

  describe("Gouvernance des paramètres de sécurité", function () {
    it("seul le Timelock modifie ; bornes vérifiées", async function () {
      const f = await loadFixture(fixture);
      const sp = { stakeToValueBps: 20000, maxRerolls: 1, verifierCooldown: DAY, appealWindow: 7200, appealCommitteeSize: 7, appealBondBps: 3000 };
      await expect(f.market.connect(f.admin).setSecurityParams(sp)).to.be.revertedWithCustomError(f.market, "AccessControlUnauthorizedAccount");
      await f.market.connect(f.tl).setSecurityParams(sp);
      expect((await f.market.securityParams()).appealCommitteeSize).to.equal(7);
      await expect(f.market.connect(f.tl).setSecurityParams({ ...sp, appealCommitteeSize: 4 })).to.be.revertedWithCustomError(f.market, "InvalidParams");
      await expect(f.market.connect(f.tl).setSecurityParams({ ...sp, maxRerolls: 4 })).to.be.revertedWithCustomError(f.market, "InvalidParams");
      await expect(f.market.connect(f.tl).setSecurityParams({ ...sp, appealWindow: 8 * DAY })).to.be.revertedWithCustomError(f.market, "InvalidParams");
    });
  });
});
