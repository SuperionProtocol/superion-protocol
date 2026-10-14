// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/finance/VestingWalletCliff.sol";

/**
 * @title SuperionVesting
 * @notice VestingWallet OZ avec cliff : rien n'est libérable avant start+cliff, puis linéaire jusqu'à
 *         start+duration (le montant cumulé depuis `start` devient libérable d'un coup au cliff).
 *         cliffSeconds = 0 => vesting linéaire simple. Le bénéficiaire (owner) peut transférer la propriété.
 */
contract SuperionVesting is VestingWalletCliff {
    string public label;

    constructor(string memory _label, address beneficiary, uint64 startTimestamp, uint64 durationSeconds, uint64 cliffSeconds)
        VestingWallet(beneficiary, startTimestamp, durationSeconds)
        VestingWalletCliff(cliffSeconds)
    {
        label = _label;
    }
}
