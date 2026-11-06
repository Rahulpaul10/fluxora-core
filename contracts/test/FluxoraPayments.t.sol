// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {IERC20Errors} from "@openzeppelin/contracts/interfaces/draft-IERC6093.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {FluxoraPayments} from "../FluxoraPayments.sol";
import {MockERC20} from "./helpers/MockERC20.sol";
import {
    FPBlocklistToken,
    FPFeeToken,
    FPReentrantToken,
    FPHandler
} from "./helpers/FluxoraPaymentsTestKit.sol";

contract FluxoraPaymentsTest is Test {
    FluxoraPayments internal c;
    MockERC20 internal usdc;

    address internal alice = makeAddr("alice");
    address internal bob = makeAddr("bob");
    address internal carol = makeAddr("carol");
    address internal dave = makeAddr("dave");

    uint256 internal constant T0 = 1_700_000_000;
    uint256 internal constant START = 1_000e6;
    bytes32 internal constant REF = keccak256("order-42");

    function setUp() public {
        vm.warp(T0);
        usdc = new MockERC20("USD Coin", "USDC", 6);
        c = new FluxoraPayments(address(usdc));
        _fundUser(alice);
        _fundUser(bob);
        _fundUser(carol);
    }

    function _fundUser(address who) internal {
        usdc.mint(who, START);
        vm.prank(who);
        usdc.approve(address(c), type(uint256).max);
    }

    function _bytesStr(uint256 len) internal pure returns (string memory) {
        bytes memory b = new bytes(len);
        for (uint256 i; i < len; ++i) {
            b[i] = "a";
        }
        return string(b);
    }

    function _pay(address from, address to, uint256 amount) internal returns (uint256 id) {
        vm.prank(from);
        id = c.pay(to, amount, bytes32(0), "");
    }

    function _req(address creator, uint256 amount, uint64 expiry) internal returns (uint256 id) {
        vm.prank(creator);
        id = c.createRequest(amount, expiry, REF, "invoice");
    }

    /*//////////////////////////////////////////////////////////////
                              CONSTRUCTOR
    //////////////////////////////////////////////////////////////*/

    function test_Constructor_StoresTokenAndDefaults() public view {
        assertEq(address(c.usdc()), address(usdc));
        assertEq(c.nextPaymentId(), 1);
        assertEq(c.nextRequestId(), 1);
        assertEq(c.MAX_MEMO_BYTES(), 140);
        assertEq(c.MAX_PAGE_SIZE(), 100);
        assertEq(usdc.balanceOf(address(c)), 0);
    }

    function test_Constructor_RevertsOnZeroAddress() public {
        vm.expectRevert(FluxoraPayments.ZeroAddress.selector);
        new FluxoraPayments(address(0));
    }

    function test_Constructor_RevertsWhenNoCode() public {
        vm.expectRevert(abi.encodeWithSelector(FluxoraPayments.InvalidToken.selector, dave));
        new FluxoraPayments(dave);
    }

    /*//////////////////////////////////////////////////////////////
                              pay: happy path
    //////////////////////////////////////////////////////////////*/

    function test_Pay_MovesFundsDirectly() public {
        vm.prank(alice);
        uint256 id = c.pay(bob, 250e6, REF, "thanks");
        assertEq(id, 1);
        assertEq(usdc.balanceOf(alice), START - 250e6);
        assertEq(usdc.balanceOf(bob), START + 250e6);
        assertEq(usdc.balanceOf(address(c)), 0);
        assertEq(c.nextPaymentId(), 2);
    }

    function test_Pay_StoresReceiptAndMemo() public {
        skip(77);
        vm.prank(alice);
        uint256 id = c.pay(bob, 5e6, REF, "lunch");
        (FluxoraPayments.Receipt memory r, string memory memo) = c.getReceipt(id);
        assertEq(r.payer, alice);
        assertEq(r.recipient, bob);
        assertEq(r.amount, 5e6);
        assertEq(r.timestamp, T0 + 77);
        assertEq(r.requestId, 0);
        assertEq(r.ref, REF);
        assertEq(memo, "lunch");
    }

    function test_Pay_EmitsPaymentMade() public {
        vm.expectEmit(true, true, true, true, address(c));
        emit FluxoraPayments.PaymentMade(1, alice, bob, 9e6, 0, REF, "hi");
        vm.prank(alice);
        c.pay(bob, 9e6, REF, "hi");
    }

    function test_Pay_EmptyMemoStoresEmpty() public {
        uint256 id = _pay(alice, bob, 1);
        (, string memory memo) = c.getReceipt(id);
        assertEq(bytes(memo).length, 0);
    }

    function test_Pay_IdsSequentialAndHistoriesUpdated() public {
        assertEq(_pay(alice, bob, 1e6), 1);
        assertEq(_pay(bob, carol, 2e6), 2);
        assertEq(_pay(alice, carol, 3e6), 3);

        assertEq(c.sentCount(alice), 2);
        assertEq(c.sentCount(bob), 1);
        assertEq(c.sentCount(carol), 0);
        assertEq(c.receivedCount(bob), 1);
        assertEq(c.receivedCount(carol), 2);
        assertEq(c.receivedCount(alice), 0);

        uint256[] memory sent = c.sentPayments(alice, 0, 10);
        assertEq(sent.length, 2);
        assertEq(sent[0], 1);
        assertEq(sent[1], 3);
        uint256[] memory rec = c.receivedPayments(carol, 0, 10);
        assertEq(rec.length, 2);
        assertEq(rec[0], 2);
        assertEq(rec[1], 3);
        assertEq(usdc.balanceOf(address(c)), 0);
    }

    function test_Pay_MemoExactly140BytesOk() public {
        string memory m = _bytesStr(140);
        vm.prank(alice);
        uint256 id = c.pay(bob, 1, bytes32(0), m);
        (, string memory stored) = c.getReceipt(id);
        assertEq(stored, m);
    }

    function test_Pay_ExactAllowanceAndFullBalance() public {
        vm.startPrank(dave);
        usdc.approve(address(c), 40e6);
        vm.stopPrank();
        usdc.mint(dave, 40e6);
        vm.prank(dave);
        c.pay(bob, 40e6, bytes32(0), "");
        assertEq(usdc.balanceOf(dave), 0);
        assertEq(usdc.allowance(dave, address(c)), 0);
    }

    /*//////////////////////////////////////////////////////////////
                              pay: reverts
    //////////////////////////////////////////////////////////////*/

    function _assertNothingRecorded() internal view {
        assertEq(c.nextPaymentId(), 1);
        assertEq(c.sentCount(alice), 0);
        assertEq(usdc.balanceOf(alice), START);
        assertEq(usdc.balanceOf(address(c)), 0);
    }

    function test_Pay_RevertsZeroRecipient() public {
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(FluxoraPayments.InvalidRecipient.selector, address(0)));
        c.pay(address(0), 1, bytes32(0), "");
        _assertNothingRecorded();
    }

    function test_Pay_RevertsSelfRecipient() public {
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(FluxoraPayments.InvalidRecipient.selector, alice));
        c.pay(alice, 1, bytes32(0), "");
        _assertNothingRecorded();
    }

    function test_Pay_RevertsContractRecipient() public {
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(FluxoraPayments.InvalidRecipient.selector, address(c)));
        c.pay(address(c), 1, bytes32(0), "");
        _assertNothingRecorded();
    }

    function test_Pay_RevertsZeroAmount() public {
        vm.prank(alice);
        vm.expectRevert(FluxoraPayments.ZeroAmount.selector);
        c.pay(bob, 0, bytes32(0), "");
        _assertNothingRecorded();
    }

    function test_Pay_RevertsMemo141Bytes() public {
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(FluxoraPayments.MemoTooLong.selector, 141, 140));
        c.pay(bob, 1, bytes32(0), _bytesStr(141));
        _assertNothingRecorded();
    }

    function test_Pay_MemoLimitIsBytesNotCharacters() public {
        // 47 x 3-byte characters = 141 bytes but only 47 characters.
        bytes memory b;
        for (uint256 i; i < 47; ++i) {
            b = bytes.concat(b, bytes(unicode"€"));
        }
        assertEq(b.length, 141);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(FluxoraPayments.MemoTooLong.selector, 141, 140));
        c.pay(bob, 1, bytes32(0), string(b));
    }

    function test_Pay_RevertsWithoutAllowance() public {
        usdc.mint(dave, 10e6);
        vm.prank(dave);
        vm.expectRevert(
            abi.encodeWithSelector(IERC20Errors.ERC20InsufficientAllowance.selector, address(c), 0, 10e6)
        );
        c.pay(bob, 10e6, bytes32(0), "");
        assertEq(c.nextPaymentId(), 1);
        assertEq(c.sentCount(dave), 0);
        assertEq(c.receivedCount(bob), 0);
    }

    function test_Pay_RevertsInsufficientAllowance() public {
        usdc.mint(dave, 10e6);
        vm.startPrank(dave);
        usdc.approve(address(c), 9e6);
        vm.expectRevert(
            abi.encodeWithSelector(IERC20Errors.ERC20InsufficientAllowance.selector, address(c), 9e6, 10e6)
        );
        c.pay(bob, 10e6, bytes32(0), "");
        vm.stopPrank();
        assertEq(c.nextPaymentId(), 1);
    }

    function test_Pay_RevertsInsufficientBalance() public {
        vm.prank(alice);
        vm.expectRevert(
            abi.encodeWithSelector(IERC20Errors.ERC20InsufficientBalance.selector, alice, START, START + 1)
        );
        c.pay(bob, START + 1, bytes32(0), "");
        _assertNothingRecorded();
        assertEq(usdc.balanceOf(bob), START);
    }

    /*//////////////////////////////////////////////////////////////
                           createRequest
    //////////////////////////////////////////////////////////////*/

    function test_CreateRequest_NoExpiry() public {
        vm.prank(alice);
        uint256 id = c.createRequest(30e6, 0, REF, "invoice 7");
        assertEq(id, 1);
        (FluxoraPayments.Request memory r, string memory memo) = c.getRequest(id);
        assertEq(r.creator, alice);
        assertEq(r.amount, 30e6);
        assertEq(r.expiry, 0);
        assertEq(r.ref, REF);
        assertEq(uint8(r.status), uint8(FluxoraPayments.RequestStatus.Open));
        assertEq(r.paidBy, address(0));
        assertEq(r.paymentId, 0);
        assertEq(memo, "invoice 7");
        assertEq(c.nextRequestId(), 2);
        assertEq(c.requestCount(alice), 1);
        assertEq(usdc.balanceOf(address(c)), 0);
    }

    function test_CreateRequest_EmitsRequestCreated() public {
        uint64 exp = uint64(T0 + 1 days);
        vm.expectEmit(true, true, false, true, address(c));
        emit FluxoraPayments.RequestCreated(1, alice, 30e6, exp, REF, "m");
        vm.prank(alice);
        c.createRequest(30e6, exp, REF, "m");
    }

    function test_CreateRequest_WithFutureExpiry() public {
        uint64 exp = uint64(T0 + 1);
        uint256 id = _req(alice, 1e6, exp);
        (FluxoraPayments.Request memory r,) = c.getRequest(id);
        assertEq(r.expiry, exp);
        assertEq(uint8(c.requestStatus(id)), uint8(FluxoraPayments.RequestStatus.Open));
    }

    function test_CreateRequest_RevertsExpiryInPast() public {
        uint64 exp = uint64(T0 - 1);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(FluxoraPayments.InvalidExpiry.selector, exp, T0));
        c.createRequest(1e6, exp, REF, "");
        assertEq(c.nextRequestId(), 1);
    }

    function test_CreateRequest_RevertsExpiryNow() public {
        uint64 exp = uint64(T0);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(FluxoraPayments.InvalidExpiry.selector, exp, T0));
        c.createRequest(1e6, exp, REF, "");
    }

    function test_CreateRequest_RevertsZeroAmount() public {
        vm.prank(alice);
        vm.expectRevert(FluxoraPayments.ZeroAmount.selector);
        c.createRequest(0, 0, REF, "");
    }

    function test_CreateRequest_Memo140OkAnd141Reverts() public {
        vm.prank(alice);
        c.createRequest(1, 0, REF, _bytesStr(140));
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(FluxoraPayments.MemoTooLong.selector, 141, 140));
        c.createRequest(1, 0, REF, _bytesStr(141));
        assertEq(c.nextRequestId(), 2);
    }

    function test_CreateRequest_HistoryAndIds() public {
        assertEq(_req(alice, 1, 0), 1);
        assertEq(_req(bob, 1, 0), 2);
        assertEq(_req(alice, 1, 0), 3);
        assertEq(c.requestCount(alice), 2);
        assertEq(c.requestCount(bob), 1);
        uint256[] memory ids = c.requestsOf(alice, 0, 10);
        assertEq(ids.length, 2);
        assertEq(ids[0], 1);
        assertEq(ids[1], 3);
    }

    /*//////////////////////////////////////////////////////////////
                              payRequest
    //////////////////////////////////////////////////////////////*/

    function test_PayRequest_ByThirdParty() public {
        uint256 rid = _req(bob, 30e6, 0);
        vm.prank(alice);
        uint256 pid = c.payRequest(rid);
        assertEq(pid, 1);

        assertEq(usdc.balanceOf(alice), START - 30e6);
        assertEq(usdc.balanceOf(bob), START + 30e6);
        assertEq(usdc.balanceOf(address(c)), 0);

        (FluxoraPayments.Receipt memory r, string memory memo) = c.getReceipt(pid);
        assertEq(r.payer, alice);
        assertEq(r.recipient, bob);
        assertEq(r.amount, 30e6);
        assertEq(r.requestId, rid);
        assertEq(r.ref, REF);
        assertEq(r.timestamp, T0);
        // Observation: the request memo is NOT copied onto the payment receipt.
        assertEq(bytes(memo).length, 0);

        (FluxoraPayments.Request memory q,) = c.getRequest(rid);
        assertEq(uint8(q.status), uint8(FluxoraPayments.RequestStatus.Paid));
        assertEq(q.paidBy, alice);
        assertEq(q.paymentId, pid);

        assertEq(c.sentCount(alice), 1);
        assertEq(c.receivedCount(bob), 1);
        assertEq(uint8(c.requestStatus(rid)), uint8(FluxoraPayments.RequestStatus.Paid));
    }

    function test_PayRequest_EmitsPaymentMadeWithRequestId() public {
        uint256 rid = _req(bob, 30e6, 0);
        vm.expectEmit(true, true, true, true, address(c));
        emit FluxoraPayments.PaymentMade(1, alice, bob, 30e6, rid, REF, "");
        vm.prank(alice);
        c.payRequest(rid);
    }

    function test_PayRequest_SharesPaymentIdSequenceWithDirectPay() public {
        _pay(alice, bob, 1e6);
        uint256 rid = _req(carol, 2e6, 0);
        vm.prank(alice);
        uint256 pid = c.payRequest(rid);
        assertEq(pid, 2);
        (FluxoraPayments.Request memory q,) = c.getRequest(rid);
        assertEq(q.paymentId, 2);
        assertEq(_pay(bob, carol, 1e6), 3);
    }

    function test_PayRequest_CreatorCannotPayOwn() public {
        uint256 rid = _req(bob, 1e6, 0);
        vm.prank(bob);
        vm.expectRevert(abi.encodeWithSelector(FluxoraPayments.CannotPayOwnRequest.selector, rid));
        c.payRequest(rid);
        assertEq(uint8(c.requestStatus(rid)), uint8(FluxoraPayments.RequestStatus.Open));
    }

    function test_PayRequest_DoublePayReverts() public {
        uint256 rid = _req(bob, 1e6, 0);
        vm.prank(alice);
        c.payRequest(rid);
        vm.prank(carol);
        vm.expectRevert(abi.encodeWithSelector(FluxoraPayments.RequestNotOpen.selector, rid));
        c.payRequest(rid);
        assertEq(c.nextPaymentId(), 2);
        assertEq(usdc.balanceOf(carol), START);
    }

    function test_PayRequest_AfterCancelReverts() public {
        uint256 rid = _req(bob, 1e6, 0);
        vm.prank(bob);
        c.cancelRequest(rid);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(FluxoraPayments.RequestNotOpen.selector, rid));
        c.payRequest(rid);
    }

    function test_PayRequest_AtExactExpirySucceeds() public {
        uint256 rid = _req(bob, 1e6, uint64(T0 + 100));
        vm.warp(T0 + 100);
        assertEq(uint8(c.requestStatus(rid)), uint8(FluxoraPayments.RequestStatus.Open));
        vm.prank(alice);
        c.payRequest(rid);
        assertEq(uint8(c.requestStatus(rid)), uint8(FluxoraPayments.RequestStatus.Paid));
    }

    function test_PayRequest_OneSecondAfterExpiryReverts() public {
        uint256 rid = _req(bob, 1e6, uint64(T0 + 100));
        vm.warp(T0 + 101);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(FluxoraPayments.RequestExpired.selector, rid));
        c.payRequest(rid);
        assertEq(c.nextPaymentId(), 1);
        assertEq(usdc.balanceOf(alice), START);
    }

    function test_RequestStatus_ExpiredIsLazyAndNotStored() public {
        uint256 rid = _req(bob, 1e6, uint64(T0 + 100));
        vm.warp(T0 + 101);
        assertEq(uint8(c.requestStatus(rid)), uint8(FluxoraPayments.RequestStatus.Expired));
        (FluxoraPayments.Request memory q,) = c.getRequest(rid);
        assertEq(uint8(q.status), uint8(FluxoraPayments.RequestStatus.Open));
    }

    function test_RequestStatus_PaidStaysPaidAfterExpiryTime() public {
        uint256 rid = _req(bob, 1e6, uint64(T0 + 100));
        vm.prank(alice);
        c.payRequest(rid);
        vm.warp(T0 + 1000);
        assertEq(uint8(c.requestStatus(rid)), uint8(FluxoraPayments.RequestStatus.Paid));
    }

    function test_RequestStatus_NoExpiryNeverExpires() public {
        uint256 rid = _req(bob, 1e6, 0);
        vm.warp(T0 + 365 days * 50);
        assertEq(uint8(c.requestStatus(rid)), uint8(FluxoraPayments.RequestStatus.Open));
        vm.prank(alice);
        c.payRequest(rid);
    }

    function test_PayRequest_FailureLeavesRequestOpen() public {
        uint256 rid = _req(bob, 1e6, 0);
        // dave: no balance, no allowance
        vm.prank(dave);
        vm.expectRevert(
            abi.encodeWithSelector(IERC20Errors.ERC20InsufficientAllowance.selector, address(c), 0, 1e6)
        );
        c.payRequest(rid);
        // carol: allowance, but not enough balance
        uint256 big = _req(bob, START + 1, 0);
        vm.prank(carol);
        vm.expectRevert(
            abi.encodeWithSelector(IERC20Errors.ERC20InsufficientBalance.selector, carol, START, START + 1)
        );
        c.payRequest(big);

        assertEq(c.nextPaymentId(), 1);
        assertEq(uint8(c.requestStatus(rid)), uint8(FluxoraPayments.RequestStatus.Open));
        assertEq(uint8(c.requestStatus(big)), uint8(FluxoraPayments.RequestStatus.Open));
        (FluxoraPayments.Request memory q,) = c.getRequest(rid);
        assertEq(q.paidBy, address(0));
        assertEq(q.paymentId, 0);
        assertEq(c.receivedCount(bob), 0);
    }

    /*//////////////////////////////////////////////////////////////
                              cancelRequest
    //////////////////////////////////////////////////////////////*/

    function test_CancelRequest_ByCreator() public {
        uint256 rid = _req(bob, 1e6, 0);
        vm.expectEmit(true, true, false, true, address(c));
        emit FluxoraPayments.RequestCancelled(rid, bob);
        vm.prank(bob);
        c.cancelRequest(rid);
        assertEq(uint8(c.requestStatus(rid)), uint8(FluxoraPayments.RequestStatus.Cancelled));
    }

    function test_CancelRequest_NonCreatorReverts() public {
        uint256 rid = _req(bob, 1e6, 0);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(FluxoraPayments.NotRequestCreator.selector, alice, bob));
        c.cancelRequest(rid);
        assertEq(uint8(c.requestStatus(rid)), uint8(FluxoraPayments.RequestStatus.Open));
    }

    function test_CancelRequest_AfterPaidReverts() public {
        uint256 rid = _req(bob, 1e6, 0);
        vm.prank(alice);
        c.payRequest(rid);
        vm.prank(bob);
        vm.expectRevert(abi.encodeWithSelector(FluxoraPayments.RequestNotOpen.selector, rid));
        c.cancelRequest(rid);
        assertEq(uint8(c.requestStatus(rid)), uint8(FluxoraPayments.RequestStatus.Paid));
    }

    function test_CancelRequest_TwiceReverts() public {
        uint256 rid = _req(bob, 1e6, 0);
        vm.startPrank(bob);
        c.cancelRequest(rid);
        vm.expectRevert(abi.encodeWithSelector(FluxoraPayments.RequestNotOpen.selector, rid));
        c.cancelRequest(rid);
        vm.stopPrank();
    }

    function test_CancelRequest_ExpiredButStoredOpenCanBeCancelled() public {
        // Documented behaviour: expiry is lazy, so the creator can still cancel afterwards.
        uint256 rid = _req(bob, 1e6, uint64(T0 + 10));
        vm.warp(T0 + 11);
        vm.prank(bob);
        c.cancelRequest(rid);
        assertEq(uint8(c.requestStatus(rid)), uint8(FluxoraPayments.RequestStatus.Cancelled));
    }

    /*//////////////////////////////////////////////////////////////
                              unknown ids
    //////////////////////////////////////////////////////////////*/

    function test_UnknownRequestIds() public {
        vm.expectRevert(abi.encodeWithSelector(FluxoraPayments.UnknownRequest.selector, 0));
        c.getRequest(0);
        vm.expectRevert(abi.encodeWithSelector(FluxoraPayments.UnknownRequest.selector, 999));
        c.getRequest(999);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(FluxoraPayments.UnknownRequest.selector, 999));
        c.payRequest(999);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(FluxoraPayments.UnknownRequest.selector, 999));
        c.cancelRequest(999);
        assertEq(uint8(c.requestStatus(999)), uint8(FluxoraPayments.RequestStatus.None));
        assertEq(uint8(c.requestStatus(0)), uint8(FluxoraPayments.RequestStatus.None));
    }

    function test_UnknownPaymentIds() public {
        vm.expectRevert(abi.encodeWithSelector(FluxoraPayments.UnknownPayment.selector, 0));
        c.getReceipt(0);
        vm.expectRevert(abi.encodeWithSelector(FluxoraPayments.UnknownPayment.selector, 1));
        c.getReceipt(1);
        _pay(alice, bob, 1);
        (FluxoraPayments.Receipt memory r,) = c.getReceipt(1);
        assertEq(r.payer, alice);
        vm.expectRevert(abi.encodeWithSelector(FluxoraPayments.UnknownPayment.selector, 2));
        c.getReceipt(2);
    }

    /*//////////////////////////////////////////////////////////////
                        blocklist (atomic revert)
    //////////////////////////////////////////////////////////////*/

    function _blocklistFixture() internal returns (FPBlocklistToken bl, FluxoraPayments cb) {
        bl = new FPBlocklistToken();
        cb = new FluxoraPayments(address(bl));
        bl.mint(alice, START);
        bl.mint(bob, START);
        vm.prank(alice);
        bl.approve(address(cb), type(uint256).max);
        vm.prank(bob);
        bl.approve(address(cb), type(uint256).max);
    }

    function test_Blocklist_BlockedPayerPayRevertsAtomically() public {
        (FPBlocklistToken bl, FluxoraPayments cb) = _blocklistFixture();
        bl.setBlocked(alice, true);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(FPBlocklistToken.Blocked.selector, alice));
        cb.pay(bob, 1e6, REF, "x");
        assertEq(cb.nextPaymentId(), 1);
        assertEq(cb.sentCount(alice), 0);
        assertEq(cb.receivedCount(bob), 0);
        vm.expectRevert(abi.encodeWithSelector(FluxoraPayments.UnknownPayment.selector, 1));
        cb.getReceipt(1);
        assertEq(bl.balanceOf(alice), START);
    }

    function test_Blocklist_BlockedRecipientPayRevertsAtomically() public {
        (FPBlocklistToken bl, FluxoraPayments cb) = _blocklistFixture();
        bl.setBlocked(bob, true);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(FPBlocklistToken.Blocked.selector, bob));
        cb.pay(bob, 1e6, REF, "x");
        assertEq(cb.nextPaymentId(), 1);
        assertEq(cb.sentCount(alice), 0);
        assertEq(cb.receivedCount(bob), 0);
        assertEq(bl.balanceOf(address(cb)), 0);
    }

    function test_Blocklist_PayRequestBlockedPayerOrCreatorKeepsRequestOpen() public {
        (FPBlocklistToken bl, FluxoraPayments cb) = _blocklistFixture();
        vm.prank(bob);
        uint256 rid = cb.createRequest(5e6, 0, REF, "");

        bl.setBlocked(alice, true);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(FPBlocklistToken.Blocked.selector, alice));
        cb.payRequest(rid);
        bl.setBlocked(alice, false);

        bl.setBlocked(bob, true);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(FPBlocklistToken.Blocked.selector, bob));
        cb.payRequest(rid);
        bl.setBlocked(bob, false);

        assertEq(cb.nextPaymentId(), 1);
        assertEq(uint8(cb.requestStatus(rid)), uint8(FluxoraPayments.RequestStatus.Open));
        (FluxoraPayments.Request memory q,) = cb.getRequest(rid);
        assertEq(q.paidBy, address(0));
        assertEq(q.paymentId, 0);
        assertEq(cb.sentCount(alice), 0);

        // After unblocking, the same request is payable and gets the first id.
        vm.prank(alice);
        assertEq(cb.payRequest(rid), 1);
        assertEq(bl.balanceOf(address(cb)), 0);
    }

    /*//////////////////////////////////////////////////////////////
                         fee-on-transfer token
    //////////////////////////////////////////////////////////////*/

    function test_FeeOnTransfer_ReceiptRecordsGrossAmountByDesign() public {
        FPFeeToken ft = new FPFeeToken();
        FluxoraPayments cf = new FluxoraPayments(address(ft));
        ft.mint(alice, 1_000e6);
        vm.prank(alice);
        ft.approve(address(cf), type(uint256).max);

        vm.prank(alice);
        cf.pay(bob, 100e6, REF, "");
        // No balance-delta check: contract does not revert; recipient gets 99, receipt says 100.
        assertEq(ft.balanceOf(bob), 99e6);
        assertEq(ft.balanceOf(alice), 900e6);
        assertEq(ft.balanceOf(address(cf)), 0);
        (FluxoraPayments.Receipt memory r,) = cf.getReceipt(1);
        assertEq(r.amount, 100e6);
    }

    function test_FeeOnTransfer_PayRequestAlsoRecordsGross() public {
        FPFeeToken ft = new FPFeeToken();
        FluxoraPayments cf = new FluxoraPayments(address(ft));
        ft.mint(alice, 1_000e6);
        vm.prank(alice);
        ft.approve(address(cf), type(uint256).max);
        vm.prank(bob);
        uint256 rid = cf.createRequest(200e6, 0, REF, "");
        vm.prank(alice);
        cf.payRequest(rid);
        assertEq(ft.balanceOf(bob), 198e6);
        assertEq(ft.balanceOf(address(cf)), 0);
        assertEq(uint8(cf.requestStatus(rid)), uint8(FluxoraPayments.RequestStatus.Paid));
    }

    /*//////////////////////////////////////////////////////////////
                           native currency
    //////////////////////////////////////////////////////////////*/

    function test_NativeTransfer_Reverts() public {
        vm.deal(address(this), 10 ether);
        (bool ok,) = address(c).call{value: 1 ether}("");
        assertFalse(ok);
        (bool ok2,) = address(c).call{value: 1 ether}(hex"deadbeef");
        assertFalse(ok2);
        (bool ok3,) = address(c).call(hex"");
        assertFalse(ok3);
        assertEq(address(c).balance, 0);
    }

    function test_NativeValueOnNonPayableFunctionReverts() public {
        vm.deal(alice, 1 ether);
        vm.prank(alice);
        (bool ok,) = address(c).call{value: 1}(
            abi.encodeCall(FluxoraPayments.pay, (bob, 1e6, bytes32(0), ""))
        );
        assertFalse(ok);
        assertEq(address(c).balance, 0);
    }

    /*//////////////////////////////////////////////////////////////
                              reentrancy
    //////////////////////////////////////////////////////////////*/

    function _reFixture() internal returns (FPReentrantToken rt, FluxoraPayments cr) {
        rt = new FPReentrantToken();
        cr = new FluxoraPayments(address(rt));
        rt.mint(alice, START);
        vm.prank(alice);
        rt.approve(address(cr), type(uint256).max);
    }

    function _assertBlockedReentry(FPReentrantToken rt) internal view {
        assertEq(rt.attempts(), 1);
        assertFalse(rt.lastOk());
        assertEq(bytes4(rt.lastRet()), ReentrancyGuard.ReentrancyGuardReentrantCall.selector);
    }

    function test_Reentrancy_PayCannotReenterPay() public {
        (FPReentrantToken rt, FluxoraPayments cr) = _reFixture();
        rt.arm(address(cr), abi.encodeCall(FluxoraPayments.pay, (carol, 1, bytes32(0), "")));
        vm.prank(alice);
        cr.pay(bob, 10e6, bytes32(0), "");
        _assertBlockedReentry(rt);
        assertEq(cr.nextPaymentId(), 2);
        assertEq(rt.balanceOf(bob), 10e6);
        assertEq(rt.balanceOf(carol), 0);
        assertEq(rt.balanceOf(address(cr)), 0);
    }

    function test_Reentrancy_PayCannotReenterPayRequest() public {
        (FPReentrantToken rt, FluxoraPayments cr) = _reFixture();
        vm.prank(carol);
        uint256 rid = cr.createRequest(1e6, 0, bytes32(0), "");
        rt.arm(address(cr), abi.encodeCall(FluxoraPayments.payRequest, (rid)));
        vm.prank(alice);
        cr.pay(bob, 10e6, bytes32(0), "");
        _assertBlockedReentry(rt);
        assertEq(cr.nextPaymentId(), 2);
        assertEq(uint8(cr.requestStatus(rid)), uint8(FluxoraPayments.RequestStatus.Open));
    }

    function test_Reentrancy_PayRequestCannotReenterPay() public {
        (FPReentrantToken rt, FluxoraPayments cr) = _reFixture();
        vm.prank(bob);
        uint256 rid = cr.createRequest(10e6, 0, bytes32(0), "");
        rt.arm(address(cr), abi.encodeCall(FluxoraPayments.pay, (carol, 1, bytes32(0), "")));
        vm.prank(alice);
        cr.payRequest(rid);
        _assertBlockedReentry(rt);
        assertEq(cr.nextPaymentId(), 2);
        assertEq(rt.balanceOf(bob), 10e6);
    }

    function test_Reentrancy_PayRequestCannotReenterPayRequest() public {
        (FPReentrantToken rt, FluxoraPayments cr) = _reFixture();
        vm.startPrank(bob);
        uint256 r1 = cr.createRequest(10e6, 0, bytes32(0), "");
        uint256 r2 = cr.createRequest(5e6, 0, bytes32(0), "");
        vm.stopPrank();
        rt.arm(address(cr), abi.encodeCall(FluxoraPayments.payRequest, (r2)));
        vm.prank(alice);
        cr.payRequest(r1);
        _assertBlockedReentry(rt);
        assertEq(uint8(cr.requestStatus(r1)), uint8(FluxoraPayments.RequestStatus.Paid));
        assertEq(uint8(cr.requestStatus(r2)), uint8(FluxoraPayments.RequestStatus.Open));
        assertEq(rt.balanceOf(bob), 10e6);
    }

    function test_Reentrancy_CreateRequestFromHookIsHarmless() public {
        (FPReentrantToken rt, FluxoraPayments cr) = _reFixture();
        rt.arm(address(cr), abi.encodeCall(FluxoraPayments.createRequest, (7e6, 0, bytes32(0), "evil")));
        vm.prank(alice);
        cr.pay(bob, 10e6, bytes32(0), "");
        assertEq(rt.attempts(), 1);
        assertTrue(rt.lastOk());
        assertEq(cr.nextRequestId(), 2);
        (FluxoraPayments.Request memory q,) = cr.getRequest(1);
        assertEq(q.creator, address(rt));
        assertEq(cr.nextPaymentId(), 2);
        assertEq(rt.balanceOf(address(cr)), 0);
    }

    function test_Reentrancy_CancelOwnRequestFromHookIsHarmless() public {
        (FPReentrantToken rt, FluxoraPayments cr) = _reFixture();
        vm.prank(address(rt));
        uint256 rid = cr.createRequest(1e6, 0, bytes32(0), "");
        rt.arm(address(cr), abi.encodeCall(FluxoraPayments.cancelRequest, (rid)));
        vm.prank(alice);
        cr.pay(bob, 10e6, bytes32(0), "");
        assertTrue(rt.lastOk());
        assertEq(uint8(cr.requestStatus(rid)), uint8(FluxoraPayments.RequestStatus.Cancelled));
        assertEq(rt.balanceOf(bob), 10e6);
    }

    function test_Reentrancy_CancelDuringPayRequestSeesPaidStatus() public {
        (FPReentrantToken rt, FluxoraPayments cr) = _reFixture();
        vm.prank(address(rt));
        uint256 rid = cr.createRequest(4e6, 0, bytes32(0), "");
        rt.arm(address(cr), abi.encodeCall(FluxoraPayments.cancelRequest, (rid)));
        vm.prank(alice);
        cr.payRequest(rid);
        assertFalse(rt.lastOk());
        assertEq(bytes4(rt.lastRet()), FluxoraPayments.RequestNotOpen.selector);
        assertEq(uint8(cr.requestStatus(rid)), uint8(FluxoraPayments.RequestStatus.Paid));
        assertEq(rt.balanceOf(address(rt)), 4e6);
    }

    /*//////////////////////////////////////////////////////////////
                              pagination
    //////////////////////////////////////////////////////////////*/

    function _manyPays(uint256 n) internal {
        for (uint256 i; i < n; ++i) {
            _pay(alice, bob, 1);
        }
    }

    function test_Pagination_OrderingAndSecondPage() public {
        _manyPays(5);
        uint256[] memory all = c.sentPayments(alice, 0, 100);
        assertEq(all.length, 5);
        for (uint256 i; i < 5; ++i) {
            assertEq(all[i], i + 1);
        }
        uint256[] memory p2 = c.sentPayments(alice, 2, 2);
        assertEq(p2.length, 2);
        assertEq(p2[0], 3);
        assertEq(p2[1], 4);
        uint256[] memory tail = c.receivedPayments(bob, 3, 100);
        assertEq(tail.length, 2);
        assertEq(tail[0], 4);
        assertEq(tail[1], 5);
    }

    function test_Pagination_OffsetPastEndAndLimitZero() public {
        _manyPays(3);
        assertEq(c.sentPayments(alice, 3, 10).length, 0);
        assertEq(c.sentPayments(alice, 4, 10).length, 0);
        assertEq(c.sentPayments(alice, type(uint256).max, 100).length, 0);
        assertEq(c.sentPayments(alice, type(uint256).max, 0).length, 0);
        assertEq(c.sentPayments(alice, 0, 0).length, 0);
        assertEq(c.sentPayments(dave, 0, 10).length, 0);
    }

    function test_Pagination_PageTooLargeOnAllViews() public {
        bytes memory err = abi.encodeWithSelector(FluxoraPayments.PageTooLarge.selector, 101, 100);
        vm.expectRevert(err);
        c.sentPayments(alice, 0, 101);
        vm.expectRevert(err);
        c.receivedPayments(alice, 0, 101);
        vm.expectRevert(err);
        c.requestsOf(alice, 0, 101);
        // Limit check precedes the offset-past-end shortcut.
        vm.expectRevert(err);
        c.sentPayments(alice, 1_000, 101);
        vm.expectRevert(abi.encodeWithSelector(FluxoraPayments.PageTooLarge.selector, type(uint256).max, 100));
        c.sentPayments(alice, 0, type(uint256).max);
    }

    function test_Pagination_Limit100OkWithOver100Entries() public {
        _manyPays(101);
        uint256[] memory p1 = c.sentPayments(alice, 0, 100);
        assertEq(p1.length, 100);
        assertEq(p1[0], 1);
        assertEq(p1[99], 100);
        uint256[] memory p2 = c.sentPayments(alice, 100, 100);
        assertEq(p2.length, 1);
        assertEq(p2[0], 101);
        uint256[] memory p3 = c.receivedPayments(bob, 1, 100);
        assertEq(p3.length, 100);
        assertEq(p3[0], 2);
        assertEq(p3[99], 101);
    }

    function test_Pagination_RequestsOf() public {
        for (uint256 i; i < 4; ++i) {
            _req(alice, 1, 0);
        }
        uint256[] memory ids = c.requestsOf(alice, 1, 2);
        assertEq(ids.length, 2);
        assertEq(ids[0], 2);
        assertEq(ids[1], 3);
        assertEq(c.requestsOf(alice, 4, 5).length, 0);
        assertEq(c.requestsOf(bob, 0, 5).length, 0);
    }

    /*//////////////////////////////////////////////////////////////
                                  fuzz
    //////////////////////////////////////////////////////////////*/

    function testFuzz_PayConservesBalances(address recipient, uint256 amount, bytes32 ref) public {
        vm.assume(recipient != address(0) && recipient != alice && recipient != address(c));
        amount = bound(amount, 1, type(uint128).max);
        usdc.mint(alice, amount);
        uint256 supply = usdc.totalSupply();
        uint256 aBefore = usdc.balanceOf(alice);
        uint256 rBefore = usdc.balanceOf(recipient);

        vm.prank(alice);
        uint256 id = c.pay(recipient, amount, ref, "f");

        assertEq(usdc.balanceOf(alice), aBefore - amount);
        assertEq(usdc.balanceOf(recipient), rBefore + amount);
        assertEq(usdc.balanceOf(address(c)), 0);
        assertEq(usdc.totalSupply(), supply);
        (FluxoraPayments.Receipt memory r,) = c.getReceipt(id);
        assertEq(r.amount, amount);
        assertEq(r.recipient, recipient);
        assertEq(r.ref, ref);
    }

    function testFuzz_PayRequestConservesBalances(uint256 amount, uint64 expiryDelta) public {
        amount = bound(amount, 1, type(uint128).max);
        expiryDelta = uint64(bound(expiryDelta, 0, 1e9));
        usdc.mint(alice, amount);
        uint256 aBefore = usdc.balanceOf(alice);
        uint256 bBefore = usdc.balanceOf(bob);
        uint64 expiry = expiryDelta == 0 ? 0 : uint64(T0 + expiryDelta);
        uint256 rid = _req(bob, amount, expiry);
        vm.prank(alice);
        c.payRequest(rid);
        assertEq(usdc.balanceOf(alice), aBefore - amount);
        assertEq(usdc.balanceOf(bob), bBefore + amount);
        assertEq(usdc.balanceOf(address(c)), 0);
    }

    function testFuzz_MemoLengthBoundary(uint256 len) public {
        len = bound(len, 0, 400);
        string memory m = _bytesStr(len);
        if (len > 140) {
            vm.expectRevert(abi.encodeWithSelector(FluxoraPayments.MemoTooLong.selector, len, 140));
            vm.prank(alice);
            c.pay(bob, 1, bytes32(0), m);
            vm.expectRevert(abi.encodeWithSelector(FluxoraPayments.MemoTooLong.selector, len, 140));
            vm.prank(alice);
            c.createRequest(1, 0, bytes32(0), m);
            assertEq(c.nextPaymentId(), 1);
            assertEq(c.nextRequestId(), 1);
        } else {
            vm.prank(alice);
            uint256 id = c.pay(bob, 1, bytes32(0), m);
            (, string memory got) = c.getReceipt(id);
            assertEq(got, m);
            vm.prank(alice);
            uint256 rid = c.createRequest(1, 0, bytes32(0), m);
            (, string memory gotReq) = c.getRequest(rid);
            assertEq(gotReq, m);
        }
    }

    function testFuzz_ExpiryBoundary(uint64 delta, uint64 warpBy) public {
        delta = uint64(bound(delta, 1, 1e9));
        warpBy = uint64(bound(warpBy, 0, 2e9));
        uint256 rid = _req(bob, 1e6, uint64(T0 + delta));
        vm.warp(T0 + warpBy);
        if (warpBy <= delta) {
            assertEq(uint8(c.requestStatus(rid)), uint8(FluxoraPayments.RequestStatus.Open));
            vm.prank(alice);
            c.payRequest(rid);
        } else {
            assertEq(uint8(c.requestStatus(rid)), uint8(FluxoraPayments.RequestStatus.Expired));
            vm.prank(alice);
            vm.expectRevert(abi.encodeWithSelector(FluxoraPayments.RequestExpired.selector, rid));
            c.payRequest(rid);
        }
    }

    function testFuzz_PaginationMatchesModel(uint8 n, uint256 offset, uint256 limit) public {
        n = uint8(bound(n, 0, 12));
        limit = bound(limit, 0, 100);
        _manyPays(n);
        uint256[] memory page = c.sentPayments(alice, offset, limit);
        uint256 expected = offset >= n ? 0 : (n - offset < limit ? n - offset : limit);
        assertEq(page.length, expected);
        for (uint256 i; i < page.length; ++i) {
            assertEq(page[i], offset + i + 1);
        }
    }
}

