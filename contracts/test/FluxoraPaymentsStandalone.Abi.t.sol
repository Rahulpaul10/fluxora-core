// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Test} from "forge-std/Test.sol";
import {FluxoraPaymentsStandalone as FPS} from "../src/FluxoraPaymentsStandalone.sol";
import {MockERC20} from "./helpers/MockERC20.sol";

/// @dev The frontend only knows one payments ABI (the one the original FluxoraPayments contract exposed, archived in
///      contracts/archive/v1). This contract must keep every selector, topic, error and enum value of that ABI, and
///      answer the frontend views byte-for-byte like the original did (golden digests recorded from the original).
contract FluxoraPaymentsStandaloneAbiTest is Test {
    function _chk(bytes4 standalone, string memory sig) internal pure {
        assertEq(standalone, bytes4(keccak256(bytes(sig))), sig);
    }

    function _chkTopic(bytes32 standalone, string memory sig) internal pure {
        assertEq(standalone, keccak256(bytes(sig)), sig);
    }

    // ------------------------------------------------------------ function selectors
    function test_WriteFunctionSelectorsIdentical() public pure {
        _chk(FPS.pay.selector, "pay(address,address,uint256,bytes32,string,uint256)");
        _chk(FPS.createRequest.selector, "createRequest(address,uint256,uint64,bytes32,string)");
        _chk(FPS.payRequest.selector, "payRequest(uint256,uint256)");
        _chk(FPS.cancelRequest.selector, "cancelRequest(uint256)");
        _chk(FPS.setTokenSupported.selector, "setTokenSupported(address,bool)");
        _chk(FPS.setFeeBps.selector, "setFeeBps(uint256)");
        _chk(FPS.setFeeRecipient.selector, "setFeeRecipient(address)");
        _chk(FPS.pause.selector, "pause()");
        _chk(FPS.unpause.selector, "unpause()");
    }

    function test_ViewFunctionSelectorsIdentical() public view {
        FPS SA = FPS(address(0));
        _chk(SA.quoteFee.selector, "quoteFee(uint256)");
        _chk(SA.supportedTokens.selector, "supportedTokens(address)");
        _chk(SA.feeBps.selector, "feeBps()");
        _chk(SA.feeRecipient.selector, "feeRecipient()");
        _chk(SA.paused.selector, "paused()");
        _chk(SA.nextPaymentId.selector, "nextPaymentId()");
        _chk(SA.nextRequestId.selector, "nextRequestId()");
        _chk(SA.sentCount.selector, "sentCount(address)");
        _chk(SA.receivedCount.selector, "receivedCount(address)");
        _chk(SA.requestCount.selector, "requestCount(address)");
        _chk(SA.getSentIds.selector, "getSentIds(address,uint256,uint256)");
        _chk(SA.getReceivedIds.selector, "getReceivedIds(address,uint256,uint256)");
        _chk(SA.getRequestIds.selector, "getRequestIds(address,uint256,uint256)");
        _chk(SA.getReceipt.selector, "getReceipt(uint256)");
        _chk(SA.getRequest.selector, "getRequest(uint256)");
        _chk(SA.PAUSER_ROLE.selector, "PAUSER_ROLE()");
        _chk(SA.MAX_FEE_BPS.selector, "MAX_FEE_BPS()");
        _chk(SA.MAX_MEMO_BYTES.selector, "MAX_MEMO_BYTES()");
        _chk(SA.hasRole.selector, "hasRole(bytes32,address)");
        _chk(SA.grantRole.selector, "grantRole(bytes32,address)");
        _chk(SA.revokeRole.selector, "revokeRole(bytes32,address)");
        _chk(SA.DEFAULT_ADMIN_ROLE.selector, "DEFAULT_ADMIN_ROLE()");
    }

    // ------------------------------------------------------------ events
    function test_EventTopicsIdentical() public pure {
        _chkTopic(FPS.PaymentMade.selector, "PaymentMade(uint256,address,address,address,uint256,uint256,uint256,bytes32,string)");
        _chkTopic(FPS.RequestCreated.selector, "RequestCreated(uint256,address,address,uint256,uint64,bytes32,string)");
        _chkTopic(FPS.RequestCancelled.selector, "RequestCancelled(uint256,address)");
        _chkTopic(FPS.TokenSupportUpdated.selector, "TokenSupportUpdated(address,bool)");
        _chkTopic(FPS.FeeUpdated.selector, "FeeUpdated(uint256,address)");
    }

    // ------------------------------------------------------------ errors (every custom error of FluxoraPayments)
    function test_ErrorSelectorsIdentical() public pure {
        _chk(FPS.ZeroAddress.selector, "ZeroAddress()");
        _chk(FPS.InvalidToken.selector, "InvalidToken(address)");
        _chk(FPS.UnsupportedToken.selector, "UnsupportedToken(address)");
        _chk(FPS.InvalidRecipient.selector, "InvalidRecipient(address)");
        _chk(FPS.ZeroAmount.selector, "ZeroAmount()");
        _chk(FPS.MemoTooLong.selector, "MemoTooLong(uint256,uint256)");
        _chk(FPS.FeeTooHigh.selector, "FeeTooHigh(uint256,uint256)");
        _chk(FPS.InvalidFeeBps.selector, "InvalidFeeBps(uint256)");
        _chk(FPS.InvalidFeeRecipient.selector, "InvalidFeeRecipient(address)");
        _chk(FPS.InvalidExpiry.selector, "InvalidExpiry(uint64,uint256)");
        _chk(FPS.UnknownPayment.selector, "UnknownPayment(uint256)");
        _chk(FPS.UnknownRequest.selector, "UnknownRequest(uint256)");
        _chk(FPS.RequestNotOpen.selector, "RequestNotOpen(uint256)");
        _chk(FPS.RequestExpired.selector, "RequestExpired(uint256)");
        _chk(FPS.NotRequestCreator.selector, "NotRequestCreator(address,address)");
    }

    function test_EnumValuesIdentical() public pure {
        assertEq(uint8(FPS.RequestStatus.None), 0);
        assertEq(uint8(FPS.RequestStatus.Open), 1);
        assertEq(uint8(FPS.RequestStatus.Paid), 2);
        assertEq(uint8(FPS.RequestStatus.Cancelled), 3);
    }

    // ------------------------------------------------------------ golden behaviour of the original contract
    /// keccak256 of every frontend view's (success, returndata) after a fixed call sequence, recorded from the
    /// original FluxoraPayments contract. It also pins the struct layouts of getReceipt/getRequest.
    bytes32 internal constant GOLDEN_VIEWS = 0x146b6c428b394930a5c5406398ca2463b51d64fafc46880c0c9f1cd04d7eeab0;
    /// Same for the (success, revert data) of four failing calls.
    bytes32 internal constant GOLDEN_REVERTS = 0x52c323033f45001413e218cf7830298ad041aa24735091b3ac997aba848f1315;

    function test_ViewReturnDataMatchesOriginalContract() public {
        vm.warp(1_700_000_000);
        address dep = makeAddr("dep");
        address alice = makeAddr("alice");
        address bob = makeAddr("bob");
        address col = makeAddr("col");
        MockERC20 usdc = new MockERC20("USD Coin", "USDC", 6);
        usdc.mint(alice, 1_000e6);
        usdc.mint(bob, 1_000e6);
        address[] memory toks = new address[](1);
        toks[0] = address(usdc);
        vm.prank(dep);
        FPS t = new FPS(2 days, toks);
        vm.prank(alice);
        usdc.approve(address(t), type(uint256).max);
        vm.prank(bob);
        usdc.approve(address(t), type(uint256).max);

        vm.startPrank(dep);
        t.setFeeRecipient(col);
        t.setFeeBps(37);
        vm.stopPrank();
        vm.prank(alice);
        t.pay(address(usdc), bob, 123_457, bytes32(uint256(7)), "hello", 10_000);
        vm.prank(bob);
        uint256 rid = t.createRequest(address(usdc), 55e6, uint64(block.timestamp + 1 days), bytes32(uint256(9)), "inv");
        vm.prank(bob);
        t.createRequest(address(usdc), 1e6, 0, bytes32(0), "cancelme");
        vm.prank(alice);
        t.payRequest(rid, 1e6);
        vm.prank(bob);
        t.cancelRequest(2);

        bytes[] memory q = new bytes[](16);
        q[0] = abi.encodeCall(FPS.getReceipt, (1));
        q[1] = abi.encodeCall(FPS.getReceipt, (2));
        q[2] = abi.encodeCall(FPS.getReceipt, (3)); // unknown -> same error
        q[3] = abi.encodeCall(FPS.getRequest, (1));
        q[4] = abi.encodeCall(FPS.getRequest, (2));
        q[5] = abi.encodeCall(FPS.getRequest, (3)); // unknown -> same error
        q[6] = abi.encodeCall(FPS.getSentIds, (alice, 0, 10));
        q[7] = abi.encodeCall(FPS.getReceivedIds, (bob, 0, 10));
        q[8] = abi.encodeCall(FPS.getRequestIds, (bob, 0, 10));
        q[9] = abi.encodeCall(FPS.sentCount, (alice));
        q[10] = abi.encodeCall(FPS.receivedCount, (bob));
        q[11] = abi.encodeCall(FPS.requestCount, (bob));
        q[12] = abi.encodeCall(FPS.quoteFee, (987_654_321));
        q[13] = abi.encodeWithSignature("feeBps()");
        q[14] = abi.encodeWithSignature("nextPaymentId()");
        q[15] = abi.encodeWithSignature("nextRequestId()");
        bytes memory all;
        for (uint256 j; j < q.length; ++j) {
            (bool ok, bytes memory r) = address(t).staticcall(q[j]);
            all = bytes.concat(all, abi.encode(ok, r));
        }
        assertEq(keccak256(all), GOLDEN_VIEWS, "views differ from the original contract");
        assertEq(usdc.balanceOf(address(t)), 0, "payments must never hold funds");
    }

    function test_RevertDataMatchesOriginalContract() public {
        address dep = makeAddr("dep");
        address alice = makeAddr("alice");
        MockERC20 usdc = new MockERC20("USD Coin", "USDC", 6);
        address[] memory toks = new address[](1);
        toks[0] = address(usdc);
        vm.prank(dep);
        FPS t = new FPS(2 days, toks);
        bytes[4] memory cs = [
            abi.encodeCall(FPS.pay, (address(usdc), alice, 1, bytes32(0), "", 0)), // recipient == caller
            abi.encodeCall(FPS.createRequest, (address(usdc), 0, 0, bytes32(0), "")), // zero amount
            abi.encodeCall(FPS.payRequest, (9, 0)),
            abi.encodeCall(FPS.cancelRequest, (9))
        ];
        bytes memory all;
        for (uint256 i; i < cs.length; ++i) {
            vm.prank(alice);
            (bool ok, bytes memory r) = address(t).call(cs[i]);
            assertFalse(ok);
            all = bytes.concat(all, abi.encode(ok, r));
        }
        assertEq(keccak256(all), GOLDEN_REVERTS, "revert data differs from the original contract");
    }
}
