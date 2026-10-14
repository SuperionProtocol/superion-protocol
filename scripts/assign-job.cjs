const hre = require("hardhat");

async function main() {
  const jobs = await hre.ethers.getContractAt(
    "JobMarketplace",
    "0x079a7B21C71C448A96E425e598e1C3fEb824d49d"
  );
  const [me] = await hre.ethers.getSigners();
  console.log("Wallet :", me.address);

  const tx = await jobs.assignJob(1);
  const receipt = await tx.wait();
  console.log("AssignJob tx :", receipt.hash);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
