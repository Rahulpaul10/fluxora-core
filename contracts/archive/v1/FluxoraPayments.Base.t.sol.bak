// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Test} from "forge-std/Test.sol";
import {FluxoraPayments} from "../src/FluxoraPayments.sol";
import {MockERC20} from "./helpers/MockERC20.sol";

abstract contract FluxoraPaymentsTestBase is Test {
    FluxoraPayments internal pay;
    MockERC20 internal usdc;
    MockERC20 internal tokenB;
    address internal admin = makeAddr("admin");
    address internal pauser = makeAddr("pauser");
    address internal collector = makeAddr("collector");
    address internal alice = makeAddr("alice");
    address internal bob = makeAddr("bob");
    address internal carol = makeAddr("carol");

    uint256 internal constant START = 1_000e6;

    function setUp() public virtual {
        vm.warp(1_700_000_000);
        usdc = new MockERC20("USD Coin", "USDC", 6);
        tokenB = new MockERC20("Token B", "TKB", 6);
        address[] memory tokens = new address[](1);
        tokens[0] = address(usdc);
        pay = new FluxoraPayments(admin, pauser, tokens);
        usdc.mint(alice, START);
        usdc.mint(bob, START);
        tokenB.mint(alice, START);
        vm.prank(alice);
        usdc.approve(address(pay), type(uint256).max);
        vm.prank(bob);
        usdc.approve(address(pay), type(uint256).max);
        vm.prank(alice);
        tokenB.approve(address(pay), type(uint256).max);
    }

    function _setFee(uint256 bps) internal {
        vm.startPrank(admin);
        pay.setFeeRecipient(collector);
        pay.setFeeBps(bps);
        vm.stopPrank();
    }
}
