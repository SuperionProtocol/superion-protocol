require("@nomicfoundation/hardhat-toolbox");
require("@nomicfoundation/hardhat-verify");
require("dotenv").config();

// Par défaut (contrats V2 + dépendances OZ 5.6) : optimiseur activé, EVM cancun (mcopy requis
// par OZ 5.6, supporté par Base). Les contrats V1 gardent exactement les réglages d'origine
// (solc 0.8.24, evm paris, sans optimiseur) avec lesquels ils ont été vérifiés sur Basescan.
const V1_SETTINGS = {
  version: "0.8.24",
  settings: { optimizer: { enabled: false, runs: 200 }, evmVersion: "paris" },
};
const V1_FILES = [
  "contracts/SuperionToken.sol",
  "contracts/Staking.sol",
  "contracts/JobMarketplace.sol",
];

module.exports = {
  solidity: {
    compilers: [
      { version: "0.8.24", settings: { optimizer: { enabled: true, runs: 200 }, evmVersion: "cancun", viaIR: true } },
    ],
    overrides: {
      ...Object.fromEntries(V1_FILES.map((f) => [f, V1_SETTINGS])),
      // VRF-01 : runs bas pour rester sous la limite EIP-170 (24 576 octets) avec VRFConsumerBaseV2Plus.
      "contracts/v2/SuperionJobMarketplaceV2.sol": {
        version: "0.8.24",
        settings: { optimizer: { enabled: true, runs: 1 }, evmVersion: "cancun", viaIR: true },
      },
    },
  },
  networks: {
    hardhat: {
      // Dry-run : FORK_BASE=1 npx hardhat run ... --network hardhat
      forking: process.env.FORK_BASE === "1"
        ? { url: process.env.BASE_RPC || "https://mainnet.base.org", enabled: true }
        : undefined,
    },
    baseSepolia: {
      url: process.env.BASE_SEPOLIA_RPC || "https://sepolia.base.org",
      chainId: 84532,
      // Points de contrôle ERC20Votes horodatés : l'estimation de gas peut être trop basse
      // si elle tombe dans la même seconde qu'un autre point de contrôle -> marge de 30 %.
      gasMultiplier: 1.3,
      accounts: process.env.PRIVATE_KEY ? [process.env.PRIVATE_KEY] : [],
    },
    // Base MAINNET — utilisé uniquement avec scripts/v2/deploy-v2.1-mainnet.cjs --confirm-mainnet
    base: {
      url: process.env.BASE_RPC || "https://mainnet.base.org",
      chainId: 8453,
      gasMultiplier: 1.3,
      accounts: process.env.PRIVATE_KEY ? [process.env.PRIVATE_KEY] : [],
    },
  },
  etherscan: {
    apiKey: process.env.ETHERSCAN_API_KEY,
  },
  sourcify: {
    enabled: false,
  },
};
