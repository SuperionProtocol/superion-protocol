// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/access/AccessControl.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/utils/Pausable.sol";
import "./ISuperToken.sol";

interface IStakingV2 {
    function availableStake(address user) external view returns (uint256);
    function lock(address user, uint256 amount) external;
    function unlock(address user, uint256 amount) external;
    function slash(address user, uint256 amount) external;
    function depositRewards(uint256 amount) external;
}

/**
 * @title SuperionJobMarketplaceV2
 * @notice Marketplace de jobs payés en SUPER (V2.1) avec :
 *   - finalisation optimiste ;
 *   - contestation en commit-reveal (seed) puis tirage de comité (H-01) ;
 *   - votes de vérificateurs en commit-reveal (M-01) ;
 *   - feeBps / burnShareBps figés à la création du job ; pénalité et slash bps
 *     figés à la contestation (M-03) ;
 *   - arbitre Timelock de secours / issue neutre.
 *   Paramètres modifiables uniquement par DEFAULT_ADMIN_ROLE (= Timelock).
 */
contract SuperionJobMarketplaceV2 is AccessControl, ReentrancyGuard, Pausable {
    using SafeERC20 for ISuperToken;

    bytes32 public constant PAUSER_ROLE = keccak256("PAUSER_ROLE");
    bytes32 public constant ARBITER_ROLE = keccak256("ARBITER_ROLE");

    uint256 public constant BPS = 10_000;
    uint256 public constant MAX_FEE_BPS = 1_000;
    uint256 public constant MAX_VERIFIERS = 200;
    uint256 public constant MAX_COMMITTEE = 15;
    uint256 public constant MAX_JOB_DURATION = 365 days;
    uint256 public constant MIN_CHALLENGE_BOND = 1 ether / 1000; // 0.001 SUPER (anti-spam)
    uint256 public constant MAX_CHALLENGE_BOND = 1_000_000 ether;
    /// @dev HARDENING-01 : blockhash() n'est disponible que pour les 256 derniers blocs (~512 s sur Base).
    ///      Au-delà, l'ancien code retombait sur blockhash(block.number - 1), que le contestataire
    ///      peut choisir en retardant sa révélation (manipulation du comité). On plafonne la fenêtre.
    uint256 public constant MAX_SEED_REVEAL_WINDOW = 8 minutes;
    /// @dev FIX-3 : durée max d'un gel de litige par le gardien (borne le pouvoir du gardien).
    uint256 public constant MAX_DISPUTE_FREEZE = 7 days;
    uint256 public constant MAX_REROLLS = 3;

    ISuperToken public immutable superToken;
    IStakingV2 public immutable staking;

    struct Params {
        uint16 feeBps;
        uint16 burnShareBps;
        uint32 challengePeriod;
        uint32 seedRevealDelay;    // attente min avant révélation du seed (commit-reveal comité)
        uint32 seedRevealWindow;   // fenêtre max pour révéler le seed
        uint32 voteCommitWindow;   // phase commit des votes
        uint32 voteRevealWindow;   // phase reveal des votes
        uint32 arbitrationWindow;
        uint8 committeeSize;
        uint16 providerStakeBps;
        uint16 slashVerifierBps;
        uint16 slashChallengerBps;
        uint256 minVerifierStake;
        uint256 verifierPenalty;
        uint256 challengeBond;
    }
    Params public params;

    /// @notice Paramètres de sécurité V2-fixes (struct séparée pour ne pas casser l'ABI/constructeur).
    struct SecurityParams {
        uint16 stakeToValueBps;      // FIX-2a : éligibilité comité si caution >= budget * bps / BPS
        uint8 maxRerolls;            // FIX-1  : nb max de re-tirages après non-révélation
        uint32 verifierCooldown;     // FIX-3  : délai après la dernière mission avant libération de la caution
        uint32 appealWindow;         // FIX-2b : fenêtre d'appel après la fin du reveal (0 = appel désactivé)
        uint8 appealCommitteeSize;   // FIX-2b : taille du comité d'appel (impair)
        uint16 appealBondBps;        // FIX-2b : caution d'appel = max(2 x caution contestation, budget * bps / BPS)
    }
    SecurityParams public securityParams;

    struct DisputeExt {
        bytes32 random;              // aléa du dernier tirage (sert aux re-tirages)
        address appellant;           // != 0 : appel déposé
        uint256 appealBond;
        uint64 frozenUntil;          // FIX-3 : gel gardien
        uint8 rerolls;
        bool appealSelected;         // comité d'appel tiré
        bool firstVerdictValid;      // verdict du 1er comité (si appel)
        bool freezeUsed;
    }
    mapping(uint256 => DisputeExt) public disputeExt;
    mapping(uint256 => address[]) internal _firstCommittees;
    mapping(address => uint64) public lastDutyEnd;

    enum Status { None, Open, Assigned, Completed, Disputed, Finalized, Refunded, Cancelled }

    struct Job {
        address creator;
        address provider;
        uint16 feeBps;              // figé à la création
        uint16 burnShareBps;        // figé à la création (M-03)
        Status status;
        uint64 deadline;
        uint64 challengeDeadline;
        uint64 disputeDeadline;     // fin de la phase reveal des votes (= début fenêtre arbitre)
        uint256 budget;
        uint256 lockedStake;
        string jobURI;
        string resultURI;
    }

    struct Dispute {
        address challenger;
        uint8 votesValid;
        uint8 votesInvalid;
        uint256 bond;
        bytes32 seedCommit;
        uint64 commitBlock;
        uint64 seedRevealEarliest;
        uint64 seedRevealDeadline;
        uint64 voteCommitDeadline;
        uint256 verifierPenalty;    // figé à la contestation
        uint16 slashVerifierBps;
        uint16 slashChallengerBps;
        bool committeeSelected;
    }

    struct VerifierInfo {
        uint256 bond;
        uint32 duties;
        uint32 indexPlus1;
    }

    uint256 public nextJobId = 1;
    mapping(uint256 => Job) public jobs;
    mapping(uint256 => Dispute) public disputes;
    mapping(uint256 => address[]) internal _committees;
    // 0 = hors comité, 1 = membre sans commit, 2 = commit déposé, 3 = vote "valide", 4 = vote "invalide"
    mapping(uint256 => mapping(address => uint8)) public memberVote;
    mapping(uint256 => mapping(address => bytes32)) public voteCommits;

    mapping(address => VerifierInfo) public verifiers;
    address[] public verifierList;

    event ParamsUpdated(Params p);
    event JobCreated(uint256 indexed jobId, address indexed creator, uint256 budget, uint16 feeBps, string jobURI);
    event JobAssigned(uint256 indexed jobId, address indexed provider, uint256 lockedStake);
    event JobCompleted(uint256 indexed jobId, string resultURI, uint256 challengeDeadline);
    event JobChallenged(uint256 indexed jobId, address indexed challenger, uint256 bond, bytes32 seedCommit, uint256 seedRevealDeadline);
    event CommitteeSelected(uint256 indexed jobId, address[] committee, uint256 voteCommitDeadline, uint256 voteRevealDeadline);
    event ChallengeExpired(uint256 indexed jobId, address indexed challenger, uint256 bondBurned);
    event VoteCommitted(uint256 indexed jobId, address indexed verifier, bytes32 commitHash);
    event VoteCast(uint256 indexed jobId, address indexed verifier, bool providerValid);
    event DisputeResolved(uint256 indexed jobId, bool providerValid, bool byArbiter);
    event JobFinalized(uint256 indexed jobId, address indexed provider, uint256 payout, uint256 fee, uint256 burned, uint256 toStakers);
    event JobRefunded(uint256 indexed jobId, address indexed creator, uint256 amount);
    event JobCancelled(uint256 indexed jobId);
    event ProviderSlashed(uint256 indexed jobId, address indexed provider, uint256 amount, uint256 burned);
    event VerifierPenalized(uint256 indexed jobId, address indexed verifier, uint256 amount);
    event VerifierRegistered(address indexed verifier, uint256 bond);
    event VerifierExited(address indexed verifier, uint256 bondReleased);
    event Burned(uint256 amount);
    event SecurityParamsUpdated(SecurityParams p);
    event CommitteeRerolled(uint256 indexed jobId, address[] removed, address[] committee, uint256 voteCommitDeadline, uint256 voteRevealDeadline);
    event AppealFiled(uint256 indexed jobId, address indexed appellant, uint256 bond, bytes32 seedCommit, uint256 seedRevealDeadline);
    event AppealCommitteeSelected(uint256 indexed jobId, address[] committee);
    event AppealSettled(uint256 indexed jobId, bool overturned, uint256 appealBond);
    event DisputeFrozen(uint256 indexed jobId, uint256 until);
    event DisputeUnfrozen(uint256 indexed jobId);
    event VerifierBondIncreased(address indexed verifier, uint256 amount, uint256 newBond);

    error InvalidParams();
    error InvalidState();
    error NotAllowed();
    error NoMajority();
    error HasMajority();
    error TooEarly();
    error TooLate();
    error VerifierCapReached();
    error BadCommit();
    error Frozen();
    error Cooldown();

    constructor(address _superToken, address _staking, address admin, address pauser, address arbiter, Params memory p) {
        superToken = ISuperToken(_superToken);
        staking = IStakingV2(_staking);
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        if (pauser != address(0)) _grantRole(PAUSER_ROLE, pauser);
        if (arbiter != address(0)) _grantRole(ARBITER_ROLE, arbiter);
        _setParams(p);
        _setSecurityParams(SecurityParams({
            stakeToValueBps: 10_000,     // caution >= 1 x valeur du litige
            maxRerolls: 2,
            verifierCooldown: 3 days,
            appealWindow: 1 hours,
            appealCommitteeSize: 5,
            appealBondBps: 2_000         // 20 % du budget (min 2 x caution de contestation)
        }));
    }

    function setSecurityParams(SecurityParams calldata s) external onlyRole(DEFAULT_ADMIN_ROLE) {
        _setSecurityParams(s);
    }

    function _setSecurityParams(SecurityParams memory s) internal {
        if (
            s.stakeToValueBps > 10 * BPS || s.maxRerolls > MAX_REROLLS || s.verifierCooldown > 30 days
                || s.appealWindow > 7 days
                || s.appealCommitteeSize == 0 || s.appealCommitteeSize > MAX_COMMITTEE || s.appealCommitteeSize % 2 == 0
                || s.appealBondBps > 5 * BPS
        ) revert InvalidParams();
        securityParams = s;
        emit SecurityParamsUpdated(s);
    }

    function setParams(Params calldata p) external onlyRole(DEFAULT_ADMIN_ROLE) {
        _setParams(p);
    }

    function setFees(uint16 feeBps, uint16 burnShareBps) external onlyRole(DEFAULT_ADMIN_ROLE) {
        Params memory p = params;
        p.feeBps = feeBps;
        p.burnShareBps = burnShareBps;
        _setParams(p);
    }

    function _setParams(Params memory p) internal {
        if (
            p.feeBps > MAX_FEE_BPS || p.burnShareBps > BPS
                || p.challengePeriod < 1 minutes || p.challengePeriod > 7 days
                || p.seedRevealDelay < 30 seconds
                || p.seedRevealWindow < p.seedRevealDelay || p.seedRevealWindow > MAX_SEED_REVEAL_WINDOW
                || p.voteCommitWindow < 1 minutes || p.voteCommitWindow > 7 days
                || p.voteRevealWindow < 1 minutes || p.voteRevealWindow > 7 days
                || p.arbitrationWindow < 1 hours || p.arbitrationWindow > 30 days
                || p.committeeSize == 0 || p.committeeSize > MAX_COMMITTEE || p.committeeSize % 2 == 0
                || p.providerStakeBps > 5 * BPS
                || uint256(p.slashVerifierBps) + p.slashChallengerBps > BPS
                || p.minVerifierStake == 0 || p.verifierPenalty > p.minVerifierStake
                || p.challengeBond < MIN_CHALLENGE_BOND || p.challengeBond > MAX_CHALLENGE_BOND
        ) revert InvalidParams();
        params = p;
        emit ParamsUpdated(p);
    }

    function pause() external onlyRole(PAUSER_ROLE) { _pause(); }
    function unpause() external onlyRole(PAUSER_ROLE) { _unpause(); }

    function verifierCount() external view returns (uint256) { return verifierList.length; }
    function committeeOf(uint256 jobId) external view returns (address[] memory) { return _committees[jobId]; }
    function firstCommitteeOf(uint256 jobId) external view returns (address[] memory) { return _firstCommittees[jobId]; }

    /// @notice FIX-2a : caution minimale pour siéger sur un litige de valeur `budget`.
    function requiredVerifierBond(uint256 budget) public view returns (uint256 r) {
        r = (budget * securityParams.stakeToValueBps) / BPS;
        if (r < params.minVerifierStake) r = params.minVerifierStake;
    }

    /// @notice Caution d'appel pour un job.
    function appealBondFor(uint256 jobId) public view returns (uint256 b) {
        b = (jobs[jobId].budget * securityParams.appealBondBps) / BPS;
        uint256 floor = 2 * disputes[jobId].bond;
        if (b < floor) b = floor;
        if (b < MIN_CHALLENGE_BOND) b = MIN_CHALLENGE_BOND;
    }

    /// @notice FIX-2a : un vérificateur inscrit augmente sa caution pour siéger sur des litiges plus gros.
    function increaseVerifierBond(uint256 amount) external nonReentrant {
        VerifierInfo storage v = verifiers[msg.sender];
        if (v.indexPlus1 == 0 || amount == 0) revert InvalidState();
        staking.lock(msg.sender, amount);
        v.bond += amount;
        emit VerifierBondIncreased(msg.sender, amount, v.bond);
    }

    function registerVerifier() external nonReentrant {
        VerifierInfo storage v = verifiers[msg.sender];
        if (v.indexPlus1 != 0 || v.bond != 0) revert InvalidState();
        if (verifierList.length >= MAX_VERIFIERS) revert VerifierCapReached();
        uint256 bond = params.minVerifierStake;
        staking.lock(msg.sender, bond);
        v.bond = bond;
        verifierList.push(msg.sender);
        v.indexPlus1 = uint32(verifierList.length);
        emit VerifierRegistered(msg.sender, bond);
    }

    function exitVerifier() external nonReentrant {
        VerifierInfo storage v = verifiers[msg.sender];
        if (v.indexPlus1 != 0) _removeFromList(msg.sender);
        uint256 released;
        if (v.duties == 0 && v.bond > 0) {
            // FIX-3 : caution gelée pendant verifierCooldown après la dernière mission
            if (block.timestamp < uint256(lastDutyEnd[msg.sender]) + securityParams.verifierCooldown) revert Cooldown();
            released = v.bond;
            v.bond = 0;
            staking.unlock(msg.sender, released);
        }
        emit VerifierExited(msg.sender, released);
    }

    function _removeFromList(address who) internal {
        VerifierInfo storage v = verifiers[who];
        uint256 idx = v.indexPlus1 - 1;
        uint256 last = verifierList.length - 1;
        if (idx != last) {
            address moved = verifierList[last];
            verifierList[idx] = moved;
            verifiers[moved].indexPlus1 = uint32(idx + 1);
        }
        verifierList.pop();
        v.indexPlus1 = 0;
    }

    function createJob(uint256 budget, uint256 duration, string calldata jobURI)
        external nonReentrant whenNotPaused returns (uint256 jobId)
    {
        if (budget == 0 || duration == 0 || duration > MAX_JOB_DURATION || bytes(jobURI).length == 0) revert InvalidParams();
        superToken.safeTransferFrom(msg.sender, address(this), budget);
        jobId = nextJobId++;
        Job storage j = jobs[jobId];
        j.creator = msg.sender;
        j.budget = budget;
        j.feeBps = params.feeBps;
        j.burnShareBps = params.burnShareBps;
        j.deadline = uint64(block.timestamp + duration);
        j.status = Status.Open;
        j.jobURI = jobURI;
        emit JobCreated(jobId, msg.sender, budget, j.feeBps, jobURI);
    }

    function assignJob(uint256 jobId) external nonReentrant whenNotPaused {
        Job storage j = jobs[jobId];
        if (j.status != Status.Open || block.timestamp >= j.deadline) revert InvalidState();
        uint256 lockAmt = (j.budget * params.providerStakeBps) / BPS;
        if (lockAmt > 0) staking.lock(msg.sender, lockAmt);
        j.provider = msg.sender;
        j.lockedStake = lockAmt;
        j.status = Status.Assigned;
        emit JobAssigned(jobId, msg.sender, lockAmt);
    }

    function submitResult(uint256 jobId, string calldata resultURI) external {
        Job storage j = jobs[jobId];
        if (msg.sender != j.provider) revert NotAllowed();
        if (j.status != Status.Assigned || block.timestamp > j.deadline) revert InvalidState();
        if (bytes(resultURI).length == 0) revert InvalidParams();
        j.resultURI = resultURI;
        j.status = Status.Completed;
        j.challengeDeadline = uint64(block.timestamp + params.challengePeriod);
        emit JobCompleted(jobId, resultURI, j.challengeDeadline);
    }

    function finalizeJob(uint256 jobId) external nonReentrant {
        Job storage j = jobs[jobId];
        if (j.status != Status.Completed) revert InvalidState();
        if (block.timestamp <= j.challengeDeadline) revert TooEarly();
        _payProvider(jobId, j);
    }

    function cancelJob(uint256 jobId) external nonReentrant {
        Job storage j = jobs[jobId];
        if (msg.sender != j.creator) revert NotAllowed();
        if (j.status != Status.Open) revert InvalidState();
        j.status = Status.Cancelled;
        uint256 amount = j.budget;
        j.budget = 0;
        superToken.safeTransfer(j.creator, amount);
        emit JobCancelled(jobId);
    }

    function reclaimExpired(uint256 jobId) external nonReentrant {
        Job storage j = jobs[jobId];
        if (msg.sender != j.creator) revert NotAllowed();
        if (j.status != Status.Assigned || block.timestamp <= j.deadline) revert InvalidState();
        _unlockProvider(j);
        _refundCreator(jobId, j);
    }

    // ------------------------------------------------------------------
    // Contestation : commit-reveal du seed puis tirage du comité (H-01)
    // ------------------------------------------------------------------
    /// @param seedCommit keccak256(abi.encode(seed)) — le seed sera révélé après seedRevealDelay
    function challengeJob(uint256 jobId, bytes32 seedCommit) external nonReentrant {
        Job storage j = jobs[jobId];
        if (j.status != Status.Completed) revert InvalidState();
        if (block.timestamp > j.challengeDeadline) revert TooLate();
        if (msg.sender == j.provider) revert NotAllowed();
        if (seedCommit == bytes32(0)) revert BadCommit();

        Params memory p = params;
        uint256 bond = p.challengeBond;
        superToken.safeTransferFrom(msg.sender, address(this), bond);

        Dispute storage d = disputes[jobId];
        d.challenger = msg.sender;
        d.bond = bond;
        d.seedCommit = seedCommit;
        d.commitBlock = uint64(block.number);
        d.seedRevealEarliest = uint64(block.timestamp + p.seedRevealDelay);
        d.seedRevealDeadline = uint64(block.timestamp + p.seedRevealWindow);
        d.verifierPenalty = p.verifierPenalty;
        d.slashVerifierBps = p.slashVerifierBps;
        d.slashChallengerBps = p.slashChallengerBps;
        d.committeeSelected = false;

        j.status = Status.Disputed;
        emit JobChallenged(jobId, msg.sender, bond, seedCommit, d.seedRevealDeadline);
    }

    /// @notice Révèle le seed et tire le comité. Aléa = keccak(seed, blockhash(commitBlock+1), jobId).
    ///         Sert aussi au tirage du comité d'appel (FIX-2b) : c'est alors l'appelant qui révèle.
    function revealCommittee(uint256 jobId, bytes32 seed) external nonReentrant {
        Job storage j = jobs[jobId];
        Dispute storage d = disputes[jobId];
        DisputeExt storage x = disputeExt[jobId];
        if (j.status != Status.Disputed || d.committeeSelected) revert InvalidState();
        bool isAppeal = x.appellant != address(0);
        if (msg.sender != (isAppeal ? x.appellant : d.challenger)) revert NotAllowed();
        if (block.timestamp < d.seedRevealEarliest) revert TooEarly();
        if (block.timestamp > d.seedRevealDeadline) revert TooLate();
        if (keccak256(abi.encode(seed)) != d.seedCommit) revert BadCommit();

        bytes32 bh = blockhash(uint256(d.commitBlock) + 1);
        // HARDENING-01 : plus de repli manipulable sur blockhash(block.number - 1).
        if (bh == bytes32(0)) revert TooLate();
        bytes32 rnd = keccak256(abi.encode(seed, bh, jobId));
        x.random = rnd;

        uint256 k = params.committeeSize;
        if (isAppeal) {
            // FIX-2b : le 1er comité est conservé à part ; ses votes restent dans memberVote
            // (adresses disjointes du comité d'appel), il est réglé au verdict final.
            address[] storage first = _committees[jobId];
            for (uint256 i = 0; i < first.length; ++i) _firstCommittees[jobId].push(first[i]);
            delete _committees[jobId];
            d.votesValid = 0;
            d.votesInvalid = 0;
            x.appealSelected = true;
            k = securityParams.appealCommitteeSize;
        }
        _draw(jobId, j, d, uint256(rnd), k);

        Params memory p = params;
        d.committeeSelected = true;
        d.voteCommitDeadline = uint64(block.timestamp + p.voteCommitWindow);
        j.disputeDeadline = uint64(block.timestamp + p.voteCommitWindow + p.voteRevealWindow);
        if (isAppeal) emit AppealCommitteeSelected(jobId, _committees[jobId]);
        emit CommitteeSelected(jobId, _committees[jobId], d.voteCommitDeadline, j.disputeDeadline);
    }

    /// @dev Ajoute jusqu'à `k` membres au comité courant. Exclut les parties, tout membre déjà tiré
    ///      ou exclu sur ce litige (memberVote != 0) et les cautions < requiredVerifierBond (FIX-2a).
    function _draw(uint256 jobId, Job storage j, Dispute storage d, uint256 rnd, uint256 k) internal {
        uint256 n = verifierList.length;
        if (n == 0) return;
        uint256 minBond = requiredVerifierBond(j.budget);
        address[] storage committee = _committees[jobId];
        uint256 target = committee.length + k;
        uint256 start = rnd % n;
        for (uint256 i = 0; i < n && committee.length < target; ++i) {
            address v = verifierList[(start + i) % n];
            if (v == j.creator || v == j.provider || v == d.challenger) continue;
            if (memberVote[jobId][v] != 0) continue;
            if (verifiers[v].bond < minBond) continue;
            committee.push(v);
            memberVote[jobId][v] = 1;
            verifiers[v].duties += 1;
        }
    }

    // ------------------------------------------------------------------
    // FIX-1 : délai de révélation dépassé -> slash des non-révélateurs + re-tirage sans eux
    // ------------------------------------------------------------------
    function rerollNonRevealers(uint256 jobId) external nonReentrant {
        Job storage j = jobs[jobId];
        Dispute storage d = disputes[jobId];
        DisputeExt storage x = disputeExt[jobId];
        if (j.status != Status.Disputed || !d.committeeSelected) revert InvalidState();
        if (_isFrozen(x)) revert Frozen();
        if (block.timestamp <= j.disputeDeadline) revert TooEarly();
        (bool decided,) = majorityOf(jobId);
        if (decided) revert HasMajority();
        if (x.rerolls >= securityParams.maxRerolls) revert InvalidState();

        address[] storage committee = _committees[jobId];
        address[] memory removed = new address[](committee.length);
        uint256 nRemoved;
        uint256 toBurn;
        uint256 i;
        while (i < committee.length) {
            address v = committee[i];
            uint8 mv = memberVote[jobId][v];
            if (mv == 1 || mv == 2) {
                memberVote[jobId][v] = 5; // exclu définitivement de ce litige
                verifiers[v].duties -= 1;
                lastDutyEnd[v] = uint64(block.timestamp);
                toBurn += _penalize(jobId, v, d.verifierPenalty);
                removed[nRemoved++] = v;
                committee[i] = committee[committee.length - 1];
                committee.pop();
            } else {
                ++i;
            }
        }
        if (nRemoved == 0) revert InvalidState();
        assembly ("memory-safe") { mstore(removed, nRemoved) }

        x.rerolls += 1;
        // Aléa : aléa du tirage initial + compteur + blockhash courant (n'importe qui peut appeler).
        uint256 rnd = uint256(keccak256(abi.encode(x.random, x.rerolls, blockhash(block.number - 1))));
        _draw(jobId, j, d, rnd, nRemoved);

        Params memory p = params;
        d.voteCommitDeadline = uint64(block.timestamp + p.voteCommitWindow);
        j.disputeDeadline = uint64(block.timestamp + p.voteCommitWindow + p.voteRevealWindow);
        _burn(toBurn);
        emit CommitteeRerolled(jobId, removed, committee, d.voteCommitDeadline, j.disputeDeadline);
    }

    // ------------------------------------------------------------------
    // FIX-2b : appel (un seul tour) — la partie perdante dépose une caution plus élevée,
    // un comité plus large (appealCommitteeSize) est tiré par commit-reveal.
    // ------------------------------------------------------------------
    function appeal(uint256 jobId, bytes32 seedCommit) external nonReentrant {
        Job storage j = jobs[jobId];
        Dispute storage d = disputes[jobId];
        DisputeExt storage x = disputeExt[jobId];
        SecurityParams memory sp = securityParams;
        if (sp.appealWindow == 0) revert InvalidState();
        if (j.status != Status.Disputed || !d.committeeSelected || x.appellant != address(0)) revert InvalidState();
        if (_isFrozen(x)) revert Frozen();
        if (block.timestamp <= j.disputeDeadline) revert TooEarly();
        if (block.timestamp > uint256(j.disputeDeadline) + sp.appealWindow) revert TooLate();
        if (seedCommit == bytes32(0)) revert BadCommit();
        (bool decided, bool providerValid) = majorityOf(jobId);
        if (!decided) revert NoMajority();
        // perdant : fournisseur si travail jugé invalide ; sinon contestataire ou créateur
        if (providerValid) {
            if (msg.sender != d.challenger && msg.sender != j.creator) revert NotAllowed();
        } else if (msg.sender != j.provider) {
            revert NotAllowed();
        }
        uint256 bond = appealBondFor(jobId);
        superToken.safeTransferFrom(msg.sender, address(this), bond);

        x.appellant = msg.sender;
        x.appealBond = bond;
        x.firstVerdictValid = providerValid;
        d.seedCommit = seedCommit;
        d.commitBlock = uint64(block.number);
        d.seedRevealEarliest = uint64(block.timestamp + params.seedRevealDelay);
        d.seedRevealDeadline = uint64(block.timestamp + params.seedRevealWindow);
        d.committeeSelected = false;
        emit AppealFiled(jobId, msg.sender, bond, seedCommit, d.seedRevealDeadline);
    }

    // ------------------------------------------------------------------
    // FIX-3 : gel d'un litige suspect par le gardien (borné à MAX_DISPUTE_FREEZE, une fois par litige).
    // Pendant le gel : pas de résolution/re-tirage/appel ; l'arbitre (Timelock) peut trancher.
    // ------------------------------------------------------------------
    function freezeDispute(uint256 jobId) external onlyRole(PAUSER_ROLE) {
        DisputeExt storage x = disputeExt[jobId];
        if (jobs[jobId].status != Status.Disputed || x.freezeUsed) revert InvalidState();
        x.freezeUsed = true;
        x.frozenUntil = uint64(block.timestamp + MAX_DISPUTE_FREEZE);
        emit DisputeFrozen(jobId, x.frozenUntil);
    }

    function unfreezeDispute(uint256 jobId) external {
        if (!hasRole(PAUSER_ROLE, msg.sender) && !hasRole(ARBITER_ROLE, msg.sender)) revert NotAllowed();
        disputeExt[jobId].frozenUntil = 0;
        emit DisputeUnfrozen(jobId);
    }

    function _isFrozen(DisputeExt storage x) internal view returns (bool) {
        return block.timestamp < x.frozenUntil;
    }

    /// @notice Seed non révélé à temps : caution brûlée, job repasse en Completed (finalisable).
    function expireUnrevealedChallenge(uint256 jobId) external nonReentrant {
        Job storage j = jobs[jobId];
        Dispute storage d = disputes[jobId];
        if (j.status != Status.Disputed || d.committeeSelected) revert InvalidState();
        if (block.timestamp <= d.seedRevealDeadline) revert TooEarly();
        DisputeExt storage x = disputeExt[jobId];
        if (x.appellant != address(0)) {
            // FIX-2b : l'appelant n'a pas révélé -> appel échoué, verdict du 1er comité appliqué
            if (_isFrozen(x)) revert Frozen();
            d.committeeSelected = true;
            _settle(jobId, j, x.firstVerdictValid, false);
            return;
        }
        uint256 bond = d.bond;
        d.bond = 0;
        j.status = Status.Completed;
        // HARDENING-02 : -1 pour qu'une nouvelle contestation dans le même bloc soit impossible
        // (finalizeJob exige timestamp > challengeDeadline, challengeJob exige timestamp <= challengeDeadline).
        j.challengeDeadline = uint64(block.timestamp - 1); // finalisable immédiatement
        _burn(bond);
        emit ChallengeExpired(jobId, d.challenger, bond);
    }

    // ------------------------------------------------------------------
    // Votes commit-reveal (M-01)
    // ------------------------------------------------------------------
    /// @param commitHash keccak256(abi.encode(providerValid, salt, msg.sender, jobId))
    function commitVote(uint256 jobId, bytes32 commitHash) external {
        Job storage j = jobs[jobId];
        Dispute storage d = disputes[jobId];
        if (j.status != Status.Disputed || !d.committeeSelected) revert InvalidState();
        if (block.timestamp > d.voteCommitDeadline) revert TooLate();
        if (memberVote[jobId][msg.sender] != 1) revert NotAllowed();
        if (commitHash == bytes32(0)) revert BadCommit();
        voteCommits[jobId][msg.sender] = commitHash;
        memberVote[jobId][msg.sender] = 2;
        emit VoteCommitted(jobId, msg.sender, commitHash);
    }

    function revealVote(uint256 jobId, bool providerValid, bytes32 salt) external {
        Job storage j = jobs[jobId];
        Dispute storage d = disputes[jobId];
        if (j.status != Status.Disputed || !d.committeeSelected) revert InvalidState();
        if (block.timestamp <= d.voteCommitDeadline) revert TooEarly();
        if (block.timestamp > j.disputeDeadline) revert TooLate();
        if (memberVote[jobId][msg.sender] != 2) revert NotAllowed();
        bytes32 expected = keccak256(abi.encode(providerValid, salt, msg.sender, jobId));
        if (expected != voteCommits[jobId][msg.sender]) revert BadCommit();
        if (providerValid) {
            memberVote[jobId][msg.sender] = 3;
            d.votesValid += 1;
        } else {
            memberVote[jobId][msg.sender] = 4;
            d.votesInvalid += 1;
        }
        emit VoteCast(jobId, msg.sender, providerValid);
    }

    function majorityOf(uint256 jobId) public view returns (bool decided, bool providerValid) {
        uint256 k = _committees[jobId].length;
        if (k == 0) return (false, false);
        uint256 majority = k / 2 + 1;
        Dispute storage d = disputes[jobId];
        if (d.votesValid >= majority) return (true, true);
        if (d.votesInvalid >= majority) return (true, false);
        return (false, false);
    }

    function resolveDispute(uint256 jobId) external nonReentrant {
        Job storage j = jobs[jobId];
        Dispute storage d = disputes[jobId];
        if (j.status != Status.Disputed || !d.committeeSelected) revert InvalidState();
        DisputeExt storage x = disputeExt[jobId];
        if (_isFrozen(x)) revert Frozen();
        bool allRevealed = uint256(d.votesValid) + d.votesInvalid == _committees[jobId].length;
        (bool decided, bool providerValid) = majorityOf(jobId);
        if (x.appealSelected) {
            // Tour d'appel : sans majorité à l'échéance, le verdict initial est maintenu.
            if (!allRevealed && block.timestamp <= j.disputeDeadline) revert TooEarly();
            if (!decided) {
                if (block.timestamp <= j.disputeDeadline) revert NoMajority();
                providerValid = x.firstVerdictValid;
            }
        } else {
            uint256 aw = securityParams.appealWindow;
            if (aw > 0) {
                if (block.timestamp <= uint256(j.disputeDeadline) + aw) revert TooEarly();
            } else if (!allRevealed && block.timestamp <= j.disputeDeadline) {
                revert TooEarly();
            }
            if (!decided) revert NoMajority();
        }
        _settle(jobId, j, providerValid, false);
    }

    function arbitrate(uint256 jobId, bool providerValid) external nonReentrant onlyRole(ARBITER_ROLE) {
        Job storage j = jobs[jobId];
        Dispute storage d = disputes[jobId];
        if (j.status != Status.Disputed) revert InvalidState();
        DisputeExt storage x = disputeExt[jobId];
        if (_isFrozen(x)) {
            // FIX-3 : litige gelé (votes suspects) -> l'arbitre Timelock peut trancher à tout moment
            if (x.appellant != address(0) && !d.committeeSelected) d.committeeSelected = true;
            _settle(jobId, j, providerValid, true);
            return;
        }
        if (x.appellant != address(0)) revert InvalidState(); // appel : résolu par resolveDispute/expire
        // comité non sélectionné : autoriser après seedRevealDeadline
        if (!d.committeeSelected) {
            if (block.timestamp <= d.seedRevealDeadline) revert TooEarly();
            if (block.timestamp > uint256(d.seedRevealDeadline) + params.arbitrationWindow) revert TooLate();
        } else {
            if (block.timestamp <= j.disputeDeadline) revert TooEarly();
            if (block.timestamp > uint256(j.disputeDeadline) + params.arbitrationWindow) revert TooLate();
            (bool decided,) = majorityOf(jobId);
            if (decided) revert HasMajority();
        }
        _settle(jobId, j, providerValid, true);
    }

    function resolveStale(uint256 jobId) external nonReentrant {
        Job storage j = jobs[jobId];
        Dispute storage d = disputes[jobId];
        if (j.status != Status.Disputed) revert InvalidState();
        DisputeExt storage x = disputeExt[jobId];
        if (x.appellant != address(0) || _isFrozen(x)) revert InvalidState();
        uint256 base = d.committeeSelected ? uint256(j.disputeDeadline) : uint256(d.seedRevealDeadline);
        if (block.timestamp <= base + params.arbitrationWindow) revert TooEarly();
        if (d.committeeSelected) {
            (bool decided,) = majorityOf(jobId);
            if (decided) revert HasMajority();
        }
        address[] storage committee = _committees[jobId];
        uint256 toBurn;
        for (uint256 i = 0; i < committee.length; ++i) {
            address v = committee[i];
            verifiers[v].duties -= 1;
            lastDutyEnd[v] = uint64(block.timestamp);
            // pas de reveal (1 ou 2) = absent
            uint8 mv = memberVote[jobId][v];
            if (mv == 1 || mv == 2) toBurn += _penalize(jobId, v, d.verifierPenalty);
        }
        _unlockProvider(j);
        uint256 bond = d.bond;
        d.bond = 0;
        if (bond > 0) superToken.safeTransfer(d.challenger, bond);
        _refundCreator(jobId, j);
        _burn(toBurn);
    }

    function _settle(uint256 jobId, Job storage j, bool providerValid, bool byArbiter) internal {
        Dispute storage d = disputes[jobId];
        DisputeExt storage x = disputeExt[jobId];
        uint8 winningVote = providerValid ? 3 : 4;

        // Règle le comité courant et, en cas d'appel tiré, le 1er comité (FIX-2b).
        (uint256 winners, uint256 toBurn) = _settleCommittee(jobId, _committees[jobId], winningVote, d.verifierPenalty);
        if (x.appealSelected) {
            (uint256 w2, uint256 b2) = _settleCommittee(jobId, _firstCommittees[jobId], winningVote, d.verifierPenalty);
            winners += w2;
            toBurn += b2;
        }

        uint256 bond = d.bond;
        d.bond = 0;
        uint256 verifierPool;

        // FIX-2b : caution d'appel -> vérificateurs gagnants si l'appel échoue, rendue sinon.
        uint256 aBond = x.appealBond;
        if (aBond > 0) {
            x.appealBond = 0;
            bool overturned = providerValid != x.firstVerdictValid;
            if (overturned) superToken.safeTransfer(x.appellant, aBond);
            else if (winners > 0) verifierPool += aBond;
            else toBurn += aBond;
            emit AppealSettled(jobId, overturned, aBond);
        }

        if (providerValid) {
            if (winners > 0) verifierPool += bond;
            else if (bond > 0) superToken.safeTransfer(j.provider, bond);
            emit DisputeResolved(jobId, true, byArbiter);
            _payProvider(jobId, j);
        } else {
            if (bond > 0) superToken.safeTransfer(d.challenger, bond);
            uint256 slashAmt = j.lockedStake;
            j.lockedStake = 0;
            if (slashAmt > 0) {
                staking.slash(j.provider, slashAmt);
                uint256 toChallenger = (slashAmt * d.slashChallengerBps) / BPS;
                uint256 toVerifiers = winners > 0 ? (slashAmt * d.slashVerifierBps) / BPS : 0;
                uint256 burnedSlash = slashAmt - toChallenger - toVerifiers;
                if (toChallenger > 0) superToken.safeTransfer(d.challenger, toChallenger);
                verifierPool += toVerifiers;
                toBurn += burnedSlash;
                emit ProviderSlashed(jobId, j.provider, slashAmt, burnedSlash);
            }
            emit DisputeResolved(jobId, false, byArbiter);
            _refundCreator(jobId, j);
        }

        if (verifierPool > 0) toBurn += _payVerifiers(jobId, winningVote, verifierPool, winners);
        _burn(toBurn);
    }

    function _settleCommittee(uint256 jobId, address[] storage committee, uint8 winningVote, uint256 penalty)
        internal returns (uint256 winners, uint256 toBurn)
    {
        for (uint256 i = 0; i < committee.length; ++i) {
            address v = committee[i];
            verifiers[v].duties -= 1;
            lastDutyEnd[v] = uint64(block.timestamp);
            if (memberVote[jobId][v] == winningVote) {
                winners++;
            } else {
                // minoritaire, absent, ou commit non révélé
                toBurn += _penalize(jobId, v, penalty);
            }
        }
    }

    function _payVerifiers(uint256 jobId, uint8 winningVote, uint256 pool, uint256 winners) internal returns (uint256) {
        uint256 share = pool / winners;
        _payList(jobId, _committees[jobId], winningVote, share);
        if (disputeExt[jobId].appealSelected) _payList(jobId, _firstCommittees[jobId], winningVote, share);
        return pool - share * winners;
    }

    function _payList(uint256 jobId, address[] storage committee, uint8 winningVote, uint256 share) internal {
        for (uint256 i = 0; i < committee.length; ++i) {
            address v = committee[i];
            if (memberVote[jobId][v] == winningVote) superToken.safeTransfer(v, share);
        }
    }

    function _penalize(uint256 jobId, address v, uint256 penalty) internal returns (uint256 p) {
        VerifierInfo storage info = verifiers[v];
        p = penalty;
        if (p > info.bond) p = info.bond;
        if (p == 0) return 0;
        info.bond -= p;
        staking.slash(v, p);
        emit VerifierPenalized(jobId, v, p);
        if (info.indexPlus1 != 0 && info.bond < params.minVerifierStake) _removeFromList(v);
    }

    function _payProvider(uint256 jobId, Job storage j) internal {
        uint256 budget = j.budget;
        j.budget = 0;
        j.status = Status.Finalized;
        _unlockProvider(j);

        uint256 fee = (budget * j.feeBps) / BPS;
        uint256 burned = (fee * j.burnShareBps) / BPS;
        uint256 toStakers = fee - burned;
        uint256 payout = budget - fee;

        superToken.safeTransfer(j.provider, payout);
        _burn(burned);
        if (toStakers > 0) {
            superToken.forceApprove(address(staking), toStakers);
            staking.depositRewards(toStakers);
        }
        emit JobFinalized(jobId, j.provider, payout, fee, burned, toStakers);
    }

    function _unlockProvider(Job storage j) internal {
        uint256 amt = j.lockedStake;
        if (amt > 0) {
            j.lockedStake = 0;
            staking.unlock(j.provider, amt);
        }
    }

    function _refundCreator(uint256 jobId, Job storage j) internal {
        uint256 amount = j.budget;
        j.budget = 0;
        j.status = Status.Refunded;
        superToken.safeTransfer(j.creator, amount);
        emit JobRefunded(jobId, j.creator, amount);
    }

    function _burn(uint256 amount) internal {
        if (amount > 0) {
            superToken.burn(amount);
            emit Burned(amount);
        }
    }
}
