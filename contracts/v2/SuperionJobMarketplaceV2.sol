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

    error InvalidParams();
    error InvalidState();
    error NotAllowed();
    error NoMajority();
    error HasMajority();
    error TooEarly();
    error TooLate();
    error VerifierCapReached();
    error BadCommit();

    constructor(address _superToken, address _staking, address admin, address pauser, address arbiter, Params memory p) {
        superToken = ISuperToken(_superToken);
        staking = IStakingV2(_staking);
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        if (pauser != address(0)) _grantRole(PAUSER_ROLE, pauser);
        if (arbiter != address(0)) _grantRole(ARBITER_ROLE, arbiter);
        _setParams(p);
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
    function revealCommittee(uint256 jobId, bytes32 seed) external nonReentrant {
        Job storage j = jobs[jobId];
        Dispute storage d = disputes[jobId];
        if (j.status != Status.Disputed || d.committeeSelected) revert InvalidState();
        if (msg.sender != d.challenger) revert NotAllowed();
        if (block.timestamp < d.seedRevealEarliest) revert TooEarly();
        if (block.timestamp > d.seedRevealDeadline) revert TooLate();
        if (keccak256(abi.encode(seed)) != d.seedCommit) revert BadCommit();

        bytes32 bh = blockhash(uint256(d.commitBlock) + 1);
        // HARDENING-01 : plus de repli manipulable sur blockhash(block.number - 1).
        if (bh == bytes32(0)) revert TooLate();
        uint256 n = verifierList.length;
        uint256 k = params.committeeSize;
        uint256 minStake = params.minVerifierStake;
        address[] storage committee = _committees[jobId];

        if (n > 0) {
            uint256 start = uint256(keccak256(abi.encode(seed, bh, jobId))) % n;
            for (uint256 i = 0; i < n && committee.length < k; ++i) {
                address v = verifierList[(start + i) % n];
                if (v == j.creator || v == j.provider || v == d.challenger) continue;
                if (verifiers[v].bond < minStake) continue;
                committee.push(v);
                memberVote[jobId][v] = 1;
                verifiers[v].duties += 1;
            }
        }

        Params memory p = params;
        d.committeeSelected = true;
        d.voteCommitDeadline = uint64(block.timestamp + p.voteCommitWindow);
        j.disputeDeadline = uint64(block.timestamp + p.voteCommitWindow + p.voteRevealWindow);
        emit CommitteeSelected(jobId, committee, d.voteCommitDeadline, j.disputeDeadline);
    }

    /// @notice Seed non révélé à temps : caution brûlée, job repasse en Completed (finalisable).
    function expireUnrevealedChallenge(uint256 jobId) external nonReentrant {
        Job storage j = jobs[jobId];
        Dispute storage d = disputes[jobId];
        if (j.status != Status.Disputed || d.committeeSelected) revert InvalidState();
        if (block.timestamp <= d.seedRevealDeadline) revert TooEarly();
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
        bool allRevealed = uint256(d.votesValid) + d.votesInvalid == _committees[jobId].length;
        if (!allRevealed && block.timestamp <= j.disputeDeadline) revert TooEarly();
        (bool decided, bool providerValid) = majorityOf(jobId);
        if (!decided) revert NoMajority();
        _settle(jobId, j, providerValid, false);
    }

    function arbitrate(uint256 jobId, bool providerValid) external nonReentrant onlyRole(ARBITER_ROLE) {
        Job storage j = jobs[jobId];
        Dispute storage d = disputes[jobId];
        if (j.status != Status.Disputed) revert InvalidState();
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
        address[] storage committee = _committees[jobId];
        uint8 winningVote = providerValid ? 3 : 4;

        uint256 toBurn;
        uint256 winners;
        for (uint256 i = 0; i < committee.length; ++i) {
            address v = committee[i];
            verifiers[v].duties -= 1;
            if (memberVote[jobId][v] == winningVote) {
                winners++;
            } else {
                // minoritaire, absent, ou commit non révélé
                toBurn += _penalize(jobId, v, d.verifierPenalty);
            }
        }

        uint256 bond = d.bond;
        d.bond = 0;
        uint256 verifierPool;

        if (providerValid) {
            if (winners > 0) verifierPool = bond;
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
                verifierPool = toVerifiers;
                toBurn += burnedSlash;
                emit ProviderSlashed(jobId, j.provider, slashAmt, burnedSlash);
            }
            emit DisputeResolved(jobId, false, byArbiter);
            _refundCreator(jobId, j);
        }

        if (verifierPool > 0) toBurn += _payVerifiers(jobId, winningVote, verifierPool, winners);
        _burn(toBurn);
    }

    function _payVerifiers(uint256 jobId, uint8 winningVote, uint256 pool, uint256 winners) internal returns (uint256) {
        address[] storage committee = _committees[jobId];
        uint256 share = pool / winners;
        for (uint256 i = 0; i < committee.length; ++i) {
            address v = committee[i];
            if (memberVote[jobId][v] == winningVote) superToken.safeTransfer(v, share);
        }
        return pool - share * winners;
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
