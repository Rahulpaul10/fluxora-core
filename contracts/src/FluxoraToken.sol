// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {ERC20Burnable} from "@openzeppelin/contracts/token/ERC20/extensions/ERC20Burnable.sol";
import {ERC20Permit} from "@openzeppelin/contracts/token/ERC20/extensions/ERC20Permit.sol";

uint256 constant FLUXORA_INITIAL_SUPPLY = 1_000_000_000e18;

/// @title FLUXORA token
/// @notice One billion FLUX are minted once. No administrator or further minting exists.
/// @dev Plain ERC-20 with burn and EIP-2612 permit. No voting or delegation.
/// @custom:upgrade-strategy Direct, non-upgradeable deployment (no proxy).
/// @dev Code changes require a replacement deployment and migration.
contract FluxoraToken is ERC20, ERC20Burnable, ERC20Permit {
    uint256 public constant INITIAL_SUPPLY = FLUXORA_INITIAL_SUPPLY;
    error ZeroInitialHolder();

    constructor(address initialHolder) ERC20("FLUXORA", "FLUX") ERC20Permit("FLUXORA") {
        if (initialHolder == address(0)) revert ZeroInitialHolder();
        _mint(initialHolder, INITIAL_SUPPLY);
    }
}