/*//////////////////////////////////////////////////////////////
                          invariants
//////////////////////////////////////////////////////////////*/

contract FluxoraPaymentsInvariantTest is Test {
    FluxoraPayments internal c;
    MockERC20 internal usdc;
    FPHandler internal h;

    function setUp() public {
        vm.warp(1_700_000_000);
        usdc = new MockERC20("USD Coin", "USDC", 6);
        c = new FluxoraPayments(address(usdc));
        address[3] memory actors = [makeAddr("a1"), makeAddr("a2"), makeAddr("a3")];
        h = new FPHandler(c, usdc, actors);

        targetContract(address(h));
        bytes4[] memory sels = new bytes4[](5);
        sels[0] = FPHandler.pay.selector;
        sels[1] = FPHandler.createRequest.selector;
        sels[2] = FPHandler.payRequest.selector;
        sels[3] = FPHandler.cancelRequest.selector;
        sels[4] = FPHandler.warp.selector;
        targetSelector(FuzzSelector({addr: address(h), selectors: sels}));
    }

    function invariant_ContractNeverHoldsUsdc() public view {
        assertEq(usdc.balanceOf(address(c)), 0);
        assertEq(address(c).balance, 0);
    }

    function invariant_ReceiptAmountsSumToTotalMoved() public view {
        uint256 sum;
        uint256 last = c.nextPaymentId();
        for (uint256 id = 1; id < last; ++id) {
            (FluxoraPayments.Receipt memory r,) = c.getReceipt(id);
            sum += r.amount;
        }
        assertEq(sum, h.ghostMoved());
    }

    function invariant_IdsSequential() public view {
        assertEq(c.nextPaymentId(), h.ghostPayments() + 1);
        assertEq(c.nextRequestId(), h.ghostRequests() + 1);
        for (uint256 id = 1; id < c.nextPaymentId(); ++id) {
            (FluxoraPayments.Receipt memory r,) = c.getReceipt(id);
            assertTrue(r.payer != address(0));
            assertTrue(r.payer != r.recipient);
            assertGt(r.amount, 0);
        }
    }

    function invariant_SupplyConservedAmongActors() public view {
        assertEq(h.actorBalanceSum(), h.ghostMinted());
        assertEq(usdc.totalSupply(), h.ghostMinted());
    }

    function invariant_PaidRequestsLinkToReceipts() public view {
        for (uint256 id = 1; id < c.nextRequestId(); ++id) {
            (FluxoraPayments.Request memory q,) = c.getRequest(id);
            assertTrue(q.status != FluxoraPayments.RequestStatus.None);
            assertTrue(q.status != FluxoraPayments.RequestStatus.Expired);
            if (q.status == FluxoraPayments.RequestStatus.Paid) {
                (FluxoraPayments.Receipt memory r,) = c.getReceipt(q.paymentId);
                assertEq(r.requestId, id);
                assertEq(r.amount, q.amount);
                assertEq(r.payer, q.paidBy);
                assertEq(r.recipient, q.creator);
            } else {
                assertEq(q.paymentId, 0);
            }
        }
    }
}
