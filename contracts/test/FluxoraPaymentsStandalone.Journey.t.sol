// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Test, Vm} from "forge-std/Test.sol";
import {FluxoraPaymentsStandalone as FPS} from "../src/FluxoraPaymentsStandalone.sol";
import {FluxoraToken} from "../src/FluxoraToken.sol";
import {MockERC20} from "./helpers/MockERC20.sol";

/// @dev End-to-end "wallet user" journeys that follow the exact calls the Pay page makes (supportedTokens,
///      quoteFee, pay / createRequest / payRequest / cancelRequest, then the receipt and request lists), using
///      the real FluxoraToken (18 decimals) next to a 6-decimal USDC stand-in. The deployer is admin and pauser.
contract FluxoraPaymentsStandaloneJourneyTest is Test {
    FPS internal pay;
    MockERC20 internal usdc;
    FluxoraToken internal flux;

    address internal deployer = makeAddr("deployer");
    address internal collector = makeAddr("collector");
    address internal alice = makeAddr("alice");
    address internal bob = makeAddr("bob");

    function setUp() public {
        vm.warp(1_700_000_000);
        usdc = new MockERC20("USD Coin", "USDC", 6);
        flux = new FluxoraToken(alice); // alice holds the whole FLUX supply
        address[] memory tokens = new address[](2);
        tokens[0] = address(usdc);
        tokens[1] = address(flux);
        vm.prank(deployer);
        pay = new FPS(2 days, tokens);
        usdc.mint(alice, 1_000e6);
        usdc.mint(bob, 1_000e6);
        vm.startPrank(alice);
        usdc.approve(address(pay), type(uint256).max);
        flux.approve(address(pay), type(uint256).max);
        vm.stopPrank();
        vm.prank(bob);
        usdc.approve(address(pay), type(uint256).max);
    }

    function test_SendWithFeeThenReadReceipts() public {
        vm.startPrank(deployer);
        pay.setFeeRecipient(collector);
        pay.setFeeBps(25);
        vm.stopPrank();

        assertTrue(pay.supportedTokens(address(usdc)));
        uint256 fee = pay.quoteFee(100e6);
        assertEq(fee, 250_000);

        vm.prank(alice);
        uint256 id = pay.pay(address(usdc), bob, 100e6, bytes32("invoice-1"), "thanks", fee);

        assertEq(usdc.balanceOf(alice), 1_000e6 - 100e6 - fee, "payer pays amount plus fee");
        assertEq(usdc.balanceOf(bob), 1_000e6 + 100e6, "recipient gets exactly the amount");
        assertEq(usdc.balanceOf(collector), fee);
        assertEq(usdc.balanceOf(address(pay)), 0, "the contract never holds funds");

        FPS.Receipt memory r = pay.getReceipt(id);
        assertEq(r.payer, alice);
        assertEq(r.recipient, bob);
        assertEq(r.token, address(usdc));
        assertEq(r.amount, 100e6);
        assertEq(r.fee, fee);
        assertEq(r.requestId, 0);
        assertEq(r.ref, bytes32("invoice-1"));
        assertEq(pay.sentCount(alice), 1);
        assertEq(pay.receivedCount(bob), 1);
        assertEq(pay.getSentIds(alice, 0, 10)[0], id);
        assertEq(pay.getReceivedIds(bob, 0, 10)[0], id);
    }

    function test_FeeChangeAfterSigningNeverChargesMoreThanAccepted() public {
        vm.prank(deployer);
        pay.setFeeRecipient(collector);
        // alice accepted a fee of 0, then the admin raises it before the transaction is mined
        vm.prank(deployer);
        pay.setFeeBps(100);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(FPS.FeeTooHigh.selector, 1e6, 0));
        pay.pay(address(usdc), bob, 100e6, bytes32(0), "", 0);
        assertEq(usdc.balanceOf(alice), 1_000e6, "nothing moved");
    }

    function test_RequestPayAndCancelJourney() public {
        // bob asks alice for 12.5 FLUX (18 decimals) and for 5 USDC; he cancels the second one
        vm.recordLogs();
        vm.prank(bob);
        uint256 fluxReq = pay.createRequest(address(flux), 12.5e18, uint64(block.timestamp + 1 days), bytes32("r1"), "lunch");
        vm.prank(bob);
        uint256 usdcReq = pay.createRequest(address(usdc), 5e6, 0, bytes32("r2"), "tip");

        // the UI reads the new id from the RequestCreated event
        Vm.Log[] memory logs = vm.getRecordedLogs();
        bytes32 topic = keccak256("RequestCreated(uint256,address,address,uint256,uint64,bytes32,string)");
        uint256 seen;
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].emitter == address(pay) && logs[i].topics[0] == topic) {
                ++seen;
                assertEq(uint256(logs[i].topics[1]), seen, "ids are sequential from 1");
            }
        }
        assertEq(seen, 2);
        assertEq(pay.requestCount(bob), 2);

        vm.prank(alice);
        pay.payRequest(fluxReq, 0);
        assertEq(flux.balanceOf(bob), 12.5e18);
        assertEq(uint8(pay.getRequest(fluxReq).status), uint8(FPS.RequestStatus.Paid));
        assertEq(pay.getRequest(fluxReq).paidBy, alice);
        assertEq(pay.getReceipt(pay.getRequest(fluxReq).paymentId).requestId, fluxReq);

        vm.prank(bob);
        pay.cancelRequest(usdcReq);
        assertEq(uint8(pay.getRequest(usdcReq).status), uint8(FPS.RequestStatus.Cancelled));
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(FPS.RequestNotOpen.selector, usdcReq));
        pay.payRequest(usdcReq, 0);
        assertEq(usdc.balanceOf(address(pay)) + flux.balanceOf(address(pay)), 0);
    }

    function test_PausedStopsNewPaymentsButNotCancelling() public {
        vm.prank(bob);
        uint256 id = pay.createRequest(address(usdc), 1e6, 0, bytes32(0), "");
        vm.prank(deployer);
        pay.pause();
        assertTrue(pay.paused());

        vm.prank(alice);
        vm.expectRevert();
        pay.pay(address(usdc), bob, 1e6, bytes32(0), "", 0);
        vm.prank(alice);
        vm.expectRevert();
        pay.payRequest(id, 0);
        vm.prank(bob);
        pay.cancelRequest(id); // still works so nobody is stuck with an open request
        assertEq(uint8(pay.getRequest(id).status), uint8(FPS.RequestStatus.Cancelled));

        vm.prank(deployer);
        pay.unpause();
        vm.prank(alice);
        pay.pay(address(usdc), bob, 1e6, bytes32(0), "", 0);
    }

    function test_UnsupportedTokenAndExpiredRequestAreRejected() public {
        MockERC20 other = new MockERC20("Other", "OTH", 6);
        other.mint(alice, 10e6);
        vm.startPrank(alice);
        other.approve(address(pay), type(uint256).max);
        vm.expectRevert(abi.encodeWithSelector(FPS.UnsupportedToken.selector, address(other)));
        pay.pay(address(other), bob, 1e6, bytes32(0), "", 0);
        vm.stopPrank();

        vm.prank(bob);
        uint256 id = pay.createRequest(address(usdc), 1e6, uint64(block.timestamp + 1 hours), bytes32(0), "");
        vm.warp(block.timestamp + 1 hours);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(FPS.RequestExpired.selector, id));
        pay.payRequest(id, 0);
    }

    function testFuzz_FeeIsAlwaysOnTopAndNothingIsHeld(uint96 amount, uint16 bps) public {
        amount = uint96(bound(amount, 1, 500e6));
        bps = uint16(bound(bps, 0, 100));
        vm.startPrank(deployer);
        pay.setFeeRecipient(collector);
        pay.setFeeBps(bps);
        vm.stopPrank();
        uint256 fee = pay.quoteFee(amount);
        usdc.mint(alice, uint256(amount) + fee);
        uint256 before = usdc.balanceOf(alice);
        vm.prank(alice);
        pay.pay(address(usdc), bob, amount, bytes32(0), "", fee);
        assertEq(before - usdc.balanceOf(alice), uint256(amount) + fee);
        assertEq(usdc.balanceOf(bob), 1_000e6 + amount);
        assertEq(usdc.balanceOf(address(pay)), 0);
        assertLe(fee, (uint256(amount) * 100 + 9_999) / 10_000, "fee never exceeds the 1% cap, rounded up");
    }
}
