// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @notice TEST ONLY — token hostile qui tente une ré-entrée lors de chaque transfert.
contract ReentrantToken is ERC20 {
    address public target;
    bytes public payload;
    bool public armed;
    bool public lastOk;
    uint256 public attempts;

    constructor() ERC20("Evil", "EVIL") {}

    function mint(address to, uint256 v) external { _mint(to, v); }
    function burn(uint256 v) external { _burn(msg.sender, v); }
    function selfApprove(address spender, uint256 v) external { _approve(address(this), spender, v); }
    function arm(address t, bytes calldata p) external { target = t; payload = p; armed = true; }

    function exec(address t, bytes calldata d) external returns (bytes memory) {
        (bool ok, bytes memory r) = t.call(d);
        require(ok, "exec failed");
        return r;
    }

    function _update(address from, address to, uint256 v) internal override {
        super._update(from, to, v);
        if (armed) {
            armed = false;
            attempts++;
            (lastOk,) = target.call(payload);
        }
    }
}
