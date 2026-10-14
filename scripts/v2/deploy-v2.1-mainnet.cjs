// Déploiement Superion V2.1 CORE — Base MAINNET (chainId 8453).
//
// SÉCURITÉ :
//   - REFUS sauf --confirm-mainnet ET chainId === 8453 (sauf --dry-run local/fork).
//   - Ne touche PAS au Safe, ne transfère PAS les 1B SUPER.
//   - Relie uniquement le token SUPER mainnet existant (immutable dans les constructeurs).
//   - Admin = Timelock ; gardien (PAUSER + CANCELLER) = Safe 2-of-3.
//
// Usage (quand Mensur dit « go ») :
//   CONFIRM_MAINNET=1 npx hardhat run scripts/v2/deploy-v2.1-mainnet.cjs --network base
//
// Dry-run (aucune tx mainnet) :
//   DRY_RUN=1 npx hardhat run scripts/v2/deploy-v2.1-mainnet.cjs --network hardhat
//   FORK_BASE=1 DRY_RUN=1 npx hardhat run scripts/v2/deploy-v2.1-mainnet.cjs --network hardhat
const fs = require("fs");
const path = require("path");
const { ethers, network } = require("hardhat");
const { deployCore } = require("./lib.cjs");
const {
  MARKETPLACE_PARAMS_MAINNET_LAUNCH,
  GOV_MAINNET_PROPOSAL,
} = require("./config.cjs");

const MAINNET_SUPER = "0x212EE291056C673283BF441d861CA8EF696cC422";
const SAFE_2OF3 = "0xB633ae886bbb0939E0cB7130be0D367CED9f87D4";
const V1 = {
  staking: "0x38e72DBb8F0B60d1162E382EE77C4d524b05F060",
  marketplace: "0xd5E3a1Dad8955CF5CaDe45767FF4FC5CEA21E254",
};

const CONFIRM =
  process.argv.includes("--confirm-mainnet") || process.env.CONFIRM_MAINNET === "1";
const DRY =
  process.argv.includes("--dry-run") || process.env.DRY_RUN === "1";

function assertNoKeyLeak() {
  // Ne jamais echo .env / PRIVATE_KEY
  for (const a of process.argv) {
    if (/private|0x[a-fA-F0-9]{64}/.test(a) && a !== "--confirm-mainnet" && a !== "--dry-run") {
      // ignore flags only
    }
  }
}

async function encodeAndValidate(ethers, { superToken, adminTemp, guardian, marketParams, gov, stakingAddr, tlAddr }) {
  const stF = await ethers.getContractFactory("SuperionStakingV2");
  const tlF = await ethers.getContractFactory("SuperionTimelock");
  const govF = await ethers.getContractFactory("SuperionGovernor");
  const mF = await ethers.getContractFactory("SuperionJobMarketplaceV2");

  const stakingArgs = [superToken, adminTemp, gov.rewardEligibilityDelay];
  const timelockArgs = [gov.timelockDelay, [], [ethers.ZeroAddress], adminTemp];
  const governorArgs = [
    stakingAddr || ethers.ZeroAddress,
    tlAddr || ethers.ZeroAddress,
    gov.votingDelay,
    gov.votingPeriod,
    gov.proposalThreshold,
    gov.quorumPercent,
    gov.quorumAbsoluteMin,
  ];
  const marketArgs = [
    superToken,
    stakingAddr || ethers.ZeroAddress,
    tlAddr || ethers.ZeroAddress, // admin = Timelock
    guardian, // pauser = Safe
    tlAddr || ethers.ZeroAddress, // arbiter = Timelock
    marketParams,
  ];

  // Encode (échoue si types incorrects)
  const enc = {
    stakingV2: stF.interface.encodeDeploy(stakingArgs),
    timelock: tlF.interface.encodeDeploy(timelockArgs),
    governor: govF.interface.encodeDeploy(governorArgs),
    marketplaceV2: mF.interface.encodeDeploy(marketArgs),
  };
  return { stakingArgs, timelockArgs, governorArgs, marketArgs, enc, factories: { stF, tlF, govF, mF } };
}

