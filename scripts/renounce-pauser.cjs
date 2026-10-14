const hre = require("hardhat");

const TOKEN = "0xf5a6F83CE27692A247C3B2d1b7e0a3C3234300b4";
const EXPECTED_ADMIN = "0xE60322A5543C2bAD26115053B586d9679F4A939f";

async function main() {
  const [me] = await hre.ethers.getSigners();
  if (me.address.toLowerCase() !== EXPECTED_ADMIN.toLowerCase()) {
    throw new Error("Signer is not the expected admin: " + me.address);
  }
  const token = await hre.ethers.getContractAt(
    [
      "function PAUSER_ROLE() view returns (bytes32)",
      "function hasRole(bytes32,address) view returns (bool)",
      "function renounceRole(bytes32,address)",
      "function paused() view returns (bool)",
    ],
    TOKEN
  );
  const role = await token.PAUSER_ROLE();
  const before = await token.hasRole(role, me.address);
  const paused = await token.paused();
  console.log("paused", paused);
  console.log("hasPauserBefore", before);
  if (!before) {
    console.log("already renounced");
    return;
  }
  const gas = await token.renounceRole.estimateGas(role, me.address);
  console.log("gasEstimate", gas.toString());
  if (gas > 200_000n) {
    throw new Error("Gas estimate unusually high, not sending: " + gas.toString());
  }
  const tx = await token.renounceRole(role, me.address);
  const rec = await tx.wait();
  const after = await token.hasRole(role, me.address);
  console.log("tx", rec.hash);
  console.log("status", rec.status);
  console.log("gasUsed", rec.gasUsed.toString());
  console.log("hasPauserAfter", after);
}

main().catch((e) => {
  console.error(e.shortMessage || e.message || String(e));
  process.exit(1);
});
