// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/access/AccessControl.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

interface IStakingView {
    function getStake(address user) external view returns (uint256);
    function slash(address user, uint256 amount, string calldata reason) external;
}

contract JobMarketplace is AccessControl, ReentrancyGuard {
    using SafeERC20 for IERC20;
    bytes32 public constant VERIFIER_ROLE = keccak256("VERIFIER_ROLE");
    IERC20 public immutable superToken;
    IStakingView public immutable staking;

    enum JobStatus { Open, Assigned, Completed, Challenged, Finalized, Cancelled }

    struct Job {
        address creator;
        address provider;
        uint256 budget;
        uint256 createdAt;
        uint256 deadline;
        JobStatus status;
        string jobURI;
        string resultURI;
        uint256 challengeDeadline;
    }

    uint256 public nextJobId = 1;
    mapping(uint256 => Job) public jobs;
    mapping(uint256 => address) public challengerOf;
    uint256 public challengePeriod = 1 hours;

    event JobCreated(uint256 indexed jobId, address indexed creator, uint256 budget, string jobURI);
    event JobAssigned(uint256 indexed jobId, address indexed provider);
    event JobCompleted(uint256 indexed jobId, string resultURI);
    event JobChallenged(uint256 indexed jobId, address indexed challenger);
    event JobFinalized(uint256 indexed jobId, address indexed winner, uint256 amount);
    event JobCancelled(uint256 indexed jobId);
    event ProviderSlashed(uint256 indexed jobId, address indexed provider, uint256 amount);

    constructor(address _superToken, address admin, address _staking) {
        superToken = IERC20(_superToken);
        staking = IStakingView(_staking);
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(VERIFIER_ROLE, admin);
    }

    function createJob(uint256 budget, uint256 duration, string calldata jobURI) external nonReentrant returns (uint256) {
        require(budget > 0 && duration > 0 && bytes(jobURI).length > 0, "Invalid params");
        superToken.safeTransferFrom(msg.sender, address(this), budget);
        uint256 jobId = nextJobId++;
        jobs[jobId] = Job(msg.sender, address(0), budget, block.timestamp, block.timestamp + duration, JobStatus.Open, jobURI, "", 0);
        emit JobCreated(jobId, msg.sender, budget, jobURI);
        return jobId;
    }

    function assignJob(uint256 jobId) external {
        Job storage job = jobs[jobId];
        require(job.status == JobStatus.Open && block.timestamp < job.deadline, "Job not available");
        require(staking.getStake(msg.sender) >= job.budget, "Stake below job budget");
        job.provider = msg.sender;
        job.status = JobStatus.Assigned;
        emit JobAssigned(jobId, msg.sender);
    }

    function submitResult(uint256 jobId, string calldata resultURI) external {
        Job storage job = jobs[jobId];
        require(msg.sender == job.provider && job.status == JobStatus.Assigned, "Not allowed");
        job.resultURI = resultURI;
        job.status = JobStatus.Completed;
        job.challengeDeadline = block.timestamp + challengePeriod;
        emit JobCompleted(jobId, resultURI);
    }

    function challengeJob(uint256 jobId) external {
        Job storage job = jobs[jobId];
        require(job.status == JobStatus.Completed && block.timestamp <= job.challengeDeadline, "Cannot challenge");
        job.status = JobStatus.Challenged;
        challengerOf[jobId] = msg.sender;
        emit JobChallenged(jobId, msg.sender);
    }

    function finalizeJob(uint256 jobId, bool providerWins) external onlyRole(VERIFIER_ROLE) nonReentrant {
        Job storage job = jobs[jobId];
        require(job.status == JobStatus.Completed || job.status == JobStatus.Challenged, "Cannot finalize");
        uint256 amount = job.budget;
        address provider = job.provider;
        job.budget = 0;
        job.status = JobStatus.Finalized;
        address winner = providerWins ? provider : job.creator;
        superToken.safeTransfer(winner, amount);
        if (!providerWins) {
            uint256 staked = staking.getStake(provider);
            uint256 cut = staked < amount ? staked : amount;
            if (cut > 0) {
                staking.slash(provider, cut, "provider lost job");
                emit ProviderSlashed(jobId, provider, cut);
            }
        }
        emit JobFinalized(jobId, winner, amount);
    }

    function cancelJob(uint256 jobId) external nonReentrant {
        Job storage job = jobs[jobId];
        require(msg.sender == job.creator && job.status == JobStatus.Open, "Cannot cancel");
        job.status = JobStatus.Cancelled;
        uint256 amount = job.budget;
        job.budget = 0;
        superToken.safeTransfer(job.creator, amount);
        emit JobCancelled(jobId);
    }
}
