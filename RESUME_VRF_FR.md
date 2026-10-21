# Tirage des vérificateurs par Chainlink VRF — résumé (VRF-01)

## En très simple (pour le fondateur)

1. Quand quelqu'un conteste un travail, on tire au sort 3 vérificateurs. Avant, le « dé » était fabriqué à partir des blocs de la blockchain : un tricheur malin pouvait attendre le bon moment pour tomber sur des vérificateurs complices.
2. Maintenant, le dé est lancé par **Chainlink VRF**, un service externe qui fournit un nombre au hasard **avec une preuve** : personne (ni le contestataire, ni un vérificateur, ni nous) ne peut le prévoir ni le choisir.
3. Le tirage se fait en deux temps : on demande le hasard, Chainlink répond quelques secondes/minutes plus tard, et c'est seulement à ce moment-là que le comité est désigné.
4. Si un vérificateur tiré ne révèle pas son vote, il perd **toute sa caution** (pas seulement une partie) et il est exclu ; son remplaçant est tiré avec un **nouveau** dé Chainlink.
5. Si Chainlink ne répond pas, n'importe qui peut relancer la demande après 10 min (testnet) ; en dernier recours l'arbitre (Timelock) peut trancher.
6. Les réglages Chainlink ne peuvent être changés que par la gouvernance (Timelock), comme les autres paramètres sensibles.
7. Le service est payé en ETH (pas besoin de jeton LINK). Sur Base mainnet, un tirage coûte quelques centimes.

## Notes techniques

**Contrat** `contracts/v2/SuperionJobMarketplaceV2.sol` hérite de `VRFConsumerBaseV2Plus` (paquet officiel `@chainlink/contracts` 1.4.0).

- `challengeJob(jobId)` / `appeal(jobId)` : **plus de `seedCommit`**, plus de `revealCommittee` ni de `expireUnrevealedChallenge` (le commit-reveal de seed et le blockhash ont disparu, et avec eux le problème du « dernier révélateur »). Les deux appellent `_requestDraw` → `s_vrfCoordinator.requestRandomWords` (1 mot, `nativePayment` configurable).
- `fulfillRandomWords` (appelé seulement via `rawFulfillRandomWords`, qui vérifie `msg.sender == coordinateur`) tire le comité avec `_draw`, fixe les échéances de vote et émet `DrawFulfilled` + `CommitteeSelected`. Il **ne revert jamais** : requête inconnue, périmée (remplacée par un retry), déjà servie ou litige déjà clos → ignorée.
- État `pendingDraw[jobId] = {requestId, requestedAt, k}` ; `vrfRequestJob[requestId] = jobId`. Un mot VRF ne sert qu'une fois (`requestId` remis à 0 après usage).
- `retryDraw(jobId)` : ouvert à tous, seulement si une requête est en attente depuis plus de `requestTimeout` ; crée une nouvelle requête et invalide l'ancienne. Personne ne peut choisir entre deux aléas (l'ancien est ignoré même s'il arrive après).
- `rerollNonRevealers(jobId)` : saisit **la caution entière** des membres sans reveal (statut 1/2 → 5 = exclu du litige), les retire de la liste s'ils passent sous `minVerifierStake`, brûle le montant, puis fait une **nouvelle requête VRF** pour `nRemoved` places. `committeeSelected = false` pendant l'attente : votes, résolution, appel et nouveau re-tirage sont bloqués, donc impossible de rappeler la fonction pour « re-piocher ».
- Non-révélateur = caution entière **partout** (`rerollNonRevealers`, `_settleCommittee`, `resolveStale`). Le vote minoritaire garde la pénalité fixe `verifierPenalty`.
- Secours si VRF muet : `arbitrate` (Timelock) autorisé entre `requestedAt + requestTimeout` et `+ arbitrationWindow` ; ensuite `resolveStale` (issue neutre). Pour un appel bloqué : `retryDraw`, ou gel gardien + arbitre.
- Gouvernance : `setVrfConfig(VrfConfig)` réservé à `DEFAULT_ADMIN_ROLE` (= Timelock), bornes : keyHash ≠ 0, subId ≠ 0, 100 k ≤ callbackGasLimit ≤ 2,5 M, confirmations ≤ 200, 1 min ≤ requestTimeout ≤ 1 jour. Coordinateur : `setCoordinator` réservé à `owner()` (ConfirmedOwner) — la propriété est transférée au Timelock au déploiement puis **acceptée par le Timelock** (opération planifiée et exécutée avant la renonciation du déployeur). NB : le coordinateur Chainlink peut aussi appeler `setCoordinator` (mécanisme de migration prévu par Chainlink).
- `Params.seedRevealDelay/seedRevealWindow` restent dans la struct (ABI/constructeur inchangés) mais ne servent plus et ne sont plus validés.
- Taille : **24 483 octets** (limite 24 576) grâce à `optimizer.runs = 1` pour ce seul fichier (`hardhat.config.cjs`). Marge restante ~90 octets : toute nouvelle fonction devra passer par une bibliothèque/un contrat annexe.
- Gaz du callback mesuré : ~285 k pour un comité de 3 (indépendant du nombre de vérificateurs tant que les premiers scannés sont éligibles) ; pire cas (200 vérificateurs presque tous inéligibles) ≈ 1,3 M+. Testnet : `callbackGasLimit = 500 000` ; mainnet : recommandé 1 500 000. Si le callback manque de gaz, la requête reste « en attente » côté marketplace → `retryDraw` après le délai.

**Tests** : 62/62 (`npx hardhat test`) dont `test/vrf.test.js` (6 nouveaux : tirage asynchrone, double livraison ignorée, re-tirage VRF + caution entière, timeout/retry + réponse périmée + issue neutre, contrôle d'accès config/coordinateur/propriété, absent en résolution finale) + 2 dans `hardening.test.js` (seul le coordinateur livre ; comité = f(mot VRF) uniquement). Mock officiel `VRFCoordinatorV2_5Mock`.
**Slither** : `SLITHER_REPORT_VRF.txt` — le détecteur `weak-prng` (blockhash) a disparu ; restent les constats déjà connus (reentrancy sur appels de confiance staking/coordinateur, timestamp, calls-loop).

**Base Sepolia** : voir `deployments/vrf.baseSepolia.json` (adresses, subId, transactions, test de bout en bout).
Coordinateur `0x5C210eF41CD1a72de73bF76eC39637bB0d3d7BEE`, keyHash 30 gwei `0x9e1344a1247c8a1785d0a4681a27152bffdb43666ae5bf7d14d24a5efd44bf71`, prime 60 % (ETH).
**Base mainnet (pour plus tard)** : coordinateur `0xd5D517aBE5cF79B7e95eC98dB0f0277788aFF634`, keyHash 2 gwei `0x00b81b5a830cb0a4009fbd8904de511e28631e62ce5ad231373d3cdad373ccab`, keyHash 30 gwei `0xdc2f87677b01473c763cb0aee938ed3341512f6057324a584e5944e786144d70`, LINK `0x88Fb150BDc53A65fe94Dea0c9BA0a6dAf8C6e196`, prime 60 % ETH / 50 % LINK, max 2,5 M gaz, 0 confirmation min. (Source : docs.chain.link/vrf/v2-5/supported-networks, consulté le 21/10/2026.)
