const hre = require("hardhat");

async function main() {
  const [admin] = await hre.ethers.getSigners();
  const token = "0xf5a6F83CE27692A247C3B2d1b7e0a3C3234300b4";
  const staking = "0xD10E6f73a676a1562d18ef93D86bd3D85786Fe50";

  console.log("Admin :", admin.address);

  const Factory = await hre.ethers.getContractFactory("JobMarketplace");
  const jobs = await Factory.deploy(token, admin.address, staking);
  await jobs.waitForDeployment();
  const jobsAddr = await jobs.getAddress();
  console.log("JobMarketplace :", jobsAddr);

  const stakingContract = await hre.ethers.getContractAt(
    ["function grantRole(bytes32,address)", "function SLASHER_ROLE() view returns (bytes32)"],
    staking
  );
  const role = await stakingContract.SLASHER_ROLE();
  const tx = await stakingContract.grantRole(role, jobsAddr);
  const receipt = await tx.wait();
  console.log("grantRole SLASHER tx :", receipt.hash);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
