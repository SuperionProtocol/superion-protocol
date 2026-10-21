# Plan de passage au mainnet Base — V2-fixes (PRÉPARÉ, NON EXÉCUTÉ)

> ⚠️ **Aucun déploiement mainnet n'a été fait.** Le script est prêt mais n'a jamais été lancé sur le mainnet (seulement un dry-run local).
> **Recommandation forte : faire un audit / une revue de sécurité externe AVANT.** Environ 300 lignes de logique financière nouvelle (appel, re-tirage, gel) n'ont jamais été auditées.

## 0. Point de départ (mainnet actuel, `deployments/v2.1.base.mainnet.json`)
| Élément | Adresse |
|---|---|
| SUPER (jeton, offre fixe, **immuable, inchangé**) | `0x212EE291056C673283BF441d861CA8EF696cC422` |
| StakingV2 (stSUPER, désengagement 7 j) | `0x92D9287B2aE16630d1b3b0fca26Aa0f09c957528` |
| Timelock | `0x1E2deB77C9A50F064b97f8C90Facc91c4D081151` |
| Governor | `0x22A2e573904730B1EC37B971052EF6Da7B3A0f80` |
| MarketplaceV2 | `0x5F0297A5B5F5444920e6673f1b60D5d1f1b302C1` |
| Safe 2-of-3 (gardien : PAUSER du marketplace + CANCELLER du Timelock) | `0xB633ae886bbb0939E0cB7130be0D367CED9f87D4` |
| Déployeur (EOA, sans rôle après déploiement) | `0xE60322A5543C2bAD26115053B586d9679F4A939f` |

Aucun de ces contrats n'est upgradable (pas de proxy). `UNBONDING_PERIOD` est une constante et la logique de litige est dans le bytecode. **Le seul moyen est donc de déployer de nouveaux contrats.**
Le jeton SUPER n'a **ni minter ni admin** (offre fixe frappée au constructeur). Il n'y a **aucun câblage minter** à faire.

