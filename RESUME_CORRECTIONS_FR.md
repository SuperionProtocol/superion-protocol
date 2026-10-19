# Superion — Corrections suite à la revue Reddit (V2-fixes)

*Résumé pour le fondateur, sans jargon. Branche `v2-fixes` (copie de travail : `/workspace/superion-v2-fixes`). Rien n'a été poussé sur GitHub ni déployé sur le mainnet.*

## En une phrase
Les trois critiques du développeur ont été traitées **toutes, au pied de la lettre** : 56 tests passent (45 d'origine + 11 nouveaux). Ces corrections ne sont **pas** actives sur le mainnet : il faut déployer de **nouveaux contrats** (les contrats actuels ne peuvent pas être modifiés), et faire **un audit avant**.

---

## Point 1. « Le dernier à révéler peut bloquer ou abandonner pour influencer le comité »
**Ce qu'il y avait déjà :**
- Le contestataire qui ne révèle pas son secret de tirage perd sa caution (brûlée) et perd la contestation. Il ne peut pas « relancer les dés ».
- Un vérificateur qui vote en secret puis ne révèle pas son vote est pénalisé (100 SUPER) au moment du verdict.
- **Ce qui manquait :** s'il n'y avait pas de majorité à cause d'un absent, le litige partait chez l'arbitre (Timelock). L'absent n'était **pas remplacé**.

**Ce qui a changé** (correspond à *« reveal timeout; non-revealer gets slashed and the draw is re-rolled without them »*) :
- Une fois le délai de révélation passé et sans majorité, **n'importe qui** peut lancer un « re-tirage ». Les vérificateurs qui n'ont pas révélé sont **pénalisés tout de suite**, **exclus définitivement** de ce litige, et **remplacés** par de nouveaux vérificateurs tirés au sort. Les votes déjà révélés sont conservés. 2 re-tirages maximum (réglable, plafond 3).

## Point 2. « Un comité de 3 (majorité de 2) coûte peu à corrompre avec une petite caution »
**Ce qu'il y avait déjà :** une caution fixe de 1 000 stSUPER par vérificateur, quelle que soit la valeur du litige. Pas d'appel (seulement un arbitre Timelock quand il n'y a pas de majorité).

**Ce qui a changé :**
- **2a — caution proportionnelle** (*« bond scaling with dispute value »*) : pour siéger sur un litige, un vérificateur doit avoir une caution **≥ la valeur du job** (1×, réglable jusqu'à 10×), avec un minimum de 1 000. Ils peuvent augmenter leur caution. Corrompre un comité sur un gros job coûte donc au moins autant que le job lui-même.
- **2b — appel** (*« an appeal layer where the losing party posts a bigger stake (goes to verifiers if appeal fails), possibly a larger appeal committee »*) : après le verdict, le **perdant** dispose d'une heure (réglable) pour faire appel en déposant une caution **plus élevée** (20 % du job, au minimum 2× la caution de contestation). Un **nouveau comité de 5** vérificateurs (différents des 3 premiers) est tiré au sort.
  - Si l'appel **échoue**, la caution d'appel est **partagée entre les vérificateurs** qui ont voté juste.
  - S'il **réussit**, l'appelant récupère sa caution et les vérificateurs du 1er comité qui s'étaient trompés sont pénalisés.
  - Si le comité d'appel ne dégage pas de majorité, le premier verdict est maintenu.
  - Un seul appel par litige.

## Point 3. « 7 jours de désengagement, c'est court quand personne ne surveille »
**Ce qu'il y avait déjà :** 7 jours. Une caution est bloquée tant que le vérificateur siège. Le gardien (Safe) pouvait mettre en pause la création de jobs, mais **pas les litiges**.

**Ce qui a changé :**
- **Fenêtre plus longue** (*« longer window »*) : le désengagement passe de **7 à 14 jours**.
- **Gel après un litige** : la caution d'un vérificateur reste bloquée **3 jours après** sa dernière mission. Il ne peut donc pas « voter puis fuir ».
- **Pause après des votes suspects** (*« pause mechanism after suspicious votes »*) : le gardien (Safe 2-of-3) peut **geler un litige précis** pour 7 jours au maximum, une seule fois par litige. Pendant le gel, aucune résolution n'est possible et l'**arbitre Timelock (gouvernance)** peut trancher, y compris contre la majorité. Le gel est limité dans le temps pour que le gardien ne puisse pas bloquer indéfiniment.

---

## Ce qui reste (limites honnêtes)
- **Le hasard du re-tirage** dépend du bloc où quelqu'un lance le re-tirage. C'est un hasard « faible » : très difficile à exploiter, mais pas parfait. Il faudra un vrai oracle de hasard (VRF) plus tard.
- Il faut **assez de vérificateurs** avec une grosse caution. Sinon, les gros litiges ont un comité incomplet ou vide et l'arbitre doit trancher.
- L'appel et le gel rallongent la durée d'un litige (une heure d'appel, plus un deuxième vote).
- Le gardien et le Timelock gagnent un pouvoir sur les litiges gelés. C'est voulu, mais la gouvernance doit le surveiller.
- **Aucun audit externe.** Ce sont environ 300 lignes de logique financière nouvelle.

## Ce qu'exige le passage au mainnet
1. Les contrats actuels sont **immuables**. Il faut **déployer de nouveaux contrats** Staking, Marketplace, Governor et Timelock (le jeton SUPER, lui, ne change pas).
2. **Migration :** les stakers retirent leur stake de l'ancien contrat (attente de **7 jours** sur l’ancien contrat) puis re-stakent sur le nouveau. Les vérificateurs se réinscrivent. Les jobs en cours se terminent sur l'ancien marketplace. Les nouveaux jobs vont sur le nouveau.
3. Côté **Safe 2-of-3 / Timelock :** le gardien reste le Safe. L'ancienne gouvernance peut bloquer les nouveaux jobs sur l'ancien marketplace (pause). L'application doit pointer vers les nouvelles adresses.
4. **Un audit de sécurité est fortement recommandé avant tout déploiement mainnet.**

Détail technique : `PLAN_MAINNET_FR.md`.

## Version de test (Base Sepolia, testnet uniquement)
Staking (14 j) `0x417557c348892095B950E4403e2B4d15280bcd5f` · Timelock `0x684F54EF5de6385011c4944Ad85f1c55a0be9E0d` · Governor `0xf55E4b9AB5fDb48EA06Ca857a0907C7c9a717C5c` · Marketplace V2-fixes `0xf54140bcb638D8bf4EA345b243CbDfdB51CedDf7` (jeton SUPER Sepolia existant). Le déployeur n'a plus aucun rôle admin ; le gardien (pause/gel) reste le déployeur sur le testnet.
