// Paramètres V2.1 — PROPOSITIONS (testnet = valeurs courtes pour pouvoir tester).
const { parseUnits } = require("ethers");
const S = (n) => parseUnits(String(n), 18);

const DAY = 24 * 3600;
const YEAR = 365 * DAY;

const MARKETPLACE_PARAMS_TESTNET = {
  feeBps: 250,
  burnShareBps: 5000,
  challengePeriod: 180,
  seedRevealDelay: 60,
  seedRevealWindow: 180,
  voteCommitWindow: 150,
  voteRevealWindow: 150,
  arbitrationWindow: 3600,
  committeeSize: 3,
  providerStakeBps: 10000,
  slashVerifierBps: 2000,
  slashChallengerBps: 1000,
  minVerifierStake: S(1000),
  verifierPenalty: S(100),
  challengeBond: S(25),
};

const MARKETPLACE_PARAMS_MAINNET_PROPOSAL = {
  ...MARKETPLACE_PARAMS_TESTNET,
  challengePeriod: DAY,
  seedRevealDelay: 3600,
  seedRevealWindow: 4 * 3600,
  voteCommitWindow: DAY,
  voteRevealWindow: DAY,
  arbitrationWindow: 7 * DAY,
  committeeSize: 5,
  minVerifierStake: S(10000),
  verifierPenalty: S(1000),
  challengeBond: S(250),
};

// Premier lancement mainnet (option B — proche des vidéos) :
// feeBps=0 (frais relevables plus tard par le Governor), challengePeriod=1 h,
// autres fenêtres / cautions / comité = Sepolia V2.1. Gouvernance = GOV_MAINNET_PROPOSAL.
const MARKETPLACE_PARAMS_MAINNET_LAUNCH = {
  ...MARKETPLACE_PARAMS_TESTNET,
  feeBps: 0,
  challengePeriod: 3600, // 1 heure (vidéos)
};

const GOV_TESTNET = {
  votingDelay: 60,
  votingPeriod: 600,
  proposalThreshold: S(1000),
  quorumPercent: 4,
  quorumAbsoluteMin: S(1000),
  timelockDelay: 300,
  rewardEligibilityDelay: 60,
};
const GOV_MAINNET_PROPOSAL = {
  votingDelay: DAY,
  votingPeriod: 5 * DAY,
  proposalThreshold: S(100000),
  quorumPercent: 4,
  quorumAbsoluteMin: S(100000),
  timelockDelay: 2 * DAY,
  rewardEligibilityDelay: 3600,
};

const TOTAL_SUPPLY = S(1_000_000_000);
const DISTRIBUTION = [
  { key: "ecosystem", label: "Écosystème & récompenses", pct: 37, beneficiary: "timelock", vesting: { duration: 4 * YEAR, cliff: 0 } },
  { key: "community", label: "Communauté & airdrops", pct: 17, beneficiary: "timelock", vesting: null, airdropDemo: S(10000) },
  { key: "team", label: "Équipe & conseillers", pct: 16, beneficiary: "team", vesting: { duration: 4 * YEAR, cliff: YEAR } },
  { key: "treasury", label: "Trésorerie stratégique (pas de presale)", pct: 17, beneficiary: "timelock", vesting: { duration: 3 * YEAR, cliff: YEAR / 2 } },
  { key: "foundation", label: "Fondation & liquidité", pct: 13, beneficiary: "foundation", vesting: null },
];

module.exports = {
  S, DAY, YEAR,
  MARKETPLACE_PARAMS_TESTNET, MARKETPLACE_PARAMS_MAINNET_PROPOSAL, MARKETPLACE_PARAMS_MAINNET_LAUNCH,
  GOV_TESTNET, GOV_MAINNET_PROPOSAL,
  TOTAL_SUPPLY, DISTRIBUTION,
};
