// VRF-01 : tirage du comité et re-tirage par Chainlink VRF v2.5 (mock officiel VRFCoordinatorV2_5Mock).
const { expect } = require("chai");
const { ethers } = require("hardhat");
const { loadFixture, time, impersonateAccount, setBalance } = require("@nomicfoundation/hardhat-network-helpers");
const { deployCore, VRF_DEFAULTS } = require("../scripts/v2/lib.cjs");
const { S, MARKETPLACE_PARAMS_TESTNET: MP, GOV_TESTNET: GOV } = require("../scripts/v2/config.cjs");

const enc = ethers.AbiCoder.defaultAbiCoder();
const voteCommit = (v, salt, voter, id) => ethers.keccak256(enc.encode(["bool", "bytes32", "address", "uint256"], [v, salt, voter, id]));
const VOTE_WINDOWS = MP.voteCommitWindow + MP.voteRevealWindow;

async function fixture() {
  const signers = await ethers.getSigners();
  const [admin, creator, provider, challenger, outsider] = signers;
  const vs = signers.slice(5, 15);
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
  return { admin, creator, provider, challenger, outsider, vs, token, staking, market, tl, mAddr, vrf: core.vrf.mock, subId: core.vrf.subId };
}
async function completedJob(f, budget = 1000) {
  const id = await f.market.nextJobId();
  await f.market.connect(f.creator).createJob(S(budget), 3600, "ipfs://job");
  await f.market.connect(f.provider).assignJob(id);
  await f.market.connect(f.provider).submitResult(id, "ipfs://result");
  return id;
}
const reqOf = async (f, id) => (await f.market.pendingDraw(id)).requestId;

