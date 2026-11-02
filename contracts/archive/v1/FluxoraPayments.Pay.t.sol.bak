// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {IERC20Errors} from "@openzeppelin/contracts/interfaces/draft-IERC6093.sol";
import {FluxoraPayments} from "../src/FluxoraPayments.sol";
import {FluxoraPaymentsTestBase} from "./FluxoraPayments.Base.t.sol";

contract FluxoraPaymentsPayTest is FluxoraPaymentsTestBase {
    bytes32 internal constant REF = keccak256("ref");

    function _pay(address from, address to, uint256 amount, uint256 maxFee) internal returns (uint256) {
        vm.prank(from);
        return pay.pay(address(usdc), to, amount, REF, "memo", maxFee);
    }

    // ------------------------------------------------------------ pay happy path
    function test_PayWithoutFeeTransfersExactAmount() public {
        uint256 id = _pay(alice, bob, 100e6, 0);
        assertEq(id, 1);
        assertEq(usdc.balanceOf(alice), START - 100e6);
        assertEq(usdc.balanceOf(bob), START + 100e6);
        assertEq(usdc.balanceOf(address(pay)), 0);
        assertEq(pay.nextPaymentId(), 2);
    }

    function test_PayWithFeeSplitsAndNeverHoldsTokens() public {
        _setFee(100);
        uint256 id = _pay(alice, carol, 500e6, 5e6);
        assertEq(usdc.balanceOf(carol), 500e6);
        assertEq(usdc.balanceOf(collector), 5e6);
        assertEq(usdc.balanceOf(alice), START - 505e6);
        assertEq(usdc.balanceOf(address(pay)), 0);
        FluxoraPayments.Receipt memory r = pay.getReceipt(id);
        assertEq(r.payer, alice);
        assertEq(r.recipient, carol);
        assertEq(r.token, address(usdc));
        assertEq(r.amount, 500e6);
        assertEq(r.fee, 5e6);
        assertEq(r.timestamp, uint64(block.timestamp));
        assertEq(r.requestId, 0);
        assertEq(r.ref, REF);
    }

    function test_PayEmitsPaymentMade() public {
        _setFee(50);
        vm.expectEmit(true, true, true, true, address(pay));
        emit FluxoraPayments.PaymentMade(1, alice, bob, address(usdc), 200e6, 1e6, 0, REF, "memo");
        _pay(alice, bob, 200e6, 1e6);
    }

    function test_PayMemoExactlyMaxLengthOk() public {
        string memory memo = string(new bytes(140));
        vm.prank(alice);
        pay.pay(address(usdc), bob, 1, REF, memo, 0);
        assertEq(pay.sentCount(alice), 1);
    }

    function test_PayTracksSentAndReceivedIds() public {
        _pay(alice, bob, 1, 0);
        _pay(alice, carol, 1, 0);
        _pay(bob, carol, 1, 0);
        assertEq(pay.sentCount(alice), 2);
        assertEq(pay.receivedCount(carol), 2);
        uint256[] memory ids = pay.getReceivedIds(carol, 0, 10);
        assertEq(ids.length, 2);
        assertEq(ids[0], 2);
        assertEq(ids[1], 3);
    }

    // ------------------------------------------------------------ pay reverts
    function test_RevertPayUnsupportedToken() public {
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(FluxoraPayments.UnsupportedToken.selector, address(tokenB)));
        pay.pay(address(tokenB), bob, 1, REF, "", 0);
    }

    function test_RevertPayInvalidRecipients() public {
        vm.startPrank(alice);
        vm.expectRevert(abi.encodeWithSelector(FluxoraPayments.InvalidRecipient.selector, address(0)));
        pay.pay(address(usdc), address(0), 1, REF, "", 0);
        vm.expectRevert(abi.encodeWithSelector(FluxoraPayments.InvalidRecipient.selector, address(pay)));
        pay.pay(address(usdc), address(pay), 1, REF, "", 0);
        vm.expectRevert(abi.encodeWithSelector(FluxoraPayments.InvalidRecipient.selector, alice));
        pay.pay(address(usdc), alice, 1, REF, "", 0);
        vm.stopPrank();
    }

    function test_RevertPayZeroAmount() public {
        vm.prank(alice);
        vm.expectRevert(FluxoraPayments.ZeroAmount.selector);
        pay.pay(address(usdc), bob, 0, REF, "", 0);
    }

    function test_RevertPayMemoTooLong() public {
        string memory memo = string(new bytes(141));
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(FluxoraPayments.MemoTooLong.selector, 141, 140));
        pay.pay(address(usdc), bob, 1, REF, memo, 0);
    }

    function test_RevertPayFeeTooHigh() public {
        _setFee(100);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(FluxoraPayments.FeeTooHigh.selector, 1e6, 1e6 - 1));
        pay.pay(address(usdc), bob, 100e6, REF, "", 1e6 - 1);
    }

    function test_RevertPayWhenPaused() public {
        vm.prank(pauser);
        pay.pause();
        vm.prank(alice);
        vm.expectRevert(Pausable.EnforcedPause.selector);
        pay.pay(address(usdc), bob, 1, REF, "", 0);
    }

    function test_RevertPayWithoutAllowanceLeavesNoReceipt() public {
        vm.prank(carol);
        vm.expectRevert(abi.encodeWithSelector(IERC20Errors.ERC20InsufficientAllowance.selector, address(pay), 0, 1));
        pay.pay(address(usdc), bob, 1, REF, "", 0);
        assertEq(pay.nextPaymentId(), 1);
        assertEq(pay.sentCount(carol), 0);
    }

    function test_RevertPayInsufficientBalance() public {
        vm.prank(alice);
        vm.expectRevert(
            abi.encodeWithSelector(IERC20Errors.ERC20InsufficientBalance.selector, alice, START, START + 1)
        );
        pay.pay(address(usdc), bob, START + 1, REF, "", 0);
    }

    // ------------------------------------------------------------ requests
    function _create(address creator, uint256 amount, uint64 expiry) internal returns (uint256) {
        vm.prank(creator);
        return pay.createRequest(address(usdc), amount, expiry, REF, "invoice");
    }

    function test_CreateRequestStoresAndEmits() public {
        uint64 expiry = uint64(block.timestamp + 1 days);
        vm.expectEmit(true, true, false, true, address(pay));
        emit FluxoraPayments.RequestCreated(1, carol, address(usdc), 50e6, expiry, REF, "invoice");
        uint256 id = _create(carol, 50e6, expiry);
        assertEq(id, 1);
        FluxoraPayments.Request memory q = pay.getRequest(id);
        assertEq(q.creator, carol);
        assertEq(q.token, address(usdc));
        assertEq(q.amount, 50e6);
        assertEq(q.expiry, expiry);
        assertEq(uint8(q.status), uint8(FluxoraPayments.RequestStatus.Open));
        assertEq(q.ref, REF);
        assertEq(q.paidBy, address(0));
        assertEq(q.paymentId, 0);
        assertEq(pay.requestCount(carol), 1);
        assertEq(pay.getRequestIds(carol, 0, 5)[0], 1);
    }

    function test_RevertCreateRequestUnsupportedToken() public {
        vm.prank(carol);
        vm.expectRevert(abi.encodeWithSelector(FluxoraPayments.UnsupportedToken.selector, address(tokenB)));
        pay.createRequest(address(tokenB), 1, 0, REF, "");
    }

    function test_RevertCreateRequestZeroAmount() public {
        vm.prank(carol);
        vm.expectRevert(FluxoraPayments.ZeroAmount.selector);
        pay.createRequest(address(usdc), 0, 0, REF, "");
    }

    function test_RevertCreateRequestMemoTooLong() public {
        vm.prank(carol);
        vm.expectRevert(abi.encodeWithSelector(FluxoraPayments.MemoTooLong.selector, 141, 140));
        pay.createRequest(address(usdc), 1, 0, REF, string(new bytes(141)));
    }

    function test_RevertCreateRequestExpiryNotInFuture() public {
        uint64 nowTs = uint64(block.timestamp);
        vm.startPrank(carol);
        vm.expectRevert(abi.encodeWithSelector(FluxoraPayments.InvalidExpiry.selector, nowTs, block.timestamp));
        pay.createRequest(address(usdc), 1, nowTs, REF, "");
        vm.expectRevert(abi.encodeWithSelector(FluxoraPayments.InvalidExpiry.selector, nowTs - 1, block.timestamp));
        pay.createRequest(address(usdc), 1, nowTs - 1, REF, "");
        vm.stopPrank();
    }

    function test_RevertCreateRequestWhenPaused() public {
        vm.prank(pauser);
        pay.pause();
        vm.prank(carol);
        vm.expectRevert(Pausable.EnforcedPause.selector);
        pay.createRequest(address(usdc), 1, 0, REF, "");
    }

    function test_PayRequestSettlesAndMarksPaid() public {
        _setFee(100);
        uint256 rid = _create(carol, 100e6, 0);
        vm.expectEmit(true, true, true, true, address(pay));
        emit FluxoraPayments.PaymentMade(1, alice, carol, address(usdc), 100e6, 1e6, rid, REF, "invoice");
        vm.prank(alice);
        uint256 pid = pay.payRequest(rid, 1e6);
        assertEq(pid, 1);
        assertEq(usdc.balanceOf(carol), 100e6);
        assertEq(usdc.balanceOf(collector), 1e6);
        assertEq(usdc.balanceOf(address(pay)), 0);
        FluxoraPayments.Request memory q = pay.getRequest(rid);
        assertEq(uint8(q.status), uint8(FluxoraPayments.RequestStatus.Paid));
        assertEq(q.paidBy, alice);
        assertEq(q.paymentId, pid);
        assertEq(pay.getReceipt(pid).requestId, rid);
    }

    function test_RevertPayRequestTwice() public {
        uint256 rid = _create(carol, 1e6, 0);
        vm.prank(alice);
        pay.payRequest(rid, 0);
        vm.prank(bob);
        vm.expectRevert(abi.encodeWithSelector(FluxoraPayments.RequestNotOpen.selector, rid));
        pay.payRequest(rid, 0);
    }

    function test_RevertPayRequestUnknown() public {
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(FluxoraPayments.UnknownRequest.selector, 7));
        pay.payRequest(7, 0);
    }

    function test_RevertPayRequestExpiredAtExactExpiry() public {
        uint64 expiry = uint64(block.timestamp + 1 hours);
        uint256 rid = _create(carol, 1e6, expiry);
        vm.warp(expiry - 1);
        vm.prank(alice);
        pay.payRequest(rid, 0); // last valid second
        uint256 rid2 = _create(carol, 1e6, uint64(block.timestamp + 1 hours));
        vm.warp(block.timestamp + 1 hours);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(FluxoraPayments.RequestExpired.selector, rid2));
        pay.payRequest(rid2, 0);
    }

    function test_RevertPayRequestByCreator() public {
        uint256 rid = _create(carol, 1e6, 0);
        vm.prank(carol);
        vm.expectRevert(abi.encodeWithSelector(FluxoraPayments.InvalidRecipient.selector, carol));
        pay.payRequest(rid, 0);
    }

    function test_RevertPayRequestFeeTooHigh() public {
        _setFee(100);
        uint256 rid = _create(carol, 100e6, 0);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(FluxoraPayments.FeeTooHigh.selector, 1e6, 0));
        pay.payRequest(rid, 0);
    }

    function test_RevertPayRequestWhenPaused() public {
        uint256 rid = _create(carol, 1e6, 0);
        vm.prank(pauser);
        pay.pause();
        vm.prank(alice);
        vm.expectRevert(Pausable.EnforcedPause.selector);
        pay.payRequest(rid, 0);
    }

    function test_RevertPayRequestAfterTokenDelisted() public {
        uint256 rid = _create(carol, 1e6, 0);
        vm.prank(admin);
        pay.setTokenSupported(address(usdc), false);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(FluxoraPayments.UnsupportedToken.selector, address(usdc)));
        pay.payRequest(rid, 0);
    }

    function test_CancelRequestByCreatorEmits() public {
        uint256 rid = _create(carol, 1e6, 0);
        vm.expectEmit(true, true, false, true, address(pay));
        emit FluxoraPayments.RequestCancelled(rid, carol);
        vm.prank(carol);
        pay.cancelRequest(rid);
        assertEq(uint8(pay.getRequest(rid).status), uint8(FluxoraPayments.RequestStatus.Cancelled));
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(FluxoraPayments.RequestNotOpen.selector, rid));
        pay.payRequest(rid, 0);
    }

    function test_CancelRequestWorksWhilePaused() public {
        uint256 rid = _create(carol, 1e6, 0);
        vm.prank(pauser);
        pay.pause();
        vm.prank(carol);
        pay.cancelRequest(rid);
        assertEq(uint8(pay.getRequest(rid).status), uint8(FluxoraPayments.RequestStatus.Cancelled));
    }

    function test_RevertCancelRequestNotCreator() public {
        uint256 rid = _create(carol, 1e6, 0);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(FluxoraPayments.NotRequestCreator.selector, alice, carol));
        pay.cancelRequest(rid);
    }

    function test_RevertCancelRequestAlreadyPaidOrCancelled() public {
        uint256 rid = _create(carol, 1e6, 0);
        vm.prank(alice);
        pay.payRequest(rid, 0);
        vm.prank(carol);
        vm.expectRevert(abi.encodeWithSelector(FluxoraPayments.RequestNotOpen.selector, rid));
        pay.cancelRequest(rid);
    }

    function test_RevertCancelRequestUnknown() public {
        vm.prank(carol);
        vm.expectRevert(abi.encodeWithSelector(FluxoraPayments.UnknownRequest.selector, 3));
        pay.cancelRequest(3);
    }

    // ------------------------------------------------------------ views
    function test_RevertGetReceiptUnknown() public {
        vm.expectRevert(abi.encodeWithSelector(FluxoraPayments.UnknownPayment.selector, 0));
        pay.getReceipt(0);
        vm.expectRevert(abi.encodeWithSelector(FluxoraPayments.UnknownPayment.selector, 1));
        pay.getReceipt(1);
    }

    function test_RevertGetRequestUnknown() public {
        vm.expectRevert(abi.encodeWithSelector(FluxoraPayments.UnknownRequest.selector, 0));
        pay.getRequest(0);
        vm.expectRevert(abi.encodeWithSelector(FluxoraPayments.UnknownRequest.selector, 1));
        pay.getRequest(1);
    }

    function test_PaginationClampsAndEmptyPastEnd() public {
        for (uint256 i; i < 5; ++i) _pay(alice, bob, 1, 0);
        assertEq(pay.getSentIds(alice, 0, 3).length, 3);
        uint256[] memory page = pay.getSentIds(alice, 3, 10);
        assertEq(page.length, 2);
        assertEq(page[0], 4);
        assertEq(page[1], 5);
        assertEq(pay.getSentIds(alice, 5, 10).length, 0);
        assertEq(pay.getSentIds(alice, 99, 10).length, 0);
        assertEq(pay.getSentIds(alice, 0, 0).length, 0);
    }

    // ------------------------------------------------------------ fuzz
    function testFuzz_PayConservesBalancesAndFeeBounded(uint256 amount, uint256 bps) public {
        amount = bound(amount, 1, START / 2);
        bps = bound(bps, 0, 100);
        _setFee(bps);
        uint256 fee = pay.quoteFee(amount);
        uint256 total = amount + fee;
        usdc.mint(alice, total); // make sure balance covers amount + fee
        uint256 aliceBefore = usdc.balanceOf(alice);
        uint256 bobBefore = usdc.balanceOf(bob);
        _pay(alice, bob, amount, fee);
        assertEq(usdc.balanceOf(bob), bobBefore + amount);
        assertEq(usdc.balanceOf(collector), fee);
        assertEq(usdc.balanceOf(alice), aliceBefore - amount - fee);
        assertEq(usdc.balanceOf(address(pay)), 0);
        assertLe(fee, amount / 100 + 1);
        assertEq(pay.getReceipt(1).fee, fee);
    }

    function testFuzz_PayRevertsIfMaxFeeBelowQuote(uint256 amount, uint256 bps, uint256 shortBy) public {
        amount = bound(amount, 100, START);
        bps = bound(bps, 1, 100);
        _setFee(bps);
        uint256 fee = pay.quoteFee(amount);
        shortBy = bound(shortBy, 1, fee);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(FluxoraPayments.FeeTooHigh.selector, fee, fee - shortBy));
        pay.pay(address(usdc), bob, amount, REF, "", fee - shortBy);
    }
}
