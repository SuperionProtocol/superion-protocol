// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/// @notice Interface minimale du token SUPER existant (ERC20 + ERC20Burnable).
interface ISuperToken is IERC20 {
    function burn(uint256 value) external;
}