describe("VRF-01 : Chainlink VRF v2.5", function () {
  it("tirage asynchrone : rien avant le callback, comité tiré dans fulfillRandomWords", async function () {
    const f = await loadFixture(fixture);
    const id = await completedJob(f);
    await expect(f.market.connect(f.challenger).challengeJob(id)).to.emit(f.market, "JobChallenged").and.to.emit(f.vrf, "RandomWordsRequested");
    const req = await reqOf(f, id);
    expect(req).to.not.equal(0n);
    expect(await f.market.vrfRequestJob(req)).to.equal(id);
    expect((await f.market.committeeOf(id)).length).to.equal(0);
    expect((await f.market.disputes(id)).committeeSelected).to.equal(false);
    await expect(f.vrf.fulfillRandomWordsWithOverride(req, f.mAddr, [777n]))
      .to.emit(f.market, "DrawFulfilled").withArgs(id, req, 777n)
      .and.to.emit(f.market, "CommitteeSelected")
      .and.to.emit(f.vrf, "RandomWordsFulfilled").withArgs(req, req, f.subId, (p) => p > 0n, true, true, false);
    expect((await f.market.committeeOf(id)).length).to.equal(3);
    expect((await f.market.disputeExt(id)).random).to.equal(ethers.toBeHex(777n, 32));
    expect(await reqOf(f, id)).to.equal(0n);
  });

  it("la même requête ne peut pas être servie deux fois (pas de re-choix d'un aléa)", async function () {
    const f = await loadFixture(fixture);
    const id = await completedJob(f);
    await f.market.connect(f.challenger).challengeJob(id);
    const req = await reqOf(f, id);
    // le coordinateur lui-même rejoue la réponse avec un autre mot : ignorée
    const coord = await f.vrf.getAddress();
    await impersonateAccount(coord);
    await setBalance(coord, ethers.parseEther("1"));
    const cs = await ethers.getSigner(coord);
    await f.market.connect(cs).rawFulfillRandomWords(req, [1n]);
    const c1 = await f.market.committeeOf(id);
    await f.market.connect(cs).rawFulfillRandomWords(req, [2n]);
    expect(await f.market.committeeOf(id)).to.deep.equal(c1);
    expect((await f.market.disputeExt(id)).random).to.equal(ethers.toBeHex(1n, 32));
    // requête inconnue : ignorée sans revert
    await f.market.connect(cs).rawFulfillRandomWords(999999n, [3n]);
  });

  it("re-tirage par VRF : nouvelle requête, non-révélateur perd TOUTE sa caution et est exclu", async function () {
    const f = await loadFixture(fixture);
    const id = await completedJob(f);
    await f.market.connect(f.challenger).challengeJob(id);
    const req1 = await reqOf(f, id);
    await f.vrf.fulfillRandomWords(req1, f.mAddr);
    const c = await f.market.committeeOf(id);
    const salts = c.map((_, i) => ethers.id("s" + i));
    for (let i = 0; i < 3; i++) await f.market.connect(await ethers.getSigner(c[i])).commitVote(id, voteCommit(i === 0, salts[i], c[i], id));
    await time.increase(MP.voteCommitWindow + 1);
    await f.market.connect(await ethers.getSigner(c[0])).revealVote(id, true, salts[0]);
    await f.market.connect(await ethers.getSigner(c[1])).revealVote(id, false, salts[1]);
    await time.increase(MP.voteRevealWindow + 1);
    const stake0 = await f.staking.balanceOf(c[2]);
    const supply0 = await f.token.totalSupply();
    await expect(f.market.rerollNonRevealers(id))
      .to.emit(f.market, "VerifierPenalized").withArgs(id, c[2], S(1000))
      .and.to.emit(f.market, "CommitteeRerolled");
    expect(await f.staking.balanceOf(c[2])).to.equal(stake0 - S(1000));
    expect(await f.token.totalSupply()).to.equal(supply0 - S(1000));
    expect((await f.market.verifiers(c[2])).bond).to.equal(0);
    expect(await f.market.memberVote(id, c[2])).to.equal(5);
    const req2 = await reqOf(f, id);
    expect(req2).to.not.equal(req1);
    await f.vrf.fulfillRandomWords(req2, f.mAddr);
    const c2 = await f.market.committeeOf(id);
    expect(c2.length).to.equal(3);
    expect(c2).to.not.include(c[2]);
    // l'exclu ne peut pas revenir : il n'est plus vérificateur et memberVote = 5
    expect((await f.market.verifiers(c[2])).indexPlus1).to.equal(0);
  });

  it("requête bloquée : relance après requestTimeout, réponse périmée ignorée, résolution neutre possible", async function () {
    const f = await loadFixture(fixture);
    const id = await completedJob(f);
    await expect(f.market.retryDraw(id)).to.be.revertedWithCustomError(f.market, "InvalidState");
    await f.market.connect(f.challenger).challengeJob(id);
    const req1 = await reqOf(f, id);
    await expect(f.market.connect(f.outsider).retryDraw(id)).to.be.revertedWithCustomError(f.market, "TooEarly");
    await time.increase(VRF_DEFAULTS.requestTimeout + 1);
    await expect(f.market.connect(f.outsider).retryDraw(id)).to.emit(f.market, "DrawRequested");
    const req2 = await reqOf(f, id);
    expect(req2).to.not.equal(req1);
    await f.vrf.fulfillRandomWordsWithOverride(req1, f.mAddr, [5n]);
    expect((await f.market.committeeOf(id)).length).to.equal(0);
    await f.vrf.fulfillRandomWordsWithOverride(req2, f.mAddr, [6n]);
    expect((await f.market.disputeExt(id)).random).to.equal(ethers.toBeHex(6n, 32));
    await expect(f.market.retryDraw(id)).to.be.revertedWithCustomError(f.market, "InvalidState");

    // coordinateur totalement muet : issue neutre (resolveStale) après timeout + arbitrationWindow
    const id2 = await completedJob(f, 100);
    await f.market.connect(f.challenger).challengeJob(id2);
    await time.increase(VRF_DEFAULTS.requestTimeout + 1);
    await expect(f.market.resolveStale(id2)).to.be.revertedWithCustomError(f.market, "TooEarly");
    await time.increase(MP.arbitrationWindow);
    const cr0 = await f.token.balanceOf(f.creator.address);
    await f.market.resolveStale(id2);
    expect(await f.token.balanceOf(f.creator.address)).to.equal(cr0 + S(100));
  });

  it("contrôle d'accès : config VRF par le Timelock seulement ; coordinateur par owner = Timelock", async function () {
    const f = await loadFixture(fixture);
    const c = { ...VRF_DEFAULTS, keyHash: ethers.id("k2"), subId: f.subId, callbackGasLimit: 2_000_000 };
    await expect(f.market.connect(f.admin).setVrfConfig(c)).to.be.revertedWithCustomError(f.market, "AccessControlUnauthorizedAccount");
    await expect(f.market.connect(f.tl).setVrfConfig({ ...c, keyHash: ethers.ZeroHash })).to.be.revertedWithCustomError(f.market, "InvalidParams");
    await expect(f.market.connect(f.tl).setVrfConfig({ ...c, subId: 0 })).to.be.revertedWithCustomError(f.market, "InvalidParams");
    await expect(f.market.connect(f.tl).setVrfConfig({ ...c, callbackGasLimit: 3_000_000 })).to.be.revertedWithCustomError(f.market, "InvalidParams");
    await expect(f.market.connect(f.tl).setVrfConfig({ ...c, requestTimeout: 10 })).to.be.revertedWithCustomError(f.market, "InvalidParams");
    await expect(f.market.connect(f.tl).setVrfConfig(c)).to.emit(f.market, "VrfConfigUpdated");
    expect((await f.market.vrfConfig()).keyHash).to.equal(ethers.id("k2"));

    // propriété VRF : transférée au Timelock (2 étapes) — le déployeur ne garde rien après acceptation
    expect(await f.market.owner()).to.equal(f.admin.address);
    await expect(f.market.connect(f.outsider).acceptOwnership()).to.be.reverted;
    await f.market.connect(f.tl).acceptOwnership();
    expect(await f.market.owner()).to.equal(f.tl.address);
    await expect(f.market.connect(f.admin).setCoordinator(f.outsider.address)).to.be.revertedWithCustomError(f.market, "OnlyOwnerOrCoordinator");
    await expect(f.market.connect(f.admin).transferOwnership(f.admin.address)).to.be.reverted;
    await expect(f.market.connect(f.tl).setCoordinator(f.outsider.address)).to.emit(f.market, "CoordinatorSet");
    // seul le nouveau coordinateur peut désormais livrer
    const id = await completedJob(f);
    await f.market.connect(f.tl).setCoordinator(await f.vrf.getAddress());
    await f.market.connect(f.challenger).challengeJob(id);
    await expect(f.market.connect(f.outsider).rawFulfillRandomWords(await reqOf(f, id), [1n])).to.be.revertedWithCustomError(f.market, "OnlyCoordinatorCanFulfill");
  });

  it("absent sans re-tirage (résolution finale) : caution entière saisie aussi", async function () {
    const f = await loadFixture(fixture);
    const id = await completedJob(f);
    await f.market.connect(f.challenger).challengeJob(id);
    await f.vrf.fulfillRandomWords(await reqOf(f, id), f.mAddr);
    const c = await f.market.committeeOf(id);
    const salts = c.map((_, i) => ethers.id("t" + i));
    for (let i = 0; i < 2; i++) await f.market.connect(await ethers.getSigner(c[i])).commitVote(id, voteCommit(true, salts[i], c[i], id));
    await time.increase(MP.voteCommitWindow + 1);
    for (let i = 0; i < 2; i++) await f.market.connect(await ethers.getSigner(c[i])).revealVote(id, true, salts[i]);
    await time.increase(MP.voteRevealWindow + 3600 + 1);
    await expect(f.market.resolveDispute(id)).to.emit(f.market, "VerifierPenalized").withArgs(id, c[2], S(1000));
    expect((await f.market.verifiers(c[2])).bond).to.equal(0);
  });
});
