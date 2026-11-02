// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Test} from "forge-std/Test.sol";
import {FluxoraPayments} from "../src/FluxoraPayments.sol";
import {FluxoraPaymentsStandalone as FPS} from "../src/FluxoraPaymentsStandalone.sol";
import {MockERC20} from "./helpers/MockERC20.sol";

/// @dev The frontend only knows one ABI: both contracts must expose identical selectors/topics.
contract FluxoraPaymentsStandaloneAbiTest is Test {
    function _chk(bytes4 original, bytes4 standalone, string memory sig) internal pure {
        assertEq(standalone, original, sig);
        assertEq(standalone, bytes4(keccak256(bytes(sig))), sig);
    }

    function _chkTopic(bytes32 original, bytes32 standalone, string memory sig) internal pure {
        assertEq(standalone, original, sig);
        assertEq(standalone, keccak256(bytes(sig)), sig);
    }

    // ------------------------------------------------------------ function selectors
    function test_WriteFunctionSelectorsIdentical() public pure {
        _chk(
            FluxoraPayments.pay.selector,
            FPS.pay.selector,
            "pay(address,address,uint256,bytes32,string,uint256)"
        );
        _chk(
            FluxoraPayments.createRequest.selector,
            FPS.createRequest.selector,
            "createRequest(address,uint256,uint64,bytes32,string)"
        );
        _chk(FluxoraPayments.payRequest.selector, FPS.payRequest.selector, "payRequest(uint256,uint256)");
        _chk(FluxoraPayments.cancelRequest.selector, FPS.cancelRequest.selector, "cancelRequest(uint256)");
        _chk(
            FluxoraPayments.setTokenSupported.selector,
            FPS.setTokenSupported.selector,
            "setTokenSupported(address,bool)"
        );
        _chk(FluxoraPayments.setFeeBps.selector, FPS.setFeeBps.selector, "setFeeBps(uint256)");
        _chk(FluxoraPayments.setFeeRecipient.selector, FPS.setFeeRecipient.selector, "setFeeRecipient(address)");
        _chk(FluxoraPayments.pause.selector, FPS.pause.selector, "pause()");
        _chk(FluxoraPayments.unpause.selector, FPS.unpause.selector, "unpause()");
    }

    function test_ViewFunctionSelectorsIdentical() public view {
        FluxoraPayments OA = FluxoraPayments(address(0));
        FPS SA = FPS(address(0));
        _chk(OA.quoteFee.selector, SA.quoteFee.selector, "quoteFee(uint256)");
        _chk(OA.supportedTokens.selector, SA.supportedTokens.selector, "supportedTokens(address)");
        _chk(OA.feeBps.selector, SA.feeBps.selector, "feeBps()");
        _chk(OA.feeRecipient.selector, SA.feeRecipient.selector, "feeRecipient()");
        _chk(OA.paused.selector, SA.paused.selector, "paused()");
        _chk(OA.nextPaymentId.selector, SA.nextPaymentId.selector, "nextPaymentId()");
        _chk(OA.nextRequestId.selector, SA.nextRequestId.selector, "nextRequestId()");
        _chk(OA.sentCount.selector, SA.sentCount.selector, "sentCount(address)");
        _chk(OA.receivedCount.selector, SA.receivedCount.selector, "receivedCount(address)");
        _chk(OA.requestCount.selector, SA.requestCount.selector, "requestCount(address)");
        _chk(
            OA.getSentIds.selector, SA.getSentIds.selector, "getSentIds(address,uint256,uint256)"
        );
        _chk(
            OA.getReceivedIds.selector,
            SA.getReceivedIds.selector,
            "getReceivedIds(address,uint256,uint256)"
        );
        _chk(
            OA.getRequestIds.selector,
            SA.getRequestIds.selector,
            "getRequestIds(address,uint256,uint256)"
        );
        _chk(OA.getReceipt.selector, SA.getReceipt.selector, "getReceipt(uint256)");
        _chk(OA.getRequest.selector, SA.getRequest.selector, "getRequest(uint256)");
        _chk(OA.PAUSER_ROLE.selector, SA.PAUSER_ROLE.selector, "PAUSER_ROLE()");
        _chk(OA.MAX_FEE_BPS.selector, SA.MAX_FEE_BPS.selector, "MAX_FEE_BPS()");
        _chk(OA.MAX_MEMO_BYTES.selector, SA.MAX_MEMO_BYTES.selector, "MAX_MEMO_BYTES()");
        _chk(OA.hasRole.selector, SA.hasRole.selector, "hasRole(bytes32,address)");
        _chk(OA.grantRole.selector, SA.grantRole.selector, "grantRole(bytes32,address)");
        _chk(OA.revokeRole.selector, SA.revokeRole.selector, "revokeRole(bytes32,address)");
        _chk(OA.DEFAULT_ADMIN_ROLE.selector, SA.DEFAULT_ADMIN_ROLE.selector, "DEFAULT_ADMIN_ROLE()");
    }

    // ------------------------------------------------------------ events
    function test_EventTopicsIdentical() public pure {
        _chkTopic(
            FluxoraPayments.PaymentMade.selector,
            FPS.PaymentMade.selector,
            "PaymentMade(uint256,address,address,address,uint256,uint256,uint256,bytes32,string)"
        );
        _chkTopic(
            FluxoraPayments.RequestCreated.selector,
            FPS.RequestCreated.selector,
            "RequestCreated(uint256,address,address,uint256,uint64,bytes32,string)"
        );
        _chkTopic(
            FluxoraPayments.RequestCancelled.selector,
            FPS.RequestCancelled.selector,
            "RequestCancelled(uint256,address)"
        );
        _chkTopic(
            FluxoraPayments.TokenSupportUpdated.selector,
            FPS.TokenSupportUpdated.selector,
            "TokenSupportUpdated(address,bool)"
        );
        _chkTopic(FluxoraPayments.FeeUpdated.selector, FPS.FeeUpdated.selector, "FeeUpdated(uint256,address)");
    }

    // ------------------------------------------------------------ errors (every custom error of FluxoraPayments)
    function test_ErrorSelectorsIdentical() public pure {
        _chk(FluxoraPayments.ZeroAddress.selector, FPS.ZeroAddress.selector, "ZeroAddress()");
        _chk(FluxoraPayments.InvalidToken.selector, FPS.InvalidToken.selector, "InvalidToken(address)");
        _chk(FluxoraPayments.UnsupportedToken.selector, FPS.UnsupportedToken.selector, "UnsupportedToken(address)");
        _chk(
            FluxoraPayments.InvalidRecipient.selector, FPS.InvalidRecipient.selector, "InvalidRecipient(address)"
        );
        _chk(FluxoraPayments.ZeroAmount.selector, FPS.ZeroAmount.selector, "ZeroAmount()");
        _chk(FluxoraPayments.MemoTooLong.selector, FPS.MemoTooLong.selector, "MemoTooLong(uint256,uint256)");
        _chk(FluxoraPayments.FeeTooHigh.selector, FPS.FeeTooHigh.selector, "FeeTooHigh(uint256,uint256)");
        _chk(FluxoraPayments.InvalidFeeBps.selector, FPS.InvalidFeeBps.selector, "InvalidFeeBps(uint256)");
        _chk(
            FluxoraPayments.InvalidFeeRecipient.selector,
            FPS.InvalidFeeRecipient.selector,
            "InvalidFeeRecipient(address)"
        );
        _chk(
            FluxoraPayments.InvalidExpiry.selector, FPS.InvalidExpiry.selector, "InvalidExpiry(uint64,uint256)"
        );
        _chk(FluxoraPayments.UnknownPayment.selector, FPS.UnknownPayment.selector, "UnknownPayment(uint256)");
        _chk(FluxoraPayments.UnknownRequest.selector, FPS.UnknownRequest.selector, "UnknownRequest(uint256)");
        _chk(FluxoraPayments.RequestNotOpen.selector, FPS.RequestNotOpen.selector, "RequestNotOpen(uint256)");
        _chk(FluxoraPayments.RequestExpired.selector, FPS.RequestExpired.selector, "RequestExpired(uint256)");
        _chk(
            FluxoraPayments.NotRequestCreator.selector,
            FPS.NotRequestCreator.selector,
            "NotRequestCreator(address,address)"
        );
    }

    function test_EnumValuesIdentical() public pure {
        assertEq(uint8(FPS.RequestStatus.None), uint8(FluxoraPayments.RequestStatus.None));
        assertEq(uint8(FPS.RequestStatus.Open), uint8(FluxoraPayments.RequestStatus.Open));
        assertEq(uint8(FPS.RequestStatus.Paid), uint8(FluxoraPayments.RequestStatus.Paid));
        assertEq(uint8(FPS.RequestStatus.Cancelled), uint8(FluxoraPayments.RequestStatus.Cancelled));
    }

    // ------------------------------------------------------------ behavioural differential
    /// Run the same call sequence against both contracts and require byte-identical return data for
    /// every frontend view (this also pins the struct layouts of getReceipt/getRequest).
    function test_DifferentialViewReturnDataIdentical() public {
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

        FluxoraPayments a = new FluxoraPayments(dep, dep, toks);
        vm.prank(dep);
        FPS b = new FPS(2 days, toks);

        vm.startPrank(alice);
        usdc.approve(address(a), type(uint256).max);
        usdc.approve(address(b), type(uint256).max);
        vm.stopPrank();
        vm.startPrank(bob);
        usdc.approve(address(a), type(uint256).max);
        usdc.approve(address(b), type(uint256).max);
        vm.stopPrank();

        address[2] memory targets = [address(a), address(b)];
        for (uint256 i; i < 2; ++i) {
            address t = targets[i];
            vm.startPrank(dep);
            FPS(t).setFeeRecipient(col);
            FPS(t).setFeeBps(37);
            vm.stopPrank();
            vm.prank(alice);
            FPS(t).pay(address(usdc), bob, 123_457, bytes32(uint256(7)), "hello", 10_000);
            vm.prank(bob);
            uint256 rid = FPS(t).createRequest(address(usdc), 55e6, uint64(block.timestamp + 1 days), bytes32(uint256(9)), "inv");
            vm.prank(bob);
            FPS(t).createRequest(address(usdc), 1e6, 0, bytes32(0), "cancelme");
            vm.prank(alice);
            FPS(t).payRequest(rid, 1e6);
            vm.prank(bob);
            FPS(t).cancelRequest(2);
        }

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
        for (uint256 j; j < q.length; ++j) {
            (bool okA, bytes memory ra) = address(a).staticcall(q[j]);
            (bool okB, bytes memory rb) = address(b).staticcall(q[j]);
            assertEq(okB, okA, "success flag");
            assertEq(rb, ra, "return data");
        }
        assertEq(usdc.balanceOf(address(a)), 0);
        assertEq(usdc.balanceOf(address(b)), 0);
    }

    /// Revert data of a failing call (custom error + args) is byte-identical too.
    function test_DifferentialRevertDataIdentical() public {
        address dep = makeAddr("dep");
        address alice = makeAddr("alice");
        MockERC20 usdc = new MockERC20("USD Coin", "USDC", 6);
        address[] memory toks = new address[](1);
        toks[0] = address(usdc);
        FluxoraPayments a = new FluxoraPayments(dep, dep, toks);
        vm.prank(dep);
        FPS b = new FPS(2 days, toks);
        bytes memory c1 = abi.encodeCall(FPS.pay, (address(usdc), alice, 1, bytes32(0), "", 0)); // recipient == caller
        bytes memory c2 = abi.encodeCall(FPS.createRequest, (address(usdc), 0, 0, bytes32(0), "")); // zero amount
        bytes memory c3 = abi.encodeCall(FPS.payRequest, (9, 0));
        bytes memory c4 = abi.encodeCall(FPS.cancelRequest, (9));
        bytes[4] memory cs = [c1, c2, c3, c4];
        for (uint256 i; i < cs.length; ++i) {
            vm.prank(alice);
            (bool okA, bytes memory ra) = address(a).call(cs[i]);
            vm.prank(alice);
            (bool okB, bytes memory rb) = address(b).call(cs[i]);
            assertFalse(okA);
            assertFalse(okB);
            assertEq(rb, ra);
        }
    }
}
