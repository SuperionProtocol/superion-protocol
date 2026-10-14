// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/access/Ownable.sol";

/**
 * @title SuperFaucet — TESTNET UNIQUEMENT (Base Sepolia)
 * @notice Distribue des SUPER de test, sans valeur : `dripAmount` par adresse et par `cooldown`.
 *         Le propriétaire peut régler les montants, recharger (`refill`) ou retirer (`withdraw`).
 *         Aucune vente, aucun prix : n'importe qui peut aussi recharger par simple transfert.
 */
contract SuperFaucet is Ownable {
    using SafeERC20 for IERC20;

    uint256 public constant MAX_DRIP = 10_000 ether;
    uint256 public constant MIN_COOLDOWN = 1 hours;
    uint256 public constant MAX_COOLDOWN = 30 days;

    IERC20 public immutable token;
    uint256 public dripAmount;
    uint256 public cooldown;
    mapping(address => uint256) public lastDrip;
    uint256 public totalDripped;

    event Dripped(address indexed to, uint256 amount);
    event Refilled(address indexed from, uint256 amount);
    event Withdrawn(address indexed to, uint256 amount);
    event ParamsUpdated(uint256 dripAmount, uint256 cooldown);

    error CooldownActive(uint256 availableAt);
    error FaucetEmpty();
    error InvalidParams();

    constructor(address _token, address _owner, uint256 _dripAmount, uint256 _cooldown) Ownable(_owner) {
        if (_token == address(0)) revert InvalidParams();
        token = IERC20(_token);
        _setParams(_dripAmount, _cooldown);
    }

    /// @notice Horodatage à partir duquel `user` peut de nouveau recevoir (0 = tout de suite).
    function nextDripAt(address user) public view returns (uint256) {
        uint256 last = lastDrip[user];
        return last == 0 ? 0 : last + cooldown;
    }

    function canDrip(address user) external view returns (bool) {
        return block.timestamp >= nextDripAt(user) && token.balanceOf(address(this)) >= dripAmount;
    }

    function balance() external view returns (uint256) {
        return token.balanceOf(address(this));
    }

    /// @notice Envoie `dripAmount` SUPER de test à l'appelant (une fois par `cooldown`).
    function drip() external {
        uint256 next = nextDripAt(msg.sender);
        if (block.timestamp < next) revert CooldownActive(next);
        uint256 amount = dripAmount;
        if (token.balanceOf(address(this)) < amount) revert FaucetEmpty();
        lastDrip[msg.sender] = block.timestamp;
        totalDripped += amount;
        token.safeTransfer(msg.sender, amount);
        emit Dripped(msg.sender, amount);
    }

    /// @notice Recharge via transferFrom (approve préalable). Un simple transfert marche aussi.
    function refill(uint256 amount) external {
        if (amount == 0) revert InvalidParams();
        token.safeTransferFrom(msg.sender, address(this), amount);
        emit Refilled(msg.sender, amount);
    }

    function withdraw(address to, uint256 amount) external onlyOwner {
        if (to == address(0)) revert InvalidParams();
        token.safeTransfer(to, amount);
        emit Withdrawn(to, amount);
    }

    function setParams(uint256 _dripAmount, uint256 _cooldown) external onlyOwner {
        _setParams(_dripAmount, _cooldown);
    }

    function _setParams(uint256 _dripAmount, uint256 _cooldown) internal {
        if (_dripAmount == 0 || _dripAmount > MAX_DRIP || _cooldown < MIN_COOLDOWN || _cooldown > MAX_COOLDOWN) {
            revert InvalidParams();
        }
        dripAmount = _dripAmount;
        cooldown = _cooldown;
        emit ParamsUpdated(_dripAmount, _cooldown);
    }
}
