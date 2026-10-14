const { ethers } = require("ethers");
const fs = require("fs");
const path = require("path");

function loadKey() {
  const text = fs.readFileSync(path.join(__dirname, "..", ".env"), "utf8");
  for (const line of text.split("\n")) {
    if (!line.trim() || line.trim().startsWith("#") || !line.includes("=")) continue;
    const i = line.indexOf("=");
    const k = line.slice(0, i).trim();
    if (k !== "PRIVATE_KEY") continue;
    return line.slice(i + 1).trim().replace(/^['"]|['"]$/g, "");
  }
  throw new Error("no key");
}

const ADMIN = "0xE60322A5543C2bAD26115053B586d9679F4A939f";
const FACTORY = "0x4e1DCf7AD4e460CfD30791CCC4F9c8a4f820ec67";
const SINGLETON = "0x29fcB43b46531BcA003ddC8FCB67FFE91900C762";
const FALLBACK = "0xfd0732Dc9E303f09fCEf3a7388Ad10A83459Ec99";
const OUT = path.join(__dirname, "..", "mainnet.addresses.json");

const factoryAbi = [
  "function createProxyWithNonce(address singleton, bytes initializer, uint256 saltNonce) returns (address proxy)",
  "event ProxyCreation(address proxy, address singleton)",
];
const safeAbi = [
  "function setup(address[] owners, uint256 threshold, address to, bytes data, address fallbackHandler, address paymentToken, uint256 payment, address paymentReceiver)",
  "function getTransactionHash(address to, uint256 value, bytes data, uint8 operation, uint256 safeTxGas, uint256 baseGas, uint256 gasPrice, address gasToken, address refundReceiver, uint256 nonce) view returns (bytes32)",
  "function nonce() view returns (uint256)",
  "function execTransaction(address to, uint256 value, bytes data, uint8 operation, uint256 safeTxGas, uint256 baseGas, uint256 gasPrice, address gasToken, address refundReceiver, bytes signatures) returns (bool)",
  "function getOwners() view returns (address[])",
];

function artifact(name) {
  const p = path.join(__dirname, "..", "artifacts", "contracts", name + ".sol", name + ".json");
  return JSON.parse(fs.readFileSync(p, "utf8"));
}

function fee() {
  return {
    maxFeePerGas: ethers.parseUnits("0.05", "gwei"),
    maxPriorityFeePerGas: ethers.parseUnits("0.001", "gwei"),
  };
}

async function send(label, txPromise) {
  const tx = await txPromise;
  console.log(label + " submitted " + tx.hash);
  const rec = await tx.wait();
  if (rec.status !== 1) throw new Error(label + " reverted " + tx.hash);
  const paid = rec.gasUsed * rec.gasPrice;
  console.log(label + " ok " + rec.hash + " gas " + rec.gasUsed.toString() + " feeWei " + paid.toString());
  return rec;
}

async function main() {
  const key = loadKey();
  if (!(key.startsWith("0x") && key.length === 66)) throw new Error("bad key length");
  const rpc = new ethers.JsonRpcProvider("https://mainnet.base.org", 8453);
  const wallet = new ethers.Wallet(key, rpc);
  if (wallet.address.toLowerCase() !== ADMIN.toLowerCase()) throw new Error("signer " + wallet.address);
  for (const addr of [FACTORY, SINGLETON, FALLBACK]) {
    const code = await rpc.getCode(addr);
    if (code === "0x") throw new Error("no code at " + addr);
  }
  const bal = await rpc.getBalance(ADMIN);
  console.log("balance " + ethers.formatEther(bal));
  if (bal < ethers.parseEther("0.001")) throw new Error("balance below 0.001");

  const state = {
    network: "base",
    chainId: 8453,
    status: "in-progress",
    admin: null,
    safeOwner: ADMIN,
    token: null,
    staking: null,
    marketplace: null,
    txs: {},
  };
  const save = () => fs.writeFileSync(OUT, JSON.stringify(state, null, 2) + "\n");

  const safeAddr = "0xB633ae886bbb0939E0cB7130be0D367CED9f87D4";
  state.admin = safeAddr;
  state.txs.safe = "0xb10e83e7a26df0a26709781c58071d494463c88487d3f77e8caeb83e6511b4a3";
  save();
  console.log("safe " + safeAddr);

  async function deploy(label, file, args) {
    const art = artifact(file);
    const factoryC = new ethers.ContractFactory(art.abi, art.bytecode, wallet);
    const contract = await factoryC.deploy(...args, fee());
    const rec = await send(label, Promise.resolve(contract.deploymentTransaction()));
    const addr = await contract.getAddress();
    console.log(label + " address " + addr);
    return { addr, hash: rec.hash };
  }

  const token = await deploy("token", "SuperionToken", [safeAddr]);
  state.token = token.addr;
  state.txs.token = token.hash;
  save();

  const staking = await deploy("staking", "Staking", [token.addr, safeAddr]);
  state.staking = staking.addr;
  state.txs.staking = staking.hash;
  save();

  const market = await deploy("marketplace", "JobMarketplace", [token.addr, safeAddr, staking.addr]);
  state.marketplace = market.addr;
  state.txs.marketplace = market.hash;
  save();

  const safe = new ethers.Contract(safeAddr, safeAbi, wallet);
  const stakingC = new ethers.Contract(staking.addr, artifact("Staking").abi, wallet);
  const tokenC = new ethers.Contract(token.addr, artifact("SuperionToken").abi, wallet);
  const slasher = await stakingC.SLASHER_ROLE();
  const pauser = await tokenC.PAUSER_ROLE();

  async function safeExec(label, to, data) {
    const nonce = await safe.nonce();
    const hash = await safe.getTransactionHash(
      to, 0, data, 0, 0, 0, 0, ethers.ZeroAddress, ethers.ZeroAddress, nonce
    );
    const sig = wallet.signingKey.sign(hash);
    const packed = ethers.concat([sig.r, sig.s, new Uint8Array([sig.v])]);
    const rec = await send(
      label,
      safe.execTransaction(
        to, 0, data, 0, 0, 0, 0, ethers.ZeroAddress, ethers.ZeroAddress, packed, fee()
      )
    );
    return rec.hash;
  }

  const grantData = stakingC.interface.encodeFunctionData("grantRole", [slasher, market.addr]);
  state.txs.grantSlasher = await safeExec("grantSlasher", staking.addr, grantData);
  save();

  const renounceData = tokenC.interface.encodeFunctionData("renounceRole", [pauser, safeAddr]);
  state.txs.renouncePauser = await safeExec("renouncePauser", token.addr, renounceData);
  save();

  const hasPauser = await tokenC.hasRole(pauser, safeAddr);
  const hasSlasher = await stakingC.hasRole(slasher, market.addr);
  const hasAdmin = await tokenC.hasRole(await tokenC.DEFAULT_ADMIN_ROLE(), safeAddr);
  const hasMinter = await tokenC.hasRole(await tokenC.MINTER_ROLE(), safeAddr);
  const supply = await tokenC.totalSupply();
  state.status = "deployed";
  state.checks = {
    hasPauser,
    hasSlasher,
    hasAdmin,
    hasMinter,
    supply: ethers.formatUnits(supply, 18),
    paused: await tokenC.paused(),
  };
  save();
  console.log("FINAL " + JSON.stringify(state.checks));
  console.log("ethLeft " + ethers.formatEther(await rpc.getBalance(ADMIN)));
}

main().catch((e) => {
  console.error("FAILED " + (e.shortMessage || e.message || String(e)));
  process.exit(1);
});
