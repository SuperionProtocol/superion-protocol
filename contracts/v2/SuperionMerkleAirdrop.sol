// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/utils/cryptography/MerkleProof.sol";

/**
 * @title SuperionMerkleAirdrop — V2.1
 * @notice Airdrop Merkle (OZ StandardMerkleTree). V2.1 : treasury ≠ 0, amount > 0 (L-04).
 */
contract SuperionMerkleAirdrop {
    using SafeERC20 for IERC20;

    IERC20 public immutable token;
    bytes32 public immutable merkleRoot;
    uint256 public immutable claimDeadline;
    address public immutable treasury;
    mapping(address => bool) public claimed;

    event Claimed(address indexed account, uint256 amount);
    event Swept(uint256 amount);

    error AlreadyClaimed();
    error InvalidProof();
    error ClaimClosed();
    error ClaimOpen();
    error ZeroAddress();
    error ZeroAmount();

    constructor(address _token, bytes32 _root, uint256 _claimDeadline, address _treasury) {
        if (_token == address(0) || _treasury == address(0)) revert ZeroAddress();
        token = IERC20(_token);
        merkleRoot = _root;
        claimDeadline = _claimDeadline;
        treasury = _treasury;
    }

    function claim(address account, uint256 amount, bytes32[] calldata proof) external {
        if (block.timestamp > claimDeadline) revert ClaimClosed();
        if (amount == 0) revert ZeroAmount();
        if (claimed[account]) revert AlreadyClaimed();
        bytes32 leaf = keccak256(bytes.concat(keccak256(abi.encode(account, amount))));
        if (!MerkleProof.verifyCalldata(proof, merkleRoot, leaf)) revert InvalidProof();
        claimed[account] = true;
        token.safeTransfer(account, amount);
        emit Claimed(account, amount);
    }

    function sweep() external {
        if (block.timestamp <= claimDeadline) revert ClaimOpen();
        uint256 bal = token.balanceOf(address(this));
        token.safeTransfer(treasury, bal);
        emit Swept(bal);
    }
}
