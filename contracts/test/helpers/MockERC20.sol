// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @dev Plain mock ERC-20 with open mint/burn for test fixtures.
contract MockERC20 is ERC20 {
    uint8 private immutable _dec;

    constructor(string memory name_, string memory symbol_, uint8 dec_) ERC20(name_, symbol_) {
        _dec = dec_;
    }

    function decimals() public view override returns (uint8) {
        return _dec;
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    /// @dev Unrestricted burn used to simulate a token-balance deficit in a holder.
    function burn(address from, uint256 amount) external {
        _burn(from, amount);
    }
}

/// @dev Mock whose symbol/decimals live in immutables (i.e. in runtime code), so `vm.etch`
///      of its runtime code to another address preserves them although storage is not copied.
contract MockEtchableToken is ERC20 {
    bytes32 private immutable _sym;
    uint8 private immutable _symLen;
    uint8 private immutable _dec;

    constructor(bytes32 sym_, uint8 symLen_, uint8 dec_) ERC20("Etchable", "ETCH") {
        _sym = sym_;
        _symLen = symLen_;
        _dec = dec_;
    }

    function symbol() public view override returns (string memory) {
        bytes memory out = new bytes(_symLen);
        bytes32 s = _sym;
        for (uint256 i; i < _symLen; ++i) out[i] = s[i];
        return string(out);
    }

    function decimals() public view override returns (uint8) {
        return _dec;
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}