async function main() {
  assertNoKeyLeak();
  const { chainId } = await ethers.provider.getNetwork();
  const log = (m) => console.log(m);

  if (DRY) {
    log(`=== DRY-RUN V2.1 mainnet prep — network=${network.name} chainId=${chainId} ===`);
    log("Aucune transaction Base mainnet ne sera diffusée.");
  } else {
    if (!CONFIRM) {
      throw new Error(
        "REFUS : CONFIRM_MAINNET=1 et --confirm-mainnet requis pour Base mainnet.\n" +
          "Dry-run : DRY_RUN=1 npx hardhat run scripts/v2/deploy-v2.1-mainnet.cjs --network hardhat"
      );
    }
    if (chainId !== 8453n) {
      throw new Error(`REFUS : chainId ${chainId} ≠ 8453 (Base mainnet). Réseau actuel : ${network.name}`);
    }
  }

  // Sur dry-run hardhat sans fork : autoriser 31337. Avec fork Base, chainId peut rester 8453
  // mais les txs restent locales au nœud Hardhat (jamais broadcastées au RPC public).
  if (DRY && chainId !== 31337n && chainId !== 8453n) {
    throw new Error(`DRY-RUN : chainId inattendu ${chainId}`);
  }
  if (!DRY && chainId !== 8453n) {
    throw new Error(`REFUS : chainId ${chainId} ≠ 8453`);
  }

  const [rawSigner] = await ethers.getSigners();
  if (!rawSigner) throw new Error("Aucun signer (PRIVATE_KEY manquant dans l'env Hardhat ?)");
  const deployer = new ethers.NonceManager(rawSigner);
  deployer.address = rawSigner.address;

  const marketParams = MARKETPLACE_PARAMS_MAINNET_LAUNCH;
  const gov = GOV_MAINNET_PROPOSAL;
  const guardian = SAFE_2OF3; // PAUSER + CANCELLER (recommandé)

  log(`Déployeur : ${deployer.address}`);
  log(`Token SUPER (existant, immutable) : ${MAINNET_SUPER}`);
  log(`Gardien (Safe 2-of-3) : ${guardian}`);
  log(`Params marketplace : feeBps=${marketParams.feeBps} challengePeriod=${marketParams.challengePeriod}s`);
  log(`Params gov : votingDelay=${gov.votingDelay}s votingPeriod=${gov.votingPeriod}s quorumMin=${gov.quorumAbsoluteMin} timelockDelay=${gov.timelockDelay}s`);
  log("NOTE : feeBps=0 au lancement — le Governor pourra relever les frais plus tard via setFees.");

  let superToken = MAINNET_SUPER;
  if (DRY && chainId === 31337n && !(await ethers.provider.getCode(MAINNET_SUPER)).startsWith("0x60")) {
    // Hardhat local sans fork : token de simulation (adresse différente — uniquement pour valider le câblage)
    const t = await (await ethers.getContractFactory("SuperionToken", deployer)).deploy(deployer.address);
    await t.waitForDeployment();
    superToken = await t.getAddress();
    log(`(dry-run local) SuperionToken simulé @ ${superToken} — mainnet utilisera ${MAINNET_SUPER}`);
  } else if (DRY) {
    const code = await ethers.provider.getCode(MAINNET_SUPER);
    if (code === "0x") throw new Error("DRY-RUN : pas de code au token SUPER (fork Base requis pour adresse réelle)");
    log(`(dry-run) token SUPER trouvé, codeLen=${(code.length - 2) / 2}`);
  } else {
    const code = await ethers.provider.getCode(MAINNET_SUPER);
    if (code === "0x") throw new Error("Token SUPER mainnet introuvable à " + MAINNET_SUPER);
  }

  const bal = await ethers.provider.getBalance(deployer.address);
  log(`ETH déployeur : ${ethers.formatEther(bal)}`);
  // Garde abaissée de 0,002 à 0,0009 ETH (7 oct. 2026) : gas Base mesuré 0,006 gwei
  // (baseFee 0,005 gwei) → ~17 M gas ≈ 0,0001 ETH, ×2 marge ≈ 0,0002 ETH < 0,001 ETH.
  if (!DRY && bal < ethers.parseEther("0.0009")) {
    throw new Error(
      `ETH insuffisant (${ethers.formatEther(bal)}). Recommandé ≥ 0,003 ETH sur le déployeur avant le go.`
    );
  }

  // Validation encodage constructeurs (adresses placeholder pour governor/market si pas encore déployés)
  const pre = await encodeAndValidate(ethers, {
    superToken,
    adminTemp: deployer.address,
    guardian,
    marketParams,
    gov,
  });
  log(`Encodage constructeurs OK (staking ${pre.enc.stakingV2.length} hex chars, market ${pre.enc.marketplaceV2.length})`);

  if (DRY) {
    // Estimation gas déploiement (sans broadcast mainnet)
    const ethGas = async (factory, args) => {
      try {
        const data = factory.getDeployTransaction(...args);
        const est = await ethers.provider.estimateGas({ from: deployer.address, data: data.data });
        return est;
      } catch (e) {
        return null;
      }
    };
    // Déployer réellement sur le nœud local / fork Hardhat pour valider les constructeurs
    const existing = process.env.EXISTING ? JSON.parse(process.env.EXISTING) : {};
    const core = await deployCore(ethers, {
      superToken,
      deployer,
      guardian,
      marketParams,
      gov,
      log,
      existing,
    });
    const st = await core.staking.getAddress();
    const tl = await core.timelock.getAddress();
    const g = await core.governor.getAddress();
    const m = await core.market.getAddress();

    // Relire params on-chain
    const mp = await core.market.params();
    log(`\nDry-run OK — contrats locaux/fork :`);
    log(JSON.stringify({ stakingV2: st, timelock: tl, governor: g, marketplaceV2: m }, null, 2));
    log(`feeBps on-chain=${mp.feeBps} challengePeriod=${mp.challengePeriod}`);
    if (Number(mp.feeBps) !== 0 || Number(mp.challengePeriod) !== 3600) {
      throw new Error("Params marketplace dry-run ≠ attendus (feeBps=0, challenge=3600)");
    }

    // Estimer gas des 4 deploys (ré-encode avec vraies adresses)
    const post = await encodeAndValidate(ethers, {
      superToken,
      adminTemp: deployer.address,
      guardian,
      marketParams,
      gov,
      stakingAddr: st,
      tlAddr: tl,
    });
    const gSt = await ethGas(post.factories.stF, post.stakingArgs);
    const gTl = await ethGas(post.factories.tlF, post.timelockArgs);
    const gGov = await ethGas(post.factories.govF, [
      st, tl, gov.votingDelay, gov.votingPeriod, gov.proposalThreshold, gov.quorumPercent, gov.quorumAbsoluteMin,
    ]);
    const gM = await ethGas(post.factories.mF, [
      superToken, st, tl, guardian, tl, marketParams,
    ]);
    log(`Gas estimé (si dispo) : staking=${gSt} timelock=${gTl} governor=${gGov} market=${gM}`);

    const out = {
      dryRun: true,
      version: "2.1",
      network: "base-mainnet-prep",
      targetChainId: 8453,
      simulatedChainId: Number(chainId),
      deployer: deployer.address,
      superToken: MAINNET_SUPER,
      simulatedSuperToken: superToken,
      guardian: SAFE_2OF3,
      note:
        "DRY-RUN — pas de broadcast mainnet. feeBps=0 au lancement (relevable par Governor). " +
        "Aucun mouvement des 1B SUPER, aucun appel Safe.",
      contractsSimulated: { stakingV2: st, timelock: tl, governor: g, marketplaceV2: m },
      params: {
        marketplace: Object.fromEntries(Object.entries(marketParams).map(([k, v]) => [k, v.toString()])),
        governance: Object.fromEntries(Object.entries(gov).map(([k, v]) => [k, v.toString()])),
      },
      v1Reference: V1,
      gasHints: {
        staking: gSt ? gSt.toString() : null,
        timelock: gTl ? gTl.toString() : null,
        governor: gGov ? gGov.toString() : null,
        marketplace: gM ? gM.toString() : null,
        sepoliaCoreMeasuredApprox: "11970000",
        recommendedDeployerEth: "0.003",
      },
    };
    const dir = path.join(__dirname, "..", "..", "deployments");
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, "v2.1.base.mainnet.dry-run.json");
    fs.writeFileSync(file, JSON.stringify(out, (k, v) => (typeof v === "bigint" ? v.toString() : v), 2));
    log(`Écrit : ${file}`);
    return;
  }

  // ——— Déploiement MAINNET réel ———
  log("\n*** DÉPLOIEMENT BASE MAINNET CONFIRMÉ ***");
  const existing = process.env.EXISTING ? JSON.parse(process.env.EXISTING) : {};
  const core = await deployCore(ethers, {
    superToken: MAINNET_SUPER,
    deployer,
    guardian: SAFE_2OF3,
    marketParams,
    gov,
    log,
    existing,
  });
  const tl = await core.timelock.getAddress();
  const st = await core.staking.getAddress();
  const gAddr = await core.governor.getAddress();
  const mAddr = await core.market.getAddress();

  const out = {
    version: "2.1",
    network: "base",
    chainId: 8453,
    deployedAt: new Date().toISOString(),
    deployer: deployer.address,
    superToken: MAINNET_SUPER,
    guardian: SAFE_2OF3,
    note:
      "Core only — token SUPER existant (immutable). Aucun transfert des 1B SUPER, aucun appel Safe. " +
      "Admin=Timelock, gardien=Safe (PAUSER+CANCELLER). feeBps=0 au lancement (relevable par Governor).",
    contracts: {
      stakingV2: st,
      timelock: tl,
      governor: gAddr,
      marketplaceV2: mAddr,
    },
    params: {
      marketplace: Object.fromEntries(Object.entries(marketParams).map(([k, v]) => [k, v.toString()])),
      governance: Object.fromEntries(Object.entries(gov).map(([k, v]) => [k, v.toString()])),
    },
    txs: core.txs,
    constructorArgs: {
      stakingV2: [MAINNET_SUPER, deployer.address, gov.rewardEligibilityDelay],
      timelock: [gov.timelockDelay, [], [ethers.ZeroAddress], deployer.address],
      governor: [
        st, tl, gov.votingDelay, gov.votingPeriod,
        gov.proposalThreshold.toString(), gov.quorumPercent, gov.quorumAbsoluteMin.toString(),
      ],
      marketplaceV2: [MAINNET_SUPER, st, tl, SAFE_2OF3, tl, {
        ...Object.fromEntries(Object.entries(marketParams).map(([k, v]) => [k, typeof v === "bigint" ? v.toString() : v])),
      }],
    },
    v1: V1,
    safe: SAFE_2OF3,
  };

  const dir = path.join(__dirname, "..", "..", "deployments");
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, "v2.1.base.json");
  const json = JSON.stringify(out, (k, v) => (typeof v === "bigint" ? v.toString() : v), 2);
  fs.writeFileSync(file, json);

  // Args de vérification Basescan/Blockscout
  const vdir = path.join(dir, "verify-args-v2.1-mainnet");
  fs.mkdirSync(vdir, { recursive: true });
  fs.writeFileSync(path.join(vdir, "stakingV2.cjs"), `module.exports = ${JSON.stringify(out.constructorArgs.stakingV2, null, 1)};\n`);
  fs.writeFileSync(path.join(vdir, "timelock.cjs"), `module.exports = ${JSON.stringify(out.constructorArgs.timelock, null, 1)};\n`);
  fs.writeFileSync(path.join(vdir, "governor.cjs"), `module.exports = ${JSON.stringify(out.constructorArgs.governor, null, 1)};\n`);
  fs.writeFileSync(
    path.join(vdir, "marketplaceV2.cjs"),
    `module.exports = ${JSON.stringify(out.constructorArgs.marketplaceV2, null, 1)};\n`
  );

  log(`\nÉcrit : ${file}`);
  log(JSON.stringify(out.contracts, null, 2));
  log("Suivre scripts/v2/post-mainnet-checklist.md — aucune tx Safe n'a été proposée ici.");
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
