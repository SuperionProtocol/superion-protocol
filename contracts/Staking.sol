// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/access/AccessControl.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

contract Staking is AccessControl, ReentrancyGuard {
    using SafeERC20 for IERC20;
    bytes32 public constant SLASHER_ROLE = keccak256("SLASHER_ROLE");
    IERC20 public immutable superToken;

    struct StakeInfo {
        uint256 amount;
        uint256 stakedAt;
        uint256 unbondingAmount;
        uint256 unbondingStart;
    }

    mapping(address => StakeInfo) public stakes;
    uint256 public totalStaked;
    uint256 public constant UNBONDING_PERIOD = 7 days;

    event Staked(address indexed user, uint256 amount);
    event UnstakeRequested(address indexed user, uint256 amount);
    event Unstaked(address indexed user, uint256 amount);
    event Slashed(address indexed user, uint256 amount, string reason);

    constructor(address _superToken, address admin) {
        superToken = IERC20(_superToken);
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(SLASHER_ROLE, admin);
    }

    function stake(uint256 amount) external nonReentrant {
        require(amount > 0, "Amount must be > 0");
        superToken.safeTransferFrom(msg.sender, address(this), amount);
        stakes[msg.sender].amount += amount;
        stakes[msg.sender].stakedAt = block.timestamp;
        totalStaked += amount;
        emit Staked(msg.sender, amount);
    }

    function requestUnstake(uint256 amount) external nonReentrant {
        StakeInfo storage info = stakes[msg.sender];
        require(info.amount >= amount && amount > 0, "Invalid amount");
        info.amount -= amount;
        info.unbondingAmount += amount;
        info.unbondingStart = block.timestamp;
        totalStaked -= amount;
        emit UnstakeRequested(msg.sender, amount);
    }

    function completeUnstake() external nonReentrant {
        StakeInfo storage info = stakes[msg.sender];
        require(info.unbondingAmount > 0, "Nothing to unstake");
        require(block.timestamp >= info.unbondingStart + UNBONDING_PERIOD, "Unbonding period not finished");
        uint256 amount = info.unbondingAmount;
        info.unbondingAmount = 0;
        superToken.safeTransfer(msg.sender, amount);
        emit Unstaked(msg.sender, amount);
    }

    function slash(address user, uint256 amount, string calldata reason) external onlyRole(SLASHER_ROLE) {
        StakeInfo storage info = stakes[user];
        require(info.amount >= amount, "Insufficient stake");
        info.amount -= amount;
        totalStaked -= amount;
        superToken.safeTransfer(address(0x000000000000000000000000000000000000dEaD), amount);
        emit Slashed(user, amount, reason);
    }

    function getStake(address user) external view returns (uint256) {
        return stakes[user].amount;
    }
}