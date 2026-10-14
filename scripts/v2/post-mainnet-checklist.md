# Checklist post-déploiement — Superion V2.1 Base mainnet

À suivre **après** l’exécution réussie de `deploy-v2.1-mainnet.cjs` (fichier `deployments/v2.1.base.json`).  
Le script de déploiement **ne propose aucune transaction Safe** et **ne déplace pas** les 1 000 000 000 SUPER.

Safe 2-sur-3 : [`0xB633ae886bbb0939E0cB7130be0D367CED9f87D4`](https://app.safe.global/home?safe=base:0xB633ae886bbb0939E0cB7130be0D367CED9f87D4)  
Token SUPER : `0x212EE291056C673283BF441d861CA8EF696cC422`  
V1 Staking : `0x38e72DBb8F0B60d1162E382EE77C4d524b05F060`  
V1 Marketplace : `0xd5E3a1Dad8955CF5CaDe45767FF4FC5CEA21E254`

---

## A. Immédiat (EOA déployeur, sans Safe)

### A1. Vérifier les sources (Basescan + Blockscout)

Remplacer `<ST>`, `<TL>`, `<GOV>`, `<MKT>` par les adresses de `v2.1.base.json`.

```bash
# Basescan (clé ETHERSCAN_API_KEY)
npx hardhat verify --network base \
  --constructor-args deployments/verify-args-v2.1-mainnet/stakingV2.cjs <ST>
npx hardhat verify --network base \
  --constructor-args deployments/verify-args-v2.1-mainnet/timelock.cjs <TL>
npx hardhat verify --network base \
  --constructor-args deployments/verify-args-v2.1-mainnet/governor.cjs <GOV>
npx hardhat verify --network base \
  --constructor-args deployments/verify-args-v2.1-mainnet/marketplaceV2.cjs <MKT>
```

Blockscout Base (si le plugin est configuré pour chainId 8453) :

```bash
npx hardhat --config hardhat.blockscout.config.cjs verify --network base \
  --constructor-args deployments/verify-args-v2.1-mainnet/stakingV2.cjs <ST>
# … idem Timelock, Governor, Marketplace
```

Contrôles manuels :
- [ ] `superToken()` / `token()` = `0x212E…C422` sur StakingV2 et MarketplaceV2
- [ ] `params.feeBps` = 0 ; `params.challengePeriod` = 3600
- [ ] Marketplace `DEFAULT_ADMIN_ROLE` + `ARBITER_ROLE` = Timelock
- [ ] Marketplace `PAUSER_ROLE` = Safe
- [ ] StakingV2 `DEFAULT_ADMIN_ROLE` = Timelock ; `OPERATOR_ROLE` = MarketplaceV2
- [ ] Timelock : `PROPOSER_ROLE` / `CANCELLER_ROLE` = Governor ; `CANCELLER_ROLE` aussi = Safe
- [ ] Déployeur **sans** `DEFAULT_ADMIN_ROLE` sur StakingV2 / Timelock

### A2. Rôles opérationnels post-deploy (si besoin, via Timelock / gouvernance)

Le câblage core (OPERATOR, PROPOSER, admins) est déjà fait par le script.  
Pas de `SLASHER_ROLE` V2 : le marketplace appelle `staking.slash` via `OPERATOR_ROLE`.

- [ ] Au moins **5 vérificateurs** indépendants : chacun `stake` ≥ `minVerifierStake` (1 000 SUPER au lancement option B) puis `registerVerifier` sur MarketplaceV2
- [ ] Smoke test : 1 petit job (create → assign → submit → finalize après 1 h)

---

## B. Transactions Safe 2-sur-3 (à proposer plus tard, une par une)

Chaque entrée = **une proposition séparée** dans l’UI Safe. Seuil **2 signatures sur 3**.  
Le propriétaire qui exécute paie le gas ETH (prévoir ~0,0005 ETH sur son EOA).

### B1 — Optionnel : financer les vestings / répartition (si décidé)

| Champ | Valeur |
|--------|--------|
| **To** | Token SUPER `0x212EE291056C673283BF441d861CA8EF696cC422` |
| **Interaction** | `transfer(address to, uint256 amount)` |
| **to** | adresse du contrat Vesting (écosystème / équipe / trésorerie) ou Timelock (communauté) |
| **amount** | selon `DISTRIBUTION` dans `scripts/v2/config.cjs` (ex. 37 % écosystème) |
| **Valeur ETH** | 0 |
| **Note** | Répéter **une tx Safe distincte par bucket**. Ne pas regrouper sans relecture. Les vestings doivent d’abord être déployés (hors script core). |

### B2 — Optionnel : amorcer le quorum gouvernance (≥ 100 000 SUPER)

Sans au moins 100 000 stSUPER, aucune proposition ne peut passer le plancher de quorum.

| Champ | Valeur |
|--------|--------|
| **To** | Token SUPER `0x212E…C422` |
| **Interaction** | `approve(address spender, uint256 amount)` |
| **spender** | StakingV2 `<ST>` |
| **amount** | ≥ `100000e18` (100 000 SUPER) |
| **Puis** (2ᵉ tx Safe) | StakingV2 `<ST>` → `stake(uint256 amount)` avec le même montant |
| **Note** | Deux propositions Safe séparées (approve puis stake). Le pouvoir de vote suit le délégat ; déléguer si besoin (`delegate`). |

Variante : transferer 100k SUPER vers des stakers désignés (tx `transfer` distinctes), qui stakent eux-mêmes.

### B3 — Optionnel : révoquer les rôles V1 (Staking)

| Champ | Valeur |
|--------|--------|
| **To** | V1 Staking `0x38e72DBb8F0B60d1162E382EE77C4d524b05F060` |
| **Interaction** | `renounceRole(bytes32 role, address account)` |
| **role** | `SLASHER_ROLE` = `keccak256("SLASHER_ROLE")` |
| **account** | Safe `0xB633…87D4` (ou Marketplace V1 si le Safe retire le slasher du market via `revokeRole`) |
| **Note** | Pour retirer le slasher du marketplace V1 : `revokeRole(SLASHER_ROLE, 0xd5E3a1Dad8955CF5CaDe45767FF4FC5CEA21E254)`. V1 devient inopérant pour le slash. |

### B4 — Optionnel : révoquer VERIFIER_ROLE V1 (Marketplace)

| Champ | Valeur |
|--------|--------|
| **To** | V1 Marketplace `0xd5E3a1Dad8955CF5CaDe45767FF4FC5CEA21E254` |
| **Interaction** | `renounceRole(bytes32 role, address account)` |
| **role** | `VERIFIER_ROLE` = `keccak256("VERIFIER_ROLE")` |
| **account** | Safe `0xB633…87D4` |
| **Note** | Empêche `finalizeJob` V1 par le Safe. Irréversible pour ce compte tant qu’aucun admin ne re-grant. |

### B5 — Décision irréversible : renoncer à DEFAULT_ADMIN / MINTER sur le token

| Champ | Valeur |
|--------|--------|
| **To** | Token SUPER `0x212E…C422` |
| **Interaction** | `renounceRole(bytes32 role, address account)` |
| **role** | `DEFAULT_ADMIN_ROLE` = `0x00…00` (32 octets nuls) |
| **account** | Safe `0xB633…87D4` |
| **Puis** (tx séparée) | même chose pour `MINTER_ROLE` = `keccak256("MINTER_ROLE")` |
| **Danger** | **Irréversible.** Plus de `grantRole` (PAUSER, etc.). Aucune fonction `mint` on-chain aujourd’hui, mais la perte d’admin bloque toute réparation de rôles. Ne faire qu’après audit + smoke V2.1 + vérificateurs en place. |

### B6 — Gardien : pause d’urgence (si besoin)

| Champ | Valeur |
|--------|--------|
| **To** | MarketplaceV2 `<MKT>` |
| **Interaction** | `pause()` |
| **Note** | Le Safe a `PAUSER_ROLE`. Veto Timelock : le Safe a aussi `CANCELLER_ROLE` sur le Timelock (`cancel`). |

---

## C. Estimation gas / ETH (déployeur EOA)

Mesures Sepolia core V2.1 ≈ **12 M gas**. Estimation mainnet (ECARTS) :

| Étape | Gas approx. |
|--------|-------------|
| Deploy StakingV2 | ≈ 2,72 M |
| Deploy Timelock | ≈ 1,31 M |
| Deploy Governor | ≈ 3,55 M |
| Deploy MarketplaceV2 | ≈ 4,09 M |
| Câblage rôles (~7 txs) | ≈ 0,31 M |
| **Total core** | **≈ 12 M** |

Sur Base à ~0,006 gwei : ≈ **0,00007–0,0002 ETH** (hors pic L1).  
Avec marge ×10 : ≈ 0,001 ETH.

| Compte | Solde actuel (approx.) | Recommandé avant « go » |
|--------|-------------------------|-------------------------|
| EOA déployeur `0xE603…939f` | ≈ **0,00119 ETH** | **≥ 0,003 ETH** (top-up ≈ **0,002 ETH**) |
| EOA qui exécute les Safe txs | — | ≥ **0,0005 ETH** |
| Safe | 0 ETH | pas nécessaire pour le core |

Le script refuse le broadcast si le déployeur a **&lt; 0,002 ETH**.

---

## D. Hors scope du script (rappel)

- Aucun `transfer` / `approve` SUPER depuis le Safe
- Aucun déploiement Vesting / Airdrop dans le core
- Aucune modification V1 automatique
- Les frais (`feeBps`) restent à **0** jusqu’à un vote Governor + Timelock (`setFees`)
