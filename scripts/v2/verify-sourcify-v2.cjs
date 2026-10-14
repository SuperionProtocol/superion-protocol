// Soumission Sourcify via l'API v2 (sans clé). Usage :
//   node scripts/v2/verify-sourcify-v2.cjs <adresse> <fqn ex. contracts/faucet/SuperFaucet.sol:SuperFaucet> [creationTxHash]
const fs = require("fs");
const path = require("path");
const [address, fqn, creationTx] = process.argv.slice(2);
const CHAIN = Number(process.env.SOURCIFY_CHAIN || 84532); // 8453 pour Base mainnet
const API = "https://sourcify.dev/server";
(async () => {
  const [src, name] = fqn.split(":");
  const dbg = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "..", "artifacts", src, `${name}.dbg.json`), "utf8"));
  const bi = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "..", "artifacts", src, dbg.buildInfo), "utf8"));
  const body = { stdJsonInput: bi.input, compilerVersion: bi.solcLongVersion, contractIdentifier: fqn };
  if (creationTx) body.creationTransactionHash = creationTx;
  const r = await fetch(`${API}/v2/verify/${CHAIN}/${address}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const j = await r.json();
  console.log("POST", r.status, JSON.stringify(j));
  if (!j.verificationId) return;
  for (let i = 0; i < 30; i++) {
    await new Promise((res) => setTimeout(res, 4000));
    const s = await (await fetch(`${API}/v2/verify/${j.verificationId}`)).json();
    if (s.isJobCompleted) { console.log("JOB", JSON.stringify(s)); return; }
  }
  console.log("timeout");
})().catch((e) => { console.error(e.message); process.exit(1); });
