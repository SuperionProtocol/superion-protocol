const hre = require("hardhat");

async function main() {
  const tokenAddr = "0xf5a6F83CE27692A247C3B2d1b7e0a3C3234300b4";
  const jobsAddr = "0x079a7B21C71C448A96E425e598e1C3fEb824d49d";
  const budget = hre.ethers.parseEther("10");
  const duration = 24 * 60 * 60;
  const uri = "ipfs://superion-job-1";

  const token = await hre.ethers.getContractAt(
    ["function approve(address,uint256) returns (bool)"],
    tokenAddr
  );
  const jobs = await hre.ethers.getContractAt("JobMarketplace", jobsAddr);
  const [me] = await hre.ethers.getSigners();

  console.log("Wallet :", me.address);

  const tx1 = await token.approve(jobsAddr, budget);
  await tx1.wait();
  console.log("Approve OK");

  const tx2 = await jobs.createJob(budget, duration, uri);
  const receipt = await tx2.wait();
  console.log("CreateJob tx :", receipt.hash);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
