const { expect } = require("chai");
const { ethers } = require("hardhat");
const { loadFixture, time } = require("@nomicfoundation/hardhat-network-helpers");

const S = (n) => ethers.parseEther(String(n));
const DAY = 24 * 3600;

async function fixture() {
  const [admin, alice, bob, outsider] = await ethers.getSigners();
  const token = await (await ethers.getContractFactory("SuperionToken")).deploy(admin.address);
  const faucet = await (await ethers.getContractFactory("SuperFaucet")).deploy(await token.getAddress(), admin.address, S(100), DAY);
  await token.approve(await faucet.getAddress(), S(1000));
  await faucet.refill(S(1000));
  return { admin, alice, bob, outsider, token, faucet };
}

describe("SuperFaucet", () => {
  it("drip : 100 SUPER, puis attente de 24 h", async () => {
    const { alice, token, faucet } = await loadFixture(fixture);
    expect(await faucet.nextDripAt(alice.address)).to.equal(0n);
    expect(await faucet.canDrip(alice.address)).to.equal(true);
    await expect(faucet.connect(alice).drip()).to.emit(faucet, "Dripped").withArgs(alice.address, S(100));
    expect(await token.balanceOf(alice.address)).to.equal(S(100));
    const next = await faucet.nextDripAt(alice.address);
    await expect(faucet.connect(alice).drip()).to.be.revertedWithCustomError(faucet, "CooldownActive").withArgs(next);
    expect(await faucet.canDrip(alice.address)).to.equal(false);
    await time.increaseTo(next - 2n);
    await expect(faucet.connect(alice).drip()).to.be.revertedWithCustomError(faucet, "CooldownActive");
    await time.increaseTo(next);
    await faucet.connect(alice).drip();
    expect(await token.balanceOf(alice.address)).to.equal(S(200));
    expect(await faucet.totalDripped()).to.equal(S(200));
  });

  it("chaque adresse a son propre compteur", async () => {
    const { alice, bob, faucet, token } = await loadFixture(fixture);
    await faucet.connect(alice).drip();
    await faucet.connect(bob).drip();
    expect(await token.balanceOf(bob.address)).to.equal(S(100));
    expect(await faucet.balance()).to.equal(S(800));
  });

  it("faucet vide : FaucetEmpty", async () => {
    const { admin, alice, faucet } = await loadFixture(fixture);
    await faucet.withdraw(admin.address, S(950));
    expect(await faucet.canDrip(alice.address)).to.equal(false);
    await expect(faucet.connect(alice).drip()).to.be.revertedWithCustomError(faucet, "FaucetEmpty");
  });

  it("propriétaire seul : withdraw / setParams ; refill ouvert à tous", async () => {
    const { admin, alice, outsider, faucet, token } = await loadFixture(fixture);
    await expect(faucet.connect(outsider).withdraw(outsider.address, 1)).to.be.revertedWithCustomError(faucet, "OwnableUnauthorizedAccount");
    await expect(faucet.connect(outsider).setParams(S(1), DAY)).to.be.revertedWithCustomError(faucet, "OwnableUnauthorizedAccount");
    await expect(faucet.withdraw(ethers.ZeroAddress, 1)).to.be.revertedWithCustomError(faucet, "InvalidParams");
    await expect(faucet.withdraw(alice.address, S(10))).to.emit(faucet, "Withdrawn").withArgs(alice.address, S(10));
    await faucet.connect(alice).drip();
    await token.connect(alice).approve(await faucet.getAddress(), S(50));
    await expect(faucet.connect(alice).refill(S(50))).to.emit(faucet, "Refilled").withArgs(alice.address, S(50));
    await expect(faucet.connect(alice).refill(0)).to.be.revertedWithCustomError(faucet, "InvalidParams");
    await expect(faucet.setParams(S(5), 3600)).to.emit(faucet, "ParamsUpdated").withArgs(S(5), 3600);
    expect(await faucet.dripAmount()).to.equal(S(5));
    await expect(faucet.setParams(0, DAY)).to.be.revertedWithCustomError(faucet, "InvalidParams");
    await expect(faucet.setParams(S(10001), DAY)).to.be.revertedWithCustomError(faucet, "InvalidParams");
    await expect(faucet.setParams(S(1), 60)).to.be.revertedWithCustomError(faucet, "InvalidParams");
    await expect(faucet.setParams(S(1), 31 * DAY)).to.be.revertedWithCustomError(faucet, "InvalidParams");
    await expect(faucet.transferOwnership(alice.address)).to.emit(faucet, "OwnershipTransferred");
  });

  it("constructeur : paramètres invalides refusés", async () => {
    const F = await ethers.getContractFactory("SuperFaucet");
    const [admin] = await ethers.getSigners();
    await expect(F.deploy(ethers.ZeroAddress, admin.address, S(100), DAY)).to.be.revertedWithCustomError(F, "InvalidParams");
    await expect(F.deploy(admin.address, admin.address, 0, DAY)).to.be.revertedWithCustomError(F, "InvalidParams");
  });
});