## 1. Pourquoi les 4 contrats « core » sont redéployés
- **Staking** : le désengagement passe à 14 j (constante). Il faut un nouveau stSUPER.
- **Marketplace** : nouvelle logique. Il est lié à son staking (`immutable`).
- **Governor** : il compte les votes en stSUPER (`immutable`). Le nouveau stSUPER impose un nouveau Governor.
- **Timelock** : deux options.
  - **Option A (script prêt, la plus simple)** : nouveau Timelock.
  - **Option B** : garder l'ancien Timelock. L'ancienne gouvernance vote `grantRole(PROPOSER/CANCELLER, nouveauGovernor)` puis révoque l'ancien Governor. Le nouveau marketplace et le nouveau staking sont alors administrés par l'ancien Timelock (passer son adresse au lieu d'en créer un : `EXISTING='{"SuperionTimelock":"0x1E2d…1151"}'`). **À choisir si l'ancien Timelock détient des fonds ou des rôles** (à vérifier avant).

## 2. Étapes exactes
1. **Audit** de `contracts/v2/SuperionJobMarketplaceV2.sol` et `SuperionStakingV2.sol` (diff de la branche `v2-fixes`). Corriger les remarques. Relancer `npx hardhat test` (56/56) et Slither.
2. **Gel du code** : tag git, revue du diff par une 2e personne.
3. **Dry-run** sur un fork du mainnet :
   `FORK_BASE=1 DRY_RUN=1 npx hardhat run scripts/v2/deploy-v2-fixes-mainnet.cjs --network hardhat`
   Puis contrôler `deployments/v2-fixes.base.mainnet.dry-run.json`.
4. **Ajuster les paramètres** dans `scripts/v2/config.cjs` (`MARKETPLACE_PARAMS_MAINNET_LAUNCH`). Les paramètres de sécurité par défaut sont dans le constructeur : caution ≥ 1× la valeur du job, 2 re-tirages, 3 j de gel post-litige, 1 h d'appel, comité d'appel de 5, caution d'appel de 20 %. Ils sont modifiables ensuite **uniquement par le Timelock** (`setSecurityParams`).
5. **Déploiement réel**, avec un déployeur financé, la clé uniquement dans `.env` :
   `CONFIRM_MAINNET=1 npx hardhat run scripts/v2/deploy-v2-fixes-mainnet.cjs --network base --confirm-mainnet`
   Le script refuse si chainId ≠ 8453 ou sans confirmation explicite. Il effectue, depuis le déployeur, environ 11 transactions :
   - déployer Staking, Timelock, Governor et Marketplace (admin = Timelock, gardien = Safe, arbitre = Timelock) ;
   - Timelock : `grantRole(PROPOSER, Governor)`, `grantRole(CANCELLER, Governor)`, `grantRole(CANCELLER, Safe)` ;
   - Staking : `grantRole(OPERATOR, Marketplace)`, `grantRole(ADMIN, Timelock)`, `renounceRole(ADMIN, déployeur)` ;
   - Timelock : `renounceRole(ADMIN, déployeur)`.
6. **Vérification** Basescan/Sourcify (`deployments/verify-args-v2-fixes-mainnet/`). Contrôler qu'il ne reste **aucun rôle** au déployeur (lire `hasRole` sur chaque contrat).

## 3. Transactions Safe 2-of-3 et Timelock nécessaires
| # | Qui signe | Transaction | But |
|---|---|---|---|
| S1 | Safe (PAUSER de l'ancien marketplace) | `oldMarketplace.pause()` | Bloquer les **nouveaux** jobs et assignations sur l'ancien contrat (la finalisation et les litiges en cours continuent). |
| S2 | Safe | aucune sur les nouveaux contrats : le Safe reçoit ses rôles (PAUSER, CANCELLER) au déploiement | Simplement vérifier `hasRole`. |
| T1 (option B seulement) | Ancien Governor → ancien Timelock | `grantRole(PROPOSER_ROLE, newGovernor)`, `grantRole(CANCELLER_ROLE, newGovernor)`, puis `revokeRole(PROPOSER_ROLE, oldGovernor)` | Réutiliser l'ancien Timelock. |
| T2 (optionnel) | Nouveau Timelock (via le nouveau Governor) | `setSecurityParams(...)` / `setFees(...)` | Ajuster les paramètres après le lancement. |

Le Safe garde, sur le nouveau marketplace, le pouvoir de **geler un litige suspect** (`freezeDispute`, 7 j maximum, une fois par litige) et de `pause()`.

## 4. Migration
- **Jobs ouverts ou en litige** : ils **ne migrent pas**. L'argent en séquestre reste sur l'ancien marketplace jusqu'à la fin normale (finalisation, litige, `reclaimExpired`). Après S1, plus aucun nouveau job n'y arrive. Les nouveaux jobs vont sur le nouveau marketplace (mise à jour des adresses dans l'app et le site).
- **Stakers** : ils appellent `requestUnstake` sur l'ancien staking, attendent **7 jours** (ancienne règle), font `completeUnstake` puis `stake` sur le nouveau. Leurs récompenses se réclament sur l'ancien (`claimRewards`).
- **Vérificateurs** : `exitVerifier` sur l'ancien (possible seulement sans litige en cours), désengagement, re-stake, puis `registerVerifier` (et `increaseVerifierBond` pour les gros jobs) sur le nouveau.
- **Gouvernance** : le pouvoir de vote repart de zéro sur le nouveau stSUPER, au fur et à mesure des re-stakes. Prévoir une période de transition où le **Safe (CANCELLER)** peut annuler une proposition hostile, car le quorum est faible au départ.
- **Communication** : annoncer la date, publier les nouvelles adresses vérifiées et un guide de migration en 3 clics dans l'app.

## 5. Coût estimé en gaz (Base, mesuré le 19/10/2026 vers 23:15 heure de Zurich)
- Gaz total mesuré sur un déploiement local identique (4 contrats + 7 transactions de rôles) : **≈ 13,24 M de gaz**.
- Prix du gaz Base au moment de la mesure : **0,006 gwei** (`eth_gasPrice` = 6 000 000 wei).
- Exécution L2 : 13,24 M × 0,006 gwei ≈ **0,00008 ETH**.
- Frais de données L1 (≈ 65 Ko de bytecode) : en général quelques dixièmes de millième d'ETH.
- **Total attendu : ≈ 0,0001 à 0,0005 ETH. Prévoir 0,005 ETH sur le déployeur** (marge ×10 en cas de pic de gaz).
- Les transactions Safe (S1) et les migrations utilisateurs coûtent chacune une fraction de centime.

## 6. Rollback (retour arrière)
Les contrats ne se suppriment pas, mais le retour arrière est simple :
1. Safe : `newMarketplace.pause()` (bloque les nouveaux jobs ; les litiges en cours se terminent).
2. Safe : `oldMarketplace.unpause()` (l'ancien reprend du service).
3. L'app et le site repointent vers les anciennes adresses.
4. Les stakers du nouveau contrat se désengagent (14 j).
Aucun fonds n'est perdu par le rollback. La seule contrainte est le délai de désengagement.

## 7. Points de vigilance
- La taille du bytecode du marketplace est de 23 161 octets (limite 24 576). Il reste peu de marge pour de futurs ajouts.
- Le hasard du re-tirage est faible (blockhash). Un VRF est recommandé à terme.
- Il faut assez de vérificateurs avec une grosse caution avant d'accepter de gros jobs.
- **Audit recommandé avant le mainnet.**

## 8. Chainlink VRF v2.5 (VRF-01) — à faire pour le mainnet

Le marketplace V2-fixes+VRF tire les comités avec Chainlink VRF (voir `RESUME_VRF_FR.md`). Pour le mainnet Base :

1. **Abonnement** sur le coordinateur Base `0xd5D517aBE5cF79B7e95eC98dB0f0277788aFF634` (`createSubscription`), idéalement **créé par le Safe** (propriétaire de l'abonnement = peut retirer/annuler les consommateurs ; ne doit pas rester une clé chaude). Paiement en **ETH natif** (`fundSubscriptionWithNative`) : pas besoin de LINK.
2. **Constructeur** : `vrfCoordinator` + `VrfConfig{ keyHash 2 gwei 0x00b81b5a830cb0a4009fbd8904de511e28631e62ce5ad231373d3cdad373ccab, subId, callbackGasLimit 1 500 000, requestConfirmations 1–3, requestTimeout 3600 s, nativePayment true }`.
3. Après déploiement : `addConsumer(subId, marketplace)` (Safe), puis `transferOwnership(Timelock)` et **`acceptOwnership()` exécuté par le Timelock** (proposition Governor, ou bootstrap avant renonciation de l'admin du Timelock comme sur Sepolia — `scripts/v2/deploy-vrf-sepolia.cjs`). Vérifier `owner() == Timelock` avant d'ouvrir les litiges.
4. **Solde minimum (« Max Cost »)** exigé par Chainlink avant de servir une requête : `prix max de la voie × (200 000 + callbackGasLimit) × 1,6`. Voie 2 gwei + 1,5 M gaz → **≈ 0,0054 ETH** ; voie 30 gwei → ≈ 0,082 ETH. Recommandation : voie 2 gwei, abonnement alimenté à **0,02–0,05 ETH** et alerte si < 0,01 ETH.
5. **Coût réel par tirage** (formule docs.chain.link/vrf/v2-5/billing : `prix du gaz × (vérification + callback) × (1 + prime 60 %)`) : callback mesuré ≈ 285 000 gaz (comité de 3), vérification ≈ 130 000 → ≈ 415 000 gaz × 0,01 gwei × 1,6 ≈ **0,0000066 ETH (≈ 2–3 centimes)** par tirage, + petite part de frais L1 de Base. Un litige complet = 1 tirage, + 1 par re-tirage, + 1 en cas d'appel (comité de 5, ~+100 000 gaz).
6. Surveillance : requêtes en attente sur vrf.chain.link/base ; en cas de panne Chainlink, `retryDraw` (après `requestTimeout`) puis arbitre Timelock / `resolveStale`.
7. Rappel taille : 24 483 / 24 576 octets — aucune marge pour de nouvelles fonctions sans scinder le contrat.
