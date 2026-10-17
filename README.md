# Superion Protocol

**A verified-work marketplace on Base.** Clients post jobs and lock payment in escrow; providers stake to take work; and when a result is challenged, a committee of three randomly selected, staked verifiers votes on it through a commit–reveal scheme. Dishonest parties get slashed.

> **Status: early stage.** Superion V2.1 is live on Base mainnet, but the protocol is young, usage is small, and **the contracts have not been audited yet**. Use at your own risk.

---

## What Superion does

Most marketplaces trust whoever delivers the work. Superion makes delivery **verifiable and economically accountable**:

- **Escrow**: the client's payment (in `SUPER`) sits in the marketplace contract until the job settles.
- **Stake**: providers stake when they accept a job (`providerStakeBps`), and verifiers need a minimum stake to be eligible. Everyone involved has something to lose.
- **Challenge & dispute**: after a result is submitted, a challenge window opens. Anyone who posts a challenge bond can dispute the result.
- **Random verifier committee**: a disputed job goes to **3 verifiers** picked pseudo-randomly from the staked set, using a seed that is committed and then revealed.
- **Commit–reveal voting**: verifiers commit a hidden vote first and reveal it afterwards, so nobody can copy anyone else's vote.
- **Slashing**: the losing side gets slashed (provider, challenger, or verifiers who were absent or in the minority), and part of each slash is burned.

### The AI-agent angle

Superion is built for a world where **autonomous AI agents** both hire and do work. An agent can post a task, another agent (or a human) can take it, and the outcome is enforced by stake and independent verification instead of trust in either party. That gives agents a neutral, on-chain way to settle "was this work actually done correctly?" disputes without a central operator.

---

## Architecture

| Contract | Role |
|---|---|
| `SuperionJobMarketplaceV2` | Job lifecycle: create → accept → submit → challenge → committee selection → commit/reveal votes → settle and slash. Holds escrow. |
| `SuperionStakingV2` | `SUPER` staking for providers and verifiers, voting power (ERC20Votes-style checkpoints), and slashing hooks that only the marketplace (`OPERATOR`) can call. |
| `SuperionGovernor` | OpenZeppelin Governor: proposals and voting on protocol parameters. |
| `SuperionTimelock` | Timelock controller (48 h delay on mainnet). It is the **admin** of the system, and all parameter changes go through it. |
| `SuperionToken` (`SUPER`) | ERC-20 token used for escrow, staking, and governance. |
| `SuperionVesting`, `SuperionMerkleAirdrop`, `SuperFaucet` | Auxiliary contracts (vesting, distribution, testnet faucet). |

V1 contracts (`JobMarketplace.sol`, `Staking.sol`) stay in the repo for reference only.

Flow: `Governor → Timelock → (Marketplace, Staking)`. The emergency guardian (a Safe) holds only pause/cancel powers.

---

## Deployments: Base mainnet (V2.1, chainId 8453)

| Contract | Address |
|---|---|
| Marketplace | [`0x5F0297A5B5F5444920e6673f1b60D5d1f1b302C1`](https://basescan.org/address/0x5F0297A5B5F5444920e6673f1b60D5d1f1b302C1) |
| Staking | [`0x92D9287B2aE16630d1b3b0fca26Aa0f09c957528`](https://basescan.org/address/0x92D9287B2aE16630d1b3b0fca26Aa0f09c957528) |
| Governor | [`0x22A2e573904730B1EC37B971052EF6Da7B3A0f80`](https://basescan.org/address/0x22A2e573904730B1EC37B971052EF6Da7B3A0f80) |
| Timelock | [`0x1E2deB77C9A50F064b97f8C90Facc91c4D081151`](https://basescan.org/address/0x1E2deB77C9A50F064b97f8C90Facc91c4D081151) |
| Token (SUPER) | [`0x212EE291056C673283BF441d861CA8EF696cC422`](https://basescan.org/address/0x212EE291056C673283BF441d861CA8EF696cC422) |

Full deployment records (constructor arguments, parameters, and deployment tx hashes) are in [`deployments/v2.1.base.mainnet.json`](deployments/v2.1.base.mainnet.json). The Base Sepolia testnet deployment is in [`deployments/v2.1.baseSepolia.json`](deployments/v2.1.baseSepolia.json). Constructor arguments for source verification are in `deployments/verify-args-v2.1-mainnet/` and `deployments/verify-args-v2.1/` (Sepolia).

---

## Security model

- **Admin = Timelock.** The deployer renounced its admin roles after setup. Any change to roles or parameters needs a Governor proposal that passes and then waits out the timelock delay.
- **Emergency roles = 2-of-3 Safe.** A 2-of-3 multisig ([`0xB633…87D4`](https://basescan.org/address/0xB633ae886bbb0939E0cB7130be0D367CED9f87D4)) holds `PAUSER` on the marketplace and `CANCELLER` on the timelock. It can pause the protocol or cancel a malicious queued proposal. It cannot move user funds or change parameters.
- **Protocol fee** is set to 0 at launch. Only governance can change it.
- **No audit yet.** The code has internal tests and has run on testnet, but no independent security audit has been done. Please report vulnerabilities privately (see Links) and do not open public issues for them.

---

## Development

Requirements: Node.js 18+ and npm.

```bash
npm ci
npx hardhat compile
npx hardhat test
```

The tests run on the local Hardhat network and need no keys. To deploy or run scripts against a live network, copy `.env.example` to `.env` and fill it in locally. **Never commit `.env`.**

```bash
cp .env.example .env
# PRIVATE_KEY=, BASE_RPC=, BASE_SEPOLIA_RPC=, ETHERSCAN_API_KEY=, ...
```

Every secret is read from environment variables only (see `hardhat.config.cjs`).

---

## Links

- Website: https://superion-protocol.netlify.app
- Discord: https://discord.gg/nMgAwNQek2
- X: [@superionc0jii](https://x.com/superionc0jii)
- Telegram: https://t.me/superionprotocol

---

## Disclaimer

This repository is open-source software provided "as is". Nothing here is an offer to sell tokens, a statement about token value, or financial advice.

## License

[MIT](LICENSE)

## Security

- **Unaudited.** No independent security audit has been done yet.
- Security fixes (seed reveal window cap, no same-block re-challenge) and extra tests (45 passing) are in the source, **pending redeploy**. The contracts are immutable, so the **deployed Base mainnet contracts still run the old version** until a redeploy.
- Please report vulnerabilities privately to **superion.protocol@proton.me**. Do not open public issues for them.
