// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Test} from "forge-std/Test.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Fluxora} from "../Fluxora.sol";
import {
    SecToken,
    SecFeeOnTransferToken,
    SecInflatingToken,
    SecRebasingToken,
    SecReentrantToken
} from "./helpers/FluxoraSecurityMocks.sol";

abstract contract FluxoraSecBase is Test {
    Fluxora internal f;
    SecToken internal tok;

    address internal owner = makeAddr("owner");
    address internal buyer = makeAddr("buyer");
    address internal seller = makeAddr("seller");
    address internal arbiter = makeAddr("arbiter");
    address internal feeCol = makeAddr("feeCol");
    address internal stranger = makeAddr("stranger");
    address internal altDest = makeAddr("altDest");

    uint256 internal constant AMT = 1_000e6;
    uint256 internal constant DUR = 30 days;
    uint256 internal constant WINDOW = 14 days;

    function setUp() public virtual {
        vm.warp(1_700_000_000);
        tok = new SecToken();
        address[] memory t = new address[](1);
        t[0] = address(tok);
        f = new Fluxora(owner, t);
        tok.mint(buyer, 1e30);
        vm.prank(buyer);
        tok.approve(address(f), type(uint256).max);
    }

    /// @dev Creates a Pending escrow (funds locked, awaiting seller acceptance).
    function _createP(uint256 amount, address arb, bool roe) internal returns (uint256 id) {
        uint256 rd = block.timestamp + DUR;
        vm.prank(buyer);
        id = f.createEscrow(address(tok), seller, arb, amount, rd, roe, bytes32("ref"));
    }

    function _createPending(uint256 amount, address arb) internal returns (uint256 id) {
        id = _createP(amount, arb, false);
    }

    function _accept(uint256 id) internal {
        vm.prank(seller);
        f.acceptEscrow(id);
    }

    /// @dev Creates AND accepts: a Funded escrow with releaseOnExpiry == false.
    function _create(uint256 amount, address arb) internal returns (uint256 id) {
        id = _createP(amount, arb, false);
        _accept(id);
    }

    /// @dev Creates AND accepts: a Funded escrow with releaseOnExpiry == true.
    function _createRoe(uint256 amount, address arb) internal returns (uint256 id) {
        id = _createP(amount, arb, true);
        _accept(id);
    }

    function _setFee(uint256 bps) internal {
        vm.prank(owner);
        f.setFeeBps(bps);
    }

    function _setCollector(address c) internal {
        vm.prank(owner);
        f.setFeeRecipient(c);
    }

    function _status(uint256 id) internal view returns (Fluxora.Status) {
        return f.getEscrow(id).status;
    }

    function _invalidStatus(uint256 id, Fluxora.Status s) internal pure returns (bytes memory) {
        return abi.encodeWithSelector(Fluxora.InvalidStatus.selector, id, s);
    }

    function _notOwner(address who) internal pure returns (bytes memory) {
        return abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, who);
    }

    function _dispute(uint256 id) internal {
        vm.prank(buyer);
        f.dispute(id);
    }
}

contract FluxoraSecurityTest is FluxoraSecBase {
    // ───────────────────────── Happy paths ─────────────────────────

    function test_Create_EmitsAndStoresTerms() public {
        _setFee(50);
        _setCollector(feeCol);
        uint256 rd = block.timestamp + DUR;
        vm.expectEmit(true, true, true, true, address(f));
        emit Fluxora.EscrowCreated(
            1, buyer, seller, address(tok), arbiter, AMT, rd, rd + 7 days, 5e6, feeCol, true, bytes32("ref")
        );
        uint256 id = _createP(AMT, arbiter, true);
        assertEq(id, 1);
        Fluxora.Escrow memory e = f.getEscrow(id);
        assertEq(e.fee, 5e6);
        assertEq(e.refundDeadline, e.releaseDeadline + 7 days);
        assertEq(uint8(e.status), uint8(Fluxora.Status.Pending));
        assertEq(e.disputeDeadline, 0);
        assertTrue(e.releaseOnExpiry);
        assertEq(tok.balanceOf(address(f)), AMT); // funds are locked while Pending
        assertEq(f.escrowCount(buyer), 1);
        assertEq(f.escrowCount(seller), 1);
        assertEq(f.escrowCount(arbiter), 0);
    }

    function test_Accept_BySeller_EmitsAndFunds() public {
        uint256 id = _createPending(AMT, arbiter);
        vm.expectEmit(true, true, false, false, address(f));
        emit Fluxora.EscrowAccepted(id, seller);
        _accept(id);
        assertEq(uint8(_status(id)), uint8(Fluxora.Status.Funded));
        assertEq(tok.balanceOf(address(f)), AMT);
    }

    function test_Cancel_ByBuyer_RefundsInFull() public {
        _setFee(100);
        uint256 id = _createPending(AMT, arbiter);
        uint256 before_ = tok.balanceOf(buyer);
        vm.expectEmit(true, true, false, false, address(f));
        emit Fluxora.EscrowCancelled(id, buyer);
        vm.expectEmit(true, true, false, true, address(f));
        emit Fluxora.EscrowRefunded(id, buyer, AMT);
        vm.prank(buyer);
        f.cancel(id);
        assertEq(tok.balanceOf(buyer), before_ + AMT);
        assertEq(tok.balanceOf(address(f)), 0);
        assertEq(tok.balanceOf(owner), 0); // no fee on cancel
        assertEq(uint8(_status(id)), uint8(Fluxora.Status.Refunded));
    }

    function test_Cancel_BySeller_RefundsBuyerInFull() public {
        uint256 id = _createPending(AMT, address(0));
        uint256 before_ = tok.balanceOf(buyer);
        vm.expectEmit(true, true, false, false, address(f));
        emit Fluxora.EscrowCancelled(id, seller);
        vm.prank(seller);
        f.cancel(id);
        assertEq(tok.balanceOf(buyer), before_ + AMT);
        assertEq(tok.balanceOf(seller), 0);
        assertEq(uint8(_status(id)), uint8(Fluxora.Status.Refunded));
    }

    function test_Release_ByBuyer_PaysSellerAndFee() public {
        _setFee(100);
        _setCollector(feeCol);
        uint256 id = _create(AMT, address(0));
        vm.expectEmit(true, true, false, true, address(f));
        emit Fluxora.EscrowReleased(id, buyer, 990e6, 10e6);
        vm.prank(buyer);
        f.release(id);
        assertEq(tok.balanceOf(seller), 990e6);
        assertEq(tok.balanceOf(feeCol), 10e6);
        assertEq(tok.balanceOf(address(f)), 0);
        assertEq(uint8(_status(id)), uint8(Fluxora.Status.Released));
    }

    /// @dev Converted: the arbiter used to be able to release a Funded escrow; no longer.
    function test_Release_ByArbiter_OnFunded_NowUnauthorized() public {
        uint256 id = _create(AMT, arbiter);
        vm.prank(arbiter);
        vm.expectRevert(Fluxora.Unauthorized.selector);
        f.release(id);
        assertEq(uint8(_status(id)), uint8(Fluxora.Status.Funded));
        assertEq(tok.balanceOf(address(f)), AMT);
    }

    function test_Refund_BySeller_NoFee() public {
        _setFee(100);
        uint256 id = _create(AMT, address(0));
        uint256 before_ = tok.balanceOf(buyer);
        vm.expectEmit(true, true, false, true, address(f));
        emit Fluxora.EscrowRefunded(id, seller, AMT);
        vm.prank(seller);
        f.refund(id);
        assertEq(tok.balanceOf(buyer), before_ + AMT);
        assertEq(tok.balanceOf(address(f)), 0);
        assertEq(uint8(_status(id)), uint8(Fluxora.Status.Refunded));
    }

    /// @dev Converted: the arbiter used to be able to refund a Funded escrow; no longer.
    function test_Refund_ByArbiter_OnFunded_NowUnauthorized() public {
        uint256 id = _create(AMT, arbiter);
        vm.prank(arbiter);
        vm.expectRevert(Fluxora.Unauthorized.selector);
        f.refund(id);
        vm.warp(f.getEscrow(id).refundDeadline + 1);
        vm.prank(arbiter);
        vm.expectRevert(Fluxora.Unauthorized.selector);
        f.refund(id);
        assertEq(uint8(_status(id)), uint8(Fluxora.Status.Funded));
    }

    function test_Refund_ByBuyer_AfterRefundDeadline() public {
        uint256 id = _create(AMT, address(0));
        vm.warp(f.getEscrow(id).refundDeadline);
        vm.prank(buyer);
        f.refund(id);
        assertEq(uint8(_status(id)), uint8(Fluxora.Status.Refunded));
        assertEq(tok.balanceOf(address(f)), 0);
    }

    /// @dev Converted: with releaseOnExpiry the buyer may never reclaim, even long after expiry.
    function test_Refund_ByBuyer_WhenReleaseOnExpiry_RefundNotAvailable() public {
        uint256 id = _createRoe(AMT, address(0));
        vm.warp(f.getEscrow(id).refundDeadline);
        vm.prank(buyer);
        vm.expectRevert(Fluxora.RefundNotAvailable.selector);
        f.refund(id);
        vm.warp(block.timestamp + 400 days);
        vm.prank(buyer);
        vm.expectRevert(Fluxora.RefundNotAvailable.selector);
        f.refund(id);
        assertEq(uint8(_status(id)), uint8(Fluxora.Status.Funded));
    }

    function test_ReleaseExpired_PaysSellerMinusFee() public {
        _setFee(100);
        _setCollector(feeCol);
        uint256 id = _createRoe(AMT, address(0));
        vm.warp(f.getEscrow(id).refundDeadline);
        vm.expectEmit(true, true, false, true, address(f));
        emit Fluxora.EscrowReleased(id, stranger, 990e6, 10e6);
        vm.prank(stranger);
        f.releaseExpired(id);
        assertEq(tok.balanceOf(seller), 990e6);
        assertEq(tok.balanceOf(feeCol), 10e6);
        assertEq(tok.balanceOf(address(f)), 0);
        assertEq(uint8(_status(id)), uint8(Fluxora.Status.Released));
    }

    function test_Dispute_SetsDeadlineAndEmits() public {
        uint256 id = _create(AMT, arbiter);
        vm.expectEmit(true, true, false, false, address(f));
        emit Fluxora.EscrowDisputed(id, seller);
        vm.prank(seller);
        f.dispute(id);
        Fluxora.Escrow memory e = f.getEscrow(id);
        assertEq(uint8(e.status), uint8(Fluxora.Status.Disputed));
        assertEq(e.disputeDeadline, block.timestamp + 14 days);
        assertEq(f.ARBITRATION_WINDOW(), 14 days);
    }

    function test_Dispute_ThenResolveToSeller_WithFee() public {
        _setFee(100);
        _setCollector(feeCol);
        uint256 id = _create(AMT, arbiter);
        vm.prank(seller);
        f.dispute(id);
        vm.expectEmit(true, true, false, true, address(f));
        emit Fluxora.EscrowResolved(id, arbiter, true);
        vm.prank(arbiter);
        f.resolve(id, true);
        assertEq(tok.balanceOf(seller), 990e6);
        assertEq(tok.balanceOf(feeCol), 10e6);
        assertEq(uint8(_status(id)), uint8(Fluxora.Status.Released));
    }

    function test_Dispute_ThenResolveToBuyer_NoFee() public {
        _setFee(100);
        _setCollector(feeCol);
        uint256 id = _create(AMT, arbiter);
        uint256 before_ = tok.balanceOf(buyer);
        _dispute(id);
        vm.prank(arbiter);
        f.resolve(id, false);
        assertEq(tok.balanceOf(buyer), before_ + AMT);
        assertEq(tok.balanceOf(feeCol), 0);
        assertEq(uint8(_status(id)), uint8(Fluxora.Status.Refunded));
    }

    function test_ResolveExpired_SplitsAndEmits() public {
        _setFee(100);
        _setCollector(feeCol);
        uint256 id = _create(AMT, arbiter);
        _dispute(id);
        vm.warp(f.getEscrow(id).disputeDeadline);
        uint256 buyerBefore = tok.balanceOf(buyer);
        vm.expectEmit(true, true, false, true, address(f));
        emit Fluxora.EscrowSplit(id, stranger, 495e6, 5e6, 500e6);
        vm.prank(stranger);
        f.resolveExpired(id);
        assertEq(tok.balanceOf(seller), 495e6);
        assertEq(tok.balanceOf(feeCol), 5e6);
        assertEq(tok.balanceOf(buyer), buyerBefore + 500e6);
        assertEq(tok.balanceOf(address(f)), 0);
        assertEq(uint8(_status(id)), uint8(Fluxora.Status.Split));
    }

    // ───────────────────────── Revert paths: createEscrow ─────────────────────────

    function test_Revert_Create_UnsupportedToken() public {
        SecToken other = new SecToken();
        vm.prank(buyer);
        vm.expectRevert(abi.encodeWithSelector(Fluxora.UnsupportedToken.selector, address(other)));
        f.createEscrow(address(other), seller, address(0), AMT, block.timestamp + DUR, false, 0);
    }

    function test_Revert_Create_ZeroSeller() public {
        vm.prank(buyer);
        vm.expectRevert(Fluxora.ZeroAddress.selector);
        f.createEscrow(address(tok), address(0), address(0), AMT, block.timestamp + DUR, false, 0);
    }

    function test_Revert_Create_SellerIsBuyerOrContract() public {
        vm.startPrank(buyer);
        vm.expectRevert(abi.encodeWithSelector(Fluxora.InvalidActor.selector, buyer));
        f.createEscrow(address(tok), buyer, address(0), AMT, block.timestamp + DUR, false, 0);
        vm.expectRevert(abi.encodeWithSelector(Fluxora.InvalidActor.selector, address(f)));
        f.createEscrow(address(tok), address(f), address(0), AMT, block.timestamp + DUR, false, 0);
        vm.stopPrank();
    }

    function test_Revert_Create_BadArbiter() public {
        vm.startPrank(buyer);
        vm.expectRevert(abi.encodeWithSelector(Fluxora.InvalidActor.selector, buyer));
        f.createEscrow(address(tok), seller, buyer, AMT, block.timestamp + DUR, false, 0);
        vm.expectRevert(abi.encodeWithSelector(Fluxora.InvalidActor.selector, seller));
        f.createEscrow(address(tok), seller, seller, AMT, block.timestamp + DUR, false, 0);
        vm.expectRevert(abi.encodeWithSelector(Fluxora.InvalidActor.selector, address(f)));
        f.createEscrow(address(tok), seller, address(f), AMT, block.timestamp + DUR, false, 0);
        vm.stopPrank();
    }

    function test_Revert_Create_ZeroAmount() public {
        vm.prank(buyer);
        vm.expectRevert(Fluxora.ZeroAmount.selector);
        f.createEscrow(address(tok), seller, address(0), 0, block.timestamp + DUR, false, 0);
    }

    function test_Revert_Create_DeadlineNotFuture() public {
        vm.startPrank(buyer);
        vm.expectRevert(abi.encodeWithSelector(Fluxora.InvalidDeadline.selector, block.timestamp));
        f.createEscrow(address(tok), seller, address(0), AMT, block.timestamp, false, 0);
        vm.expectRevert(abi.encodeWithSelector(Fluxora.InvalidDeadline.selector, block.timestamp - 1));
        f.createEscrow(address(tok), seller, address(0), AMT, block.timestamp - 1, false, 0);
        vm.stopPrank();
    }

    function test_Revert_Create_WhenPaused() public {
        vm.prank(owner);
        f.pause();
        vm.prank(buyer);
        vm.expectRevert(Pausable.EnforcedPause.selector);
        f.createEscrow(address(tok), seller, address(0), AMT, block.timestamp + DUR, false, 0);
    }

    function test_Revert_Create_NoAllowanceOrBalance() public {
        vm.prank(stranger);
        vm.expectRevert();
        f.createEscrow(address(tok), seller, address(0), AMT, block.timestamp + DUR, false, 0);
    }

    // ───────────────────────── Revert paths: settlement ─────────────────────────

    function test_Revert_UnknownEscrow() public {
        bytes memory u42 = abi.encodeWithSelector(Fluxora.UnknownEscrow.selector, 42);
        vm.expectRevert(u42);
        f.getEscrow(42);
        vm.expectRevert(u42);
        f.release(42);
        vm.expectRevert(abi.encodeWithSelector(Fluxora.UnknownEscrow.selector, 0));
        f.refund(0);
        vm.expectRevert(u42);
        f.dispute(42);
        vm.expectRevert(u42);
        f.resolve(42, true);
        vm.expectRevert(u42);
        f.acceptEscrow(42);
        vm.expectRevert(u42);
        f.cancel(42);
        vm.expectRevert(u42);
        f.releaseExpired(42);
        vm.expectRevert(u42);
        f.resolveExpired(42);
    }

    function test_Revert_Release_WrongCaller() public {
        uint256 id = _create(AMT, arbiter);
        address[4] memory bad = [seller, stranger, owner, arbiter];
        for (uint256 i; i < bad.length; ++i) {
            vm.prank(bad[i]);
            vm.expectRevert(Fluxora.Unauthorized.selector);
            f.release(id);
        }
    }

    function test_Revert_Release_AfterDeadline() public {
        uint256 id = _create(AMT, arbiter);
        vm.warp(f.getEscrow(id).releaseDeadline);
        vm.prank(buyer);
        vm.expectRevert(Fluxora.ReleaseWindowClosed.selector);
        f.release(id);
    }

    function test_Revert_Release_TwiceAndAfterRefundAndDisputed() public {
        uint256 id = _create(AMT, arbiter);
        vm.prank(buyer);
        f.release(id);
        vm.prank(buyer);
        vm.expectRevert(_invalidStatus(id, Fluxora.Status.Released));
        f.release(id);

        uint256 id2 = _create(AMT, arbiter);
        vm.prank(seller);
        f.refund(id2);
        vm.prank(buyer);
        vm.expectRevert(_invalidStatus(id2, Fluxora.Status.Refunded));
        f.release(id2);

        uint256 id3 = _create(AMT, arbiter);
        _dispute(id3);
        vm.prank(buyer);
        vm.expectRevert(_invalidStatus(id3, Fluxora.Status.Disputed));
        f.release(id3);
    }

    function test_Revert_Refund_WrongCallerAndEarlyBuyer() public {
        uint256 id = _create(AMT, arbiter);
        address[3] memory bad = [stranger, owner, arbiter];
        for (uint256 i; i < bad.length; ++i) {
            vm.prank(bad[i]);
            vm.expectRevert(Fluxora.Unauthorized.selector);
            f.refund(id);
        }
        vm.prank(buyer);
        vm.expectRevert(Fluxora.RefundNotAvailable.selector);
        f.refund(id);
    }

    function test_Revert_Refund_TwiceAndDisputed() public {
        uint256 id = _create(AMT, arbiter);
        vm.prank(seller);
        f.refund(id);
        vm.prank(seller);
        vm.expectRevert(_invalidStatus(id, Fluxora.Status.Refunded));
        f.refund(id);

        uint256 id2 = _create(AMT, arbiter);
        vm.prank(seller);
        f.dispute(id2);
        vm.prank(seller);
        vm.expectRevert(_invalidStatus(id2, Fluxora.Status.Disputed));
        f.refund(id2);
        vm.prank(arbiter);
        vm.expectRevert(_invalidStatus(id2, Fluxora.Status.Disputed));
        f.refund(id2);
    }

    function test_Revert_Dispute_WrongCaller() public {
        uint256 id = _create(AMT, arbiter);
        address[3] memory bad = [arbiter, stranger, owner];
        for (uint256 i; i < bad.length; ++i) {
            vm.prank(bad[i]);
            vm.expectRevert(Fluxora.Unauthorized.selector);
            f.dispute(id);
        }
    }

    function test_Revert_Dispute_WindowClosedAndTwice() public {
        uint256 id = _create(AMT, arbiter);
        vm.warp(f.getEscrow(id).refundDeadline);
        vm.prank(buyer);
        vm.expectRevert(Fluxora.DisputeWindowClosed.selector);
        f.dispute(id);

        uint256 id2 = _create(AMT, arbiter);
        _dispute(id2);
        vm.prank(seller);
        vm.expectRevert(_invalidStatus(id2, Fluxora.Status.Disputed));
        f.dispute(id2);
    }

    function test_Revert_Resolve_WrongCallerAndWrongStatus() public {
        uint256 id = _create(AMT, arbiter);
        vm.prank(arbiter);
        vm.expectRevert(_invalidStatus(id, Fluxora.Status.Funded));
        f.resolve(id, true);

        _dispute(id);
        address[4] memory bad = [buyer, seller, stranger, owner];
        for (uint256 i; i < bad.length; ++i) {
            vm.prank(bad[i]);
            vm.expectRevert(Fluxora.Unauthorized.selector);
            f.resolve(id, true);
        }
        vm.prank(arbiter);
        f.resolve(id, true);
        vm.prank(arbiter);
        vm.expectRevert(_invalidStatus(id, Fluxora.Status.Released));
        f.resolve(id, false);
    }

    function test_Revert_Accept_NonSellerAndWrongStatus() public {
        uint256 id = _createPending(AMT, arbiter);
        address[4] memory bad = [buyer, stranger, arbiter, owner];
        for (uint256 i; i < bad.length; ++i) {
            vm.prank(bad[i]);
            vm.expectRevert(Fluxora.Unauthorized.selector);
            f.acceptEscrow(id);
        }
        _accept(id);
        vm.prank(seller);
        vm.expectRevert(_invalidStatus(id, Fluxora.Status.Funded));
        f.acceptEscrow(id);

        uint256 id2 = _createPending(AMT, arbiter);
        vm.prank(buyer);
        f.cancel(id2);
        vm.prank(seller);
        vm.expectRevert(_invalidStatus(id2, Fluxora.Status.Refunded));
        f.acceptEscrow(id2);
    }

    function test_Revert_Accept_AtOrAfterReleaseDeadline() public {
        uint256 id = _createPending(AMT, arbiter);
        uint256 rd = f.getEscrow(id).releaseDeadline;
        vm.warp(rd);
        vm.prank(seller);
        vm.expectRevert(Fluxora.ReleaseWindowClosed.selector);
        f.acceptEscrow(id);
        vm.warp(rd + 100 days);
        vm.prank(seller);
        vm.expectRevert(Fluxora.ReleaseWindowClosed.selector);
        f.acceptEscrow(id);
        vm.warp(rd - 1); // one second earlier still works (time is not monotonic for the test only)
        _accept(id);
        assertEq(uint8(_status(id)), uint8(Fluxora.Status.Funded));
    }

    function test_Revert_Cancel_StrangerAndWrongStatus() public {
        uint256 id = _createPending(AMT, arbiter);
        address[3] memory bad = [stranger, arbiter, owner];
        for (uint256 i; i < bad.length; ++i) {
            vm.prank(bad[i]);
            vm.expectRevert(Fluxora.Unauthorized.selector);
            f.cancel(id);
        }
        _accept(id);
        vm.prank(buyer);
        vm.expectRevert(_invalidStatus(id, Fluxora.Status.Funded));
        f.cancel(id);

        uint256 id2 = _createPending(AMT, arbiter);
        vm.prank(buyer);
        f.cancel(id2);
        vm.prank(seller);
        vm.expectRevert(_invalidStatus(id2, Fluxora.Status.Refunded));
        f.cancel(id2);
    }

    function test_Revert_ReleaseExpired_Conditions() public {
        uint256 roe = _createRoe(AMT, address(0));
        uint256 notRoe = _create(AMT, address(0));
        uint256 pending = _createP(AMT, address(0), true);
        uint256 rdl = f.getEscrow(roe).refundDeadline;
        vm.warp(rdl);
        vm.expectRevert(abi.encodeWithSelector(Fluxora.ExpiryReleaseNotAvailable.selector, notRoe));
        f.releaseExpired(notRoe);
        vm.expectRevert(_invalidStatus(pending, Fluxora.Status.Pending));
        f.releaseExpired(pending);
        f.releaseExpired(roe);
        vm.expectRevert(_invalidStatus(roe, Fluxora.Status.Released));
        f.releaseExpired(roe);
    }

    function test_Revert_ResolveExpired_Conditions() public {
        uint256 funded = _create(AMT, arbiter);
        vm.expectRevert(_invalidStatus(funded, Fluxora.Status.Funded));
        f.resolveExpired(funded);

        _dispute(funded);
        vm.warp(f.getEscrow(funded).disputeDeadline - 1);
        vm.expectRevert(abi.encodeWithSelector(Fluxora.DisputeNotExpired.selector, funded));
        f.resolveExpired(funded);
        vm.warp(block.timestamp + 1);
        f.resolveExpired(funded);
        vm.expectRevert(_invalidStatus(funded, Fluxora.Status.Split));
        f.resolveExpired(funded);
    }

    // ───────────────────────── Access control / admin ─────────────────────────

    function test_Admin_NonOwnerCalls_Revert() public {
        vm.startPrank(stranger);
        vm.expectRevert(_notOwner(stranger));
        f.setFeeBps(1);
        vm.expectRevert(_notOwner(stranger));
        f.setFeeRecipient(stranger);
        vm.expectRevert(_notOwner(stranger));
        f.setTokenSupported(address(tok), false);
        vm.expectRevert(_notOwner(stranger));
        f.pause();
        vm.expectRevert(_notOwner(stranger));
        f.unpause();
        vm.expectRevert(_notOwner(stranger));
        f.transferOwnership(stranger);
        vm.expectRevert(_notOwner(stranger));
        f.renounceOwnership();
        vm.stopPrank();
    }

    function test_Admin_SetFeeBps_CapAndEvent() public {
        vm.startPrank(owner);
        vm.expectEmit(false, true, false, true, address(f));
        emit Fluxora.FeeUpdated(100, owner);
        f.setFeeBps(100);
        assertEq(f.feeBps(), 100);
        vm.expectRevert(abi.encodeWithSelector(Fluxora.InvalidFee.selector, 101));
        f.setFeeBps(101);
        vm.expectRevert(abi.encodeWithSelector(Fluxora.InvalidFee.selector, type(uint256).max));
        f.setFeeBps(type(uint256).max);
        vm.stopPrank();
    }

    function test_Admin_SetFeeRecipient_Validation() public {
        vm.startPrank(owner);
        vm.expectRevert(Fluxora.ZeroAddress.selector);
        f.setFeeRecipient(address(0));
        vm.expectRevert(abi.encodeWithSelector(Fluxora.InvalidActor.selector, address(f)));
        f.setFeeRecipient(address(f));
        f.setFeeRecipient(feeCol);
        assertEq(f.feeRecipient(), feeCol);
        vm.stopPrank();
    }

    function test_Admin_SetTokenSupported_Validation() public {
        vm.startPrank(owner);
        vm.expectRevert(Fluxora.ZeroAddress.selector);
        f.setTokenSupported(address(0), true);
        vm.expectRevert(abi.encodeWithSelector(Fluxora.InvalidToken.selector, address(f)));
        f.setTokenSupported(address(f), true);
        vm.expectRevert(abi.encodeWithSelector(Fluxora.InvalidToken.selector, stranger));
        f.setTokenSupported(stranger, true); // EOA
        f.setTokenSupported(address(tok), false);
        assertFalse(f.supportedTokens(address(tok)));
        f.setTokenSupported(address(tok), true);
        assertTrue(f.supportedTokens(address(tok)));
        vm.stopPrank();
    }

    function test_Constructor_Validation() public {
        address[] memory none = new address[](0);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableInvalidOwner.selector, address(0)));
        new Fluxora(address(0), none);

        address[] memory bad = new address[](1);
        bad[0] = address(0);
        vm.expectRevert(Fluxora.ZeroAddress.selector);
        new Fluxora(owner, bad);
        bad[0] = stranger;
        vm.expectRevert(abi.encodeWithSelector(Fluxora.InvalidToken.selector, stranger));
        new Fluxora(owner, bad);

        Fluxora g = new Fluxora(owner, none);
        assertEq(g.feeRecipient(), owner);
        assertEq(g.feeBps(), 0);
        assertEq(g.nextEscrowId(), 1);
    }

    // ───────────────────────── Ownership 2-step ─────────────────────────

    function test_Ownership_TwoStepFlow() public {
        address newOwner = makeAddr("newOwner");
        vm.prank(owner);
        f.transferOwnership(newOwner);
        assertEq(f.owner(), owner); // not yet transferred
        assertEq(f.pendingOwner(), newOwner);

        vm.prank(newOwner);
        vm.expectRevert(_notOwner(newOwner));
        f.setFeeBps(1);
        vm.prank(stranger);
        vm.expectRevert(_notOwner(stranger));
        f.acceptOwnership();

        vm.prank(newOwner);
        f.acceptOwnership();
        assertEq(f.owner(), newOwner);
        assertEq(f.pendingOwner(), address(0));

        vm.prank(owner);
        vm.expectRevert(_notOwner(owner));
        f.setFeeBps(1);
        vm.prank(newOwner);
        f.setFeeBps(1);
        assertEq(f.feeBps(), 1);
    }

    function test_Ownership_TransferValidation() public {
        vm.startPrank(owner);
        vm.expectRevert(Fluxora.ZeroAddress.selector);
        f.transferOwnership(address(0));
        vm.expectRevert(abi.encodeWithSelector(Fluxora.InvalidActor.selector, address(f)));
        f.transferOwnership(address(f));
        vm.stopPrank();
    }

    function test_Ownership_RenounceDisabled() public {
        vm.prank(owner);
        vm.expectRevert(Fluxora.RenunciationDisabled.selector);
        f.renounceOwnership();
        assertEq(f.owner(), owner);
    }

    function test_Ownership_NewTransferOverridesPending() public {
        address a = makeAddr("a");
        address b = makeAddr("b");
        vm.startPrank(owner);
        f.transferOwnership(a);
        f.transferOwnership(b);
        vm.stopPrank();
        vm.prank(a);
        vm.expectRevert(_notOwner(a));
        f.acceptOwnership();
        vm.prank(b);
        f.acceptOwnership();
        assertEq(f.owner(), b);
    }

    // ───────────────────────── Pause scope ─────────────────────────

    function test_Pause_OnlyBlocksCreate_SettlementStillWorks() public {
        uint256 a = _create(AMT, arbiter); // to release
        uint256 b = _create(AMT, arbiter); // to refund
        uint256 c = _create(AMT, arbiter); // to dispute + resolve
        uint256 d = _create(AMT, arbiter); // to dispute (while paused)
        uint256 e = _createRoe(AMT, arbiter); // releaseExpired while paused
        uint256 g = _create(AMT, arbiter); // dispute then split while paused
        _dispute(g);
        uint256 pAccept = _createPending(AMT, arbiter); // accepted while paused
        uint256 pCancel = _createPending(AMT, arbiter); // cancelled while paused
        vm.prank(owner);
        f.pause();

        vm.prank(buyer);
        f.release(a);
        vm.prank(seller);
        f.refund(b);
        vm.prank(buyer);
        f.dispute(c);
        vm.prank(seller);
        f.dispute(d);
        vm.prank(arbiter);
        f.resolve(c, true);
        vm.prank(arbiter);
        f.resolve(d, false);
        _accept(pAccept);
        vm.prank(buyer);
        f.cancel(pCancel);
        vm.warp(f.getEscrow(e).refundDeadline);
        f.releaseExpired(e);
        f.resolveExpired(g);
        assertEq(uint8(_status(pAccept)), uint8(Fluxora.Status.Funded));
        vm.prank(seller);
        f.refund(pAccept);
        assertEq(tok.balanceOf(address(f)), 0);

        vm.prank(buyer);
        vm.expectRevert(Pausable.EnforcedPause.selector);
        f.createEscrow(address(tok), seller, address(0), AMT, block.timestamp + DUR, false, 0);

        vm.prank(owner);
        f.unpause();
        _create(AMT, address(0)); // creation works again
    }

    // ───────────────────────── Fee snapshot immutability ─────────────────────────

    function test_FeeSnapshot_UnaffectedByLaterSettingChanges() public {
        address colB = makeAddr("colB");
        _setFee(100);
        _setCollector(feeCol);
        uint256 id = _create(AMT, address(0));
        _setFee(0);
        _setCollector(colB);
        Fluxora.Escrow memory e = f.getEscrow(id);
        assertEq(e.fee, 10e6);
        assertEq(e.feeCollector, feeCol);

        vm.prank(buyer);
        f.release(id);
        assertEq(tok.balanceOf(feeCol), 10e6);
        assertEq(tok.balanceOf(colB), 0);
        assertEq(tok.balanceOf(seller), 990e6);
    }

    function test_FeeSnapshot_NewEscrowUsesNewTerms() public {
        _setFee(100);
        uint256 id1 = _create(AMT, address(0));
        _setFee(10);
        uint256 id2 = _create(AMT, address(0));
        assertEq(f.getEscrow(id1).fee, 10e6);
        assertEq(f.getEscrow(id2).fee, 1e6);
    }

    // ───────────────────────── Non-standard token funding ─────────────────────────

    function _fixtureWith(address token) internal returns (Fluxora g) {
        address[] memory t = new address[](1);
        t[0] = token;
        g = new Fluxora(owner, t);
    }

    function _expectInexact(address token) internal {
        Fluxora g = _fixtureWith(token);
        SecToken(token).mint(buyer, 1e12); // all mocks expose mint(address,uint256)
        vm.startPrank(buyer);
        SecToken(token).approve(address(g), type(uint256).max);
        vm.expectRevert(Fluxora.InexactFunding.selector);
        g.createEscrow(token, seller, address(0), AMT, block.timestamp + DUR, false, 0);
        vm.stopPrank();
        assertEq(g.nextEscrowId(), 1);
        assertEq(g.escrowCount(buyer), 0);
        assertEq(SecToken(token).balanceOf(buyer), 1e12);
    }

    function test_Funding_FeeOnTransferRejected() public {
        _expectInexact(address(new SecFeeOnTransferToken()));
    }

    function test_Funding_InflatingTokenRejected() public {
        _expectInexact(address(new SecInflatingToken()));
    }

    function test_Funding_RebasingTokenRejected() public {
        _expectInexact(address(new SecRebasingToken()));
    }

    // ───────────────────────── Reentrancy (malicious token) ─────────────────────────
    // The token re-enters Fluxora from inside the first transfer touching it. Every nonReentrant entry
    // point (all 10 state-changing user functions) is tried as the inner call during every function
    // that moves tokens (release, refund, cancel, resolve, releaseExpired, resolveExpired, create, claim).
    // acceptEscrow and dispute move no tokens, so they can only be attacked as inner calls.

    uint256 internal constant N_INNER = 10;

    function _reSetup() internal returns (Fluxora g, SecReentrantToken t) {
        t = new SecReentrantToken();
        g = _fixtureWith(address(t));
        t.mint(buyer, 1e12);
        vm.prank(buyer);
        t.approve(address(g), type(uint256).max);
    }

    function _reMk(Fluxora g, SecReentrantToken t, address sel, address arb, bool roe, bool accepted)
        internal
        returns (uint256 id)
    {
        uint256 rd = block.timestamp + DUR;
        vm.prank(buyer);
        id = g.createEscrow(address(t), sel, arb, AMT, rd, roe, 0);
        if (accepted) {
            vm.prank(sel);
            g.acceptEscrow(id);
        }
    }

    function _innerData(uint256 k, SecReentrantToken t, uint256 id) internal view returns (bytes memory) {
        if (k == 0) return abi.encodeWithSelector(Fluxora.release.selector, id);
        if (k == 1) return abi.encodeWithSelector(Fluxora.refund.selector, id);
        if (k == 2) return abi.encodeWithSelector(Fluxora.dispute.selector, id);
        if (k == 3) return abi.encodeWithSelector(Fluxora.resolve.selector, id, true);
        if (k == 4) return abi.encodeWithSelector(Fluxora.acceptEscrow.selector, id);
        if (k == 5) return abi.encodeWithSelector(Fluxora.cancel.selector, id);
        if (k == 6) return abi.encodeWithSelector(Fluxora.releaseExpired.selector, id);
        if (k == 7) return abi.encodeWithSelector(Fluxora.resolveExpired.selector, id);
        if (k == 8) return abi.encodeWithSelector(Fluxora.claim.selector, address(t), altDest);
        return abi.encodeWithSelector(
            Fluxora.createEscrow.selector, address(t), seller, address(0), AMT, block.timestamp + DUR, false, bytes32(0)
        );
    }

    function _assertBlocked(SecReentrantToken t) internal view {
        assertEq(t.attempts(), 1, "hook did not fire");
        assertFalse(t.lastSuccess(), "reentrant call succeeded");
        assertEq(t.lastSelector(), ReentrancyGuard.ReentrancyGuardReentrantCall.selector);
    }

    function test_Reentrancy_DuringRelease_AllEntryPointsBlocked() public {
        for (uint256 k; k < N_INNER; ++k) {
            (Fluxora g, SecReentrantToken t) = _reSetup();
            uint256 id = _reMk(g, t, seller, address(t), false, true);
            t.arm(address(g), _innerData(k, t, id));
            vm.prank(buyer);
            g.release(id);
            _assertBlocked(t);
            assertEq(t.balanceOf(seller), AMT);
            assertEq(t.balanceOf(address(g)), 0);
            assertEq(uint8(g.getEscrow(id).status), uint8(Fluxora.Status.Released));
        }
    }

    function test_Reentrancy_DuringRefund_AllEntryPointsBlocked() public {
        for (uint256 k; k < N_INNER; ++k) {
            (Fluxora g, SecReentrantToken t) = _reSetup();
            uint256 id = _reMk(g, t, seller, address(t), false, true);
            t.arm(address(g), _innerData(k, t, id));
            uint256 before_ = t.balanceOf(buyer);
            vm.prank(seller);
            g.refund(id);
            _assertBlocked(t);
            assertEq(t.balanceOf(buyer), before_ + AMT);
            assertEq(t.balanceOf(seller), 0);
            assertEq(t.balanceOf(address(g)), 0);
        }
    }

    function test_Reentrancy_DuringCancel_AllEntryPointsBlocked() public {
        for (uint256 k; k < N_INNER; ++k) {
            (Fluxora g, SecReentrantToken t) = _reSetup();
            uint256 id = _reMk(g, t, seller, address(t), false, false);
            t.arm(address(g), _innerData(k, t, id));
            uint256 before_ = t.balanceOf(buyer);
            vm.prank(buyer);
            g.cancel(id);
            _assertBlocked(t);
            assertEq(t.balanceOf(buyer), before_ + AMT);
            assertEq(t.balanceOf(address(g)), 0);
            assertEq(uint8(g.getEscrow(id).status), uint8(Fluxora.Status.Refunded));
        }
    }

    function test_Reentrancy_DuringResolve_AllEntryPointsBlocked() public {
        for (uint256 k; k < N_INNER; ++k) {
            for (uint256 s; s < 2; ++s) {
                (Fluxora g, SecReentrantToken t) = _reSetup();
                uint256 id = _reMk(g, t, seller, address(t), false, true);
                vm.prank(buyer);
                g.dispute(id);
                t.arm(address(g), _innerData(k, t, id));
                vm.prank(address(t)); // the token is the arbiter
                g.resolve(id, s == 0);
                _assertBlocked(t);
                assertEq(t.balanceOf(address(g)), 0);
                assertEq(t.balanceOf(seller), s == 0 ? AMT : 0);
            }
        }
    }

    function test_Reentrancy_DuringReleaseExpired_AllEntryPointsBlocked() public {
        for (uint256 k; k < N_INNER; ++k) {
            (Fluxora g, SecReentrantToken t) = _reSetup();
            uint256 id = _reMk(g, t, seller, address(t), true, true);
            vm.warp(g.getEscrow(id).refundDeadline);
            t.arm(address(g), _innerData(k, t, id));
            g.releaseExpired(id);
            _assertBlocked(t);
            assertEq(t.balanceOf(seller), AMT);
            assertEq(t.balanceOf(address(g)), 0);
        }
    }

    function test_Reentrancy_DuringResolveExpired_AllEntryPointsBlocked() public {
        for (uint256 k; k < N_INNER; ++k) {
            (Fluxora g, SecReentrantToken t) = _reSetup();
            uint256 id = _reMk(g, t, seller, address(t), false, true);
            vm.prank(buyer);
            g.dispute(id);
            vm.warp(g.getEscrow(id).disputeDeadline);
            t.arm(address(g), _innerData(k, t, id));
            uint256 before_ = t.balanceOf(buyer);
            g.resolveExpired(id);
            _assertBlocked(t);
            assertEq(t.balanceOf(seller), AMT / 2);
            assertEq(t.balanceOf(buyer), before_ + AMT / 2);
            assertEq(t.balanceOf(address(g)), 0);
        }
    }

    function test_Reentrancy_DuringCreateEscrow_AllEntryPointsBlocked() public {
        for (uint256 k; k < N_INNER; ++k) {
            (Fluxora g, SecReentrantToken t) = _reSetup();
            uint256 id = _reMk(g, t, seller, address(t), false, true);
            t.arm(address(g), _innerData(k, t, id));
            _reMk(g, t, seller, address(0), false, false);
            _assertBlocked(t);
            assertEq(g.nextEscrowId(), 3); // setup escrow + this one only
            assertEq(t.balanceOf(address(g)), 2 * AMT);
            assertEq(uint8(g.getEscrow(id).status), uint8(Fluxora.Status.Funded));
        }
    }

    function test_Reentrancy_DuringClaim_AllEntryPointsBlocked() public {
        for (uint256 k; k < N_INNER; ++k) {
            (Fluxora g, SecReentrantToken t) = _reSetup();
            // the token itself is the seller, so the re-entrant claim carries a real credit
            uint256 id = _reMk(g, t, address(t), address(0), false, false);
            vm.prank(address(t));
            g.acceptEscrow(id);
            t.setBlocked(address(t), true);
            vm.prank(buyer);
            g.release(id);
            assertEq(g.claimable(address(t), address(t)), AMT);
            t.setBlocked(address(t), false);

            t.arm(address(g), _innerData(k, t, id));
            vm.prank(address(t));
            g.claim(address(t), altDest);
            _assertBlocked(t);
            assertEq(t.balanceOf(altDest), AMT); // paid exactly once
            assertEq(g.claimable(address(t), address(t)), 0);
            assertEq(g.totalPending(address(t)), 0);
            assertEq(t.balanceOf(address(g)), 0);
        }
    }

    // ───────────────────────── Fuzz: fee, rounding, solvency ─────────────────────────

    function testFuzz_FeeCapRoundingAndConservation(uint256 amount, uint256 bps) public {
        amount = bound(amount, 1, 1e29);
        bps = bound(bps, 0, 100);
        _setFee(bps);
        _setCollector(feeCol);
        uint256 id = _create(amount, address(0));
        uint256 fee = f.getEscrow(id).fee;
        assertEq(fee, amount * bps / 10_000);
        assertLe(fee, amount / 100);
        assertLe(fee, amount);
        vm.prank(buyer);
        f.release(id);
        assertEq(tok.balanceOf(seller) + tok.balanceOf(feeCol), amount);
        assertEq(tok.balanceOf(feeCol), fee);
        assertEq(tok.balanceOf(address(f)), 0);
    }

    function testFuzz_ResolveToSellerMatchesRelease(uint256 amount, uint256 bps) public {
        amount = bound(amount, 1, 1e29);
        bps = bound(bps, 0, 100);
        _setFee(bps);
        _setCollector(feeCol);
        uint256 id = _create(amount, arbiter);
        vm.prank(seller);
        f.dispute(id);
        vm.prank(arbiter);
        f.resolve(id, true);
        assertEq(tok.balanceOf(seller), amount - amount * bps / 10_000);
        assertEq(tok.balanceOf(feeCol), amount * bps / 10_000);
        assertEq(tok.balanceOf(address(f)), 0);
    }

    function testFuzz_BalanceNeverBelowOpenEscrows(uint256 a1, uint256 a2, uint256 a3, uint8 pick) public {
        a1 = bound(a1, 1, 1e27);
        a2 = bound(a2, 1, 1e27);
        a3 = bound(a3, 1, 1e27);
        _setFee(100);
        uint256 i1 = _create(a1, arbiter);
        uint256 i2 = _create(a2, arbiter);
        uint256 i3 = _createPending(a3, arbiter);
        assertEq(tok.balanceOf(address(f)), a1 + a2 + a3); // Pending funds are held too
        vm.prank(buyer);
        f.release(i1);
        assertEq(tok.balanceOf(address(f)), a2 + a3);
        if (pick % 2 == 0) {
            vm.prank(seller);
            f.refund(i2);
            assertEq(tok.balanceOf(address(f)), a3);
        } else {
            vm.prank(buyer);
            f.dispute(i2);
            assertEq(tok.balanceOf(address(f)), a2 + a3); // disputed still held
        }
        vm.prank(seller);
        f.cancel(i3);
        assertEq(tok.balanceOf(address(f)), pick % 2 == 0 ? 0 : a2);
    }

    // ───────────────────────── Deadline bounds ─────────────────────────

    uint256 internal constant MAX_REL = 365 days - 7 days;

    function testFuzz_Deadline_Bounds(uint256 rd) public {
        bool ok = rd > block.timestamp && rd - block.timestamp <= MAX_REL;
        vm.prank(buyer);
        if (!ok) vm.expectRevert(abi.encodeWithSelector(Fluxora.InvalidDeadline.selector, rd));
        uint256 id = f.createEscrow(address(tok), seller, address(0), AMT, rd, false, 0);
        if (ok) {
            Fluxora.Escrow memory e = f.getEscrow(id);
            assertEq(e.refundDeadline, rd + 7 days);
            assertLe(e.refundDeadline - block.timestamp, 365 days);
        }
    }

    function testFuzz_Deadline_InRangeAlwaysSucceeds(uint256 delta) public {
        delta = bound(delta, 1, MAX_REL);
        uint256 rd = block.timestamp + delta;
        vm.prank(buyer);
        uint256 id = f.createEscrow(address(tok), seller, address(0), AMT, rd, false, 0);
        assertEq(f.getEscrow(id).refundDeadline - block.timestamp, delta + 7 days);
    }

    function test_Deadline_Edges() public {
        uint256 t0 = block.timestamp;
        vm.startPrank(buyer);
        f.createEscrow(address(tok), seller, address(0), AMT, t0 + 1, false, 0);
        f.createEscrow(address(tok), seller, address(0), AMT, t0 + MAX_REL, false, 0);
        vm.expectRevert(abi.encodeWithSelector(Fluxora.InvalidDeadline.selector, t0 + MAX_REL + 1));
        f.createEscrow(address(tok), seller, address(0), AMT, t0 + MAX_REL + 1, false, 0);
        vm.expectRevert(abi.encodeWithSelector(Fluxora.InvalidDeadline.selector, type(uint256).max));
        f.createEscrow(address(tok), seller, address(0), AMT, type(uint256).max, false, 0);
        vm.stopPrank();
    }

    // ───────────────────────── escrowsOf pagination ─────────────────────────

    function _many(uint256 n) internal {
        for (uint256 i; i < n; ++i) _createPending(1, address(0));
    }

    function test_Pagination_Basics() public {
        _many(5);
        uint256[] memory ids = f.escrowsOf(buyer, 0, 100);
        assertEq(ids.length, 5);
        for (uint256 i; i < 5; ++i) assertEq(ids[i], i + 1);
        ids = f.escrowsOf(seller, 1, 2);
        assertEq(ids.length, 2);
        assertEq(ids[0], 2);
        assertEq(ids[1], 3);
        ids = f.escrowsOf(buyer, 3, 100); // clamped
        assertEq(ids.length, 2);
        assertEq(ids[1], 5);
    }

    function test_Pagination_EdgeCases() public {
        _many(5);
        assertEq(f.escrowsOf(buyer, 5, 10).length, 0); // offset == length
        assertEq(f.escrowsOf(buyer, 6, 10).length, 0); // past end
        assertEq(f.escrowsOf(buyer, type(uint256).max, 10).length, 0); // huge offset, no overflow
        assertEq(f.escrowsOf(buyer, 0, 0).length, 0); // limit 0
        assertEq(f.escrowsOf(stranger, 0, 10).length, 0); // unknown user
    }

    function test_Revert_Pagination_LimitTooLarge() public {
        _many(2);
        vm.expectRevert(Fluxora.PageTooLarge.selector);
        f.escrowsOf(buyer, 0, 101);
        vm.expectRevert(Fluxora.PageTooLarge.selector);
        f.escrowsOf(buyer, 999, 101); // limit checked even if offset is past the end
        vm.expectRevert(Fluxora.PageTooLarge.selector);
        f.escrowsOf(buyer, 0, type(uint256).max);
    }

    function test_Pagination_MaxPageAndSecondPage() public {
        _many(105);
        assertEq(f.escrowsOf(buyer, 0, 100).length, 100);
        uint256[] memory tail = f.escrowsOf(buyer, 100, 100);
        assertEq(tail.length, 5);
        assertEq(tail[4], 105);
        assertEq(f.escrowCount(buyer), 105);
    }
}

// ═════════════════════════ F-01 (FIXED): dispute lock → permissionless 50/50 split ═════════════════════════

contract FluxoraFixedF01Test is FluxoraSecBase {
    function _disputed(uint256 amount) internal returns (uint256 id) {
        id = _create(amount, arbiter);
        vm.prank(seller);
        f.dispute(id);
    }

    function test_Fixed_F01_SplitNotAvailableBeforeWindowEnds() public {
        uint256 id = _disputed(AMT);
        uint256 dl = f.getEscrow(id).disputeDeadline;
        vm.warp(dl - 1);
        address[4] memory who = [buyer, seller, stranger, owner];
        for (uint256 i; i < who.length; ++i) {
            vm.prank(who[i]);
            vm.expectRevert(abi.encodeWithSelector(Fluxora.DisputeNotExpired.selector, id));
            f.resolveExpired(id);
        }
        assertEq(uint8(_status(id)), uint8(Fluxora.Status.Disputed));
        assertEq(tok.balanceOf(address(f)), AMT);
        // ordinary settlement stays frozen while disputed
        vm.prank(buyer);
        vm.expectRevert(_invalidStatus(id, Fluxora.Status.Disputed));
        f.refund(id);
        vm.prank(seller);
        vm.expectRevert(_invalidStatus(id, Fluxora.Status.Disputed));
        f.refund(id);
    }

    function test_Fixed_F01_InactiveArbiter_AnyoneSplitsAfterWindow_WithProportionalFee() public {
        _setFee(100);
        _setCollector(feeCol);
        uint256 id = _disputed(AMT);
        vm.warp(f.getEscrow(id).disputeDeadline); // inclusive start
        uint256 buyerBefore = tok.balanceOf(buyer);
        vm.prank(stranger);
        f.resolveExpired(id);
        // seller half 500e6 less proportional fee (1% of 500e6 = 5e6); buyer the other half
        assertEq(tok.balanceOf(seller), 495e6);
        assertEq(tok.balanceOf(feeCol), 5e6);
        assertEq(tok.balanceOf(buyer), buyerBefore + 500e6);
        assertEq(tok.balanceOf(address(f)), 0);
        assertEq(uint8(_status(id)), uint8(Fluxora.Status.Split));
    }

    function test_Fixed_F01_NeitherPartyAloneCanTakeAll() public {
        uint256 id = _disputed(AMT);
        uint256 buyerBefore = tok.balanceOf(buyer);
        // before the window: neither can unilaterally settle
        vm.prank(buyer);
        vm.expectRevert(_invalidStatus(id, Fluxora.Status.Disputed));
        f.release(id);
        vm.prank(seller);
        vm.expectRevert(_invalidStatus(id, Fluxora.Status.Disputed));
        f.refund(id);
        // after the window: both can trigger it, and the result is the same fixed half/half
        vm.warp(f.getEscrow(id).disputeDeadline + 1 days);
        vm.prank(buyer);
        vm.expectRevert(_invalidStatus(id, Fluxora.Status.Disputed));
        f.refund(id);
        vm.prank(seller);
        vm.expectRevert(Fluxora.Unauthorized.selector); // arbiter-only
        f.resolve(id, true);
        vm.prank(buyer);
        f.resolveExpired(id);
        assertEq(tok.balanceOf(seller), AMT / 2);
        assertEq(tok.balanceOf(buyer), buyerBefore + AMT / 2);
        assertLt(tok.balanceOf(seller), AMT);
        assertLt(tok.balanceOf(buyer) - buyerBefore, AMT);
    }

    function test_Fixed_F01_FundsNotLockedAfterTenYears() public {
        uint256 id = _disputed(AMT);
        vm.warp(block.timestamp + 3650 days);
        assertEq(tok.balanceOf(address(f)), AMT);
        vm.prank(stranger);
        f.resolveExpired(id);
        assertEq(tok.balanceOf(address(f)), 0);
        assertEq(tok.balanceOf(seller), AMT / 2);
        assertEq(uint8(_status(id)), uint8(Fluxora.Status.Split));
    }

    function test_Fixed_F01_ArbiterCanStillResolveBeforeAndAfterWindow() public {
        // before the window
        uint256 a = _disputed(AMT);
        vm.prank(arbiter);
        f.resolve(a, true);
        assertEq(uint8(_status(a)), uint8(Fluxora.Status.Released));
        // after the window, until the split actually runs
        uint256 b = _disputed(AMT);
        uint256 c = _disputed(AMT);
        vm.warp(f.getEscrow(b).disputeDeadline + 30 days);
        uint256 buyerBefore = tok.balanceOf(buyer);
        vm.prank(arbiter);
        f.resolve(b, false);
        assertEq(uint8(_status(b)), uint8(Fluxora.Status.Refunded));
        assertEq(tok.balanceOf(buyer), buyerBefore + AMT);
        // once the split ran, the arbiter is too late
        f.resolveExpired(c);
        vm.prank(arbiter);
        vm.expectRevert(_invalidStatus(c, Fluxora.Status.Split));
        f.resolve(c, true);
    }

    function test_Fixed_F01_DoubleSettlementImpossible() public {
        _setFee(100);
        uint256 id = _disputed(AMT);
        vm.warp(f.getEscrow(id).disputeDeadline);
        f.resolveExpired(id);
        uint256 pot = tok.balanceOf(seller) + tok.balanceOf(buyer);

        bytes memory split = _invalidStatus(id, Fluxora.Status.Split);
        vm.expectRevert(split);
        f.resolveExpired(id);
        vm.prank(arbiter);
        vm.expectRevert(split);
        f.resolve(id, true);
        vm.prank(buyer);
        vm.expectRevert(split);
        f.release(id);
        vm.prank(seller);
        vm.expectRevert(split);
        f.refund(id);
        vm.expectRevert(split);
        f.releaseExpired(id);
        vm.prank(buyer);
        vm.expectRevert(split);
        f.cancel(id);
        vm.prank(seller);
        vm.expectRevert(split);
        f.acceptEscrow(id);
        vm.prank(buyer);
        vm.expectRevert(split);
        f.dispute(id);
        assertEq(tok.balanceOf(seller) + tok.balanceOf(buyer), pot);
        assertEq(tok.balanceOf(address(f)), 0);

        // and the reverse order: arbiter resolved first => split impossible
        uint256 id2 = _disputed(AMT);
        vm.prank(arbiter);
        f.resolve(id2, true);
        vm.warp(block.timestamp + 20 days);
        vm.expectRevert(_invalidStatus(id2, Fluxora.Status.Released));
        f.resolveExpired(id2);
    }

    function test_Fixed_F01_OddAmounts_BuyerGetsOddUnit() public {
        uint256[3] memory amounts = [uint256(1), 3, 999_999_999_999_999_999];
        for (uint256 i; i < amounts.length; ++i) {
            uint256 amount = amounts[i];
            uint256 sellerBefore = tok.balanceOf(seller);
            uint256 buyerBefore = tok.balanceOf(buyer);
            uint256 id = _disputed(amount);
            assertEq(tok.balanceOf(buyer), buyerBefore - amount);
            vm.warp(f.getEscrow(id).disputeDeadline);
            f.resolveExpired(id);
            assertEq(tok.balanceOf(seller) - sellerBefore, amount / 2, "seller gets floor(half)");
            assertEq(tok.balanceOf(buyer) - (buyerBefore - amount), amount - amount / 2, "buyer gets the odd unit");
            assertEq(tok.balanceOf(address(f)), 0);
        }
    }

    function test_Fixed_F01_OddAmounts_WithFee_Conserve() public {
        _setFee(100);
        _setCollector(feeCol);
        uint256[3] memory amounts = [uint256(1), 3, 999_999_999_999_999_999];
        for (uint256 i; i < amounts.length; ++i) {
            uint256 amount = amounts[i];
            uint256 s0 = tok.balanceOf(seller);
            uint256 c0 = tok.balanceOf(feeCol);
            uint256 b0 = tok.balanceOf(buyer);
            uint256 id = _disputed(amount);
            vm.warp(f.getEscrow(id).disputeDeadline);
            f.resolveExpired(id);
            uint256 sGot = tok.balanceOf(seller) - s0;
            uint256 cGot = tok.balanceOf(feeCol) - c0;
            uint256 bGot = tok.balanceOf(buyer) + amount - b0;
            assertEq(sGot + cGot + bGot, amount);
            assertEq(sGot + cGot, amount / 2);
            assertEq(bGot, amount - amount / 2);
            assertLe(cGot, f.getEscrow(id).fee);
            assertEq(tok.balanceOf(address(f)), 0);
        }
    }

    function testFuzz_Fixed_F01_SplitConservation(uint256 amount, uint256 bps) public {
        amount = bound(amount, 1, 1e29);
        bps = bound(bps, 0, 100);
        _setFee(bps);
        _setCollector(feeCol);
        uint256 id = _create(amount, arbiter);
        _dispute(id);
        uint256 buyerAfterFunding = tok.balanceOf(buyer);
        vm.warp(f.getEscrow(id).disputeDeadline);
        vm.expectEmit(true, true, false, false, address(f));
        emit Fluxora.EscrowSplit(id, stranger, 0, 0, 0);
        vm.prank(stranger);
        f.resolveExpired(id);
        uint256 sellerAmt = tok.balanceOf(seller);
        uint256 fee = tok.balanceOf(feeCol);
        uint256 buyerAmt = tok.balanceOf(buyer) - buyerAfterFunding;
        assertEq(sellerAmt + fee + buyerAmt, amount, "conservation");
        assertLe(fee, amount / 2, "fee bounded by seller half");
        assertEq(sellerAmt + fee, amount / 2, "seller side is exactly floor(half)");
        assertEq(buyerAmt, amount - amount / 2, "buyer gets the odd unit");
        assertLe(fee, f.getEscrow(id).fee, "split fee never exceeds the full-release fee");
        assertEq(tok.balanceOf(address(f)), 0);
    }
}

// ═════════════════════════ F-02 (FIXED): failed payouts become claimable credits ═════════════════════════

contract FluxoraFixedF02Test is FluxoraSecBase {
    function setUp() public override {
        super.setUp();
        _setFee(100);
        _setCollector(feeCol);
    }

    function _credit(address who) internal view returns (uint256) {
        return f.claimable(address(tok), who);
    }

    function _pending() internal view returns (uint256) {
        return f.totalPending(address(tok));
    }

    // ── blocklisted fee collector ──

    function test_Fixed_F02_BlocklistedFeeCollector_ReleaseSucceeds() public {
        uint256 id = _create(AMT, arbiter);
        tok.setBlocked(feeCol, true);
        vm.expectEmit(true, true, false, true, address(f));
        emit Fluxora.PayoutDeferred(address(tok), feeCol, 10e6);
        vm.prank(buyer);
        f.release(id);
        assertEq(uint8(_status(id)), uint8(Fluxora.Status.Released));
        assertEq(tok.balanceOf(seller), 990e6, "seller paid immediately");
        assertEq(tok.balanceOf(feeCol), 0);
        assertEq(_credit(feeCol), 10e6);
        assertEq(_pending(), 10e6);
        assertEq(tok.balanceOf(address(f)), 10e6, "held funds == totalPending");
    }

    function test_Fixed_F02_BlocklistedFeeCollector_AllSellerPaths() public {
        uint256 viaResolve = _create(AMT, arbiter);
        uint256 viaSplit = _create(AMT, arbiter);
        uint256 viaExpiry = _createRoe(AMT, arbiter);
        _dispute(viaResolve);
        _dispute(viaSplit);
        tok.setBlocked(feeCol, true);

        vm.prank(arbiter);
        f.resolve(viaResolve, true);
        assertEq(uint8(_status(viaResolve)), uint8(Fluxora.Status.Released));
        assertEq(tok.balanceOf(seller), 990e6);
        assertEq(_credit(feeCol), 10e6);

        vm.warp(f.getEscrow(viaSplit).disputeDeadline);
        uint256 buyerBefore = tok.balanceOf(buyer);
        f.resolveExpired(viaSplit);
        assertEq(uint8(_status(viaSplit)), uint8(Fluxora.Status.Split));
        assertEq(tok.balanceOf(seller), 990e6 + 495e6);
        assertEq(tok.balanceOf(buyer), buyerBefore + 500e6, "buyer half paid immediately");
        assertEq(_credit(feeCol), 15e6);

        vm.warp(f.getEscrow(viaExpiry).refundDeadline);
        vm.prank(stranger);
        f.releaseExpired(viaExpiry);
        assertEq(uint8(_status(viaExpiry)), uint8(Fluxora.Status.Released));
        assertEq(tok.balanceOf(seller), 990e6 + 495e6 + 990e6);
        assertEq(_credit(feeCol), 25e6);
        assertEq(_pending(), 25e6);
        assertEq(tok.balanceOf(address(f)), 25e6);
    }

    function test_Fixed_F02_BlocklistedFeeCollector_RefundPathsUnaffected() public {
        uint256 a = _create(AMT, arbiter);
        uint256 b = _create(AMT, arbiter);
        uint256 c = _createPending(AMT, arbiter);
        _dispute(b);
        tok.setBlocked(feeCol, true);
        uint256 before_ = tok.balanceOf(buyer);
        vm.prank(seller);
        f.refund(a);
        vm.prank(arbiter);
        f.resolve(b, false);
        vm.prank(buyer);
        f.cancel(c);
        assertEq(tok.balanceOf(buyer), before_ + 3 * AMT);
        assertEq(_pending(), 0);
        assertEq(tok.balanceOf(address(f)), 0);
    }

    function test_Fixed_F02_FeeCollectorChangeDoesNotChangeDeferredCredit() public {
        uint256 id = _create(AMT, address(0));
        tok.setBlocked(feeCol, true);
        address newCol = makeAddr("newCol");
        _setCollector(newCol);
        vm.prank(buyer);
        f.release(id);
        assertEq(f.getEscrow(id).feeCollector, feeCol);
        assertEq(_credit(feeCol), 10e6);
        assertEq(_credit(newCol), 0);

        vm.prank(newCol); // the new collector cannot claim the old collector's credit
        vm.expectRevert(Fluxora.NothingToClaim.selector);
        f.claim(address(tok), newCol);
        _setCollector(makeAddr("another"));
        assertEq(_credit(feeCol), 10e6, "owner changes never move credits");
        vm.prank(feeCol); // blocked collector pulls to an alternate address
        f.claim(address(tok), altDest);
        assertEq(tok.balanceOf(altDest), 10e6);
        assertEq(_credit(feeCol), 0);
    }

    // ── blocklisted seller ──

    function test_Fixed_F02_BlocklistedSeller_ReleaseSucceeds_FeePaid() public {
        uint256 id = _create(AMT, arbiter);
        tok.setBlocked(seller, true);
        vm.expectEmit(true, true, false, true, address(f));
        emit Fluxora.PayoutDeferred(address(tok), seller, 990e6);
        vm.prank(buyer);
        f.release(id);
        assertEq(uint8(_status(id)), uint8(Fluxora.Status.Released));
        assertEq(tok.balanceOf(feeCol), 10e6, "collector paid immediately");
        assertEq(_credit(seller), 990e6);
        assertEq(_pending(), 990e6);
        assertEq(tok.balanceOf(address(f)), 990e6);
    }

    function test_Fixed_F02_BlocklistedSeller_ResolveSplitExpiryAndRefund() public {
        uint256 viaResolve = _create(AMT, arbiter);
        uint256 viaSplit = _create(AMT, arbiter);
        uint256 viaExpiry = _createRoe(AMT, address(0));
        uint256 viaRefund = _create(AMT, address(0));
        _dispute(viaResolve);
        _dispute(viaSplit);
        tok.setBlocked(seller, true);

        vm.prank(arbiter);
        f.resolve(viaResolve, true);
        assertEq(_credit(seller), 990e6);

        vm.warp(f.getEscrow(viaSplit).disputeDeadline);
        uint256 buyerBefore = tok.balanceOf(buyer);
        f.resolveExpired(viaSplit);
        assertEq(_credit(seller), 990e6 + 495e6);
        assertEq(tok.balanceOf(buyer), buyerBefore + 500e6);
        assertEq(tok.balanceOf(feeCol), 10e6 + 5e6);

        vm.warp(f.getEscrow(viaExpiry).refundDeadline);
        f.releaseExpired(viaExpiry);
        assertEq(_credit(seller), 990e6 + 495e6 + 990e6);

        // the (blocked) seller can still refund the buyer: seller is only the caller, not a recipient
        buyerBefore = tok.balanceOf(buyer);
        vm.prank(seller);
        f.refund(viaRefund);
        assertEq(tok.balanceOf(buyer), buyerBefore + AMT);

        assertEq(tok.balanceOf(address(f)), _pending());
    }

    // ── blocklisted buyer ──

    function test_Fixed_F02_BlocklistedBuyer_RefundCancelResolveSplit() public {
        uint256 viaRefund = _create(AMT, address(0));
        uint256 viaCancel = _createPending(AMT, address(0));
        uint256 viaResolve = _create(AMT, arbiter);
        uint256 viaSplit = _create(AMT, arbiter);
        _dispute(viaResolve);
        _dispute(viaSplit);
        tok.setBlocked(buyer, true);

        vm.prank(seller);
        f.refund(viaRefund);
        assertEq(uint8(_status(viaRefund)), uint8(Fluxora.Status.Refunded));
        assertEq(_credit(buyer), AMT);

        vm.prank(seller); // seller rejects: buyer refund is credited, cancel still succeeds
        f.cancel(viaCancel);
        assertEq(uint8(_status(viaCancel)), uint8(Fluxora.Status.Refunded));
        assertEq(_credit(buyer), 2 * AMT);

        vm.prank(arbiter);
        f.resolve(viaResolve, false);
        assertEq(_credit(buyer), 3 * AMT);

        vm.warp(f.getEscrow(viaSplit).disputeDeadline);
        f.resolveExpired(viaSplit);
        assertEq(uint8(_status(viaSplit)), uint8(Fluxora.Status.Split));
        assertEq(_credit(buyer), 3 * AMT + 500e6);
        assertEq(tok.balanceOf(seller), 495e6, "seller half paid immediately");
        assertEq(tok.balanceOf(feeCol), 5e6);
        assertEq(_pending(), 3 * AMT + 500e6);
        assertEq(tok.balanceOf(address(f)), _pending());

        vm.prank(buyer);
        f.claim(address(tok), altDest);
        assertEq(tok.balanceOf(altDest), 3 * AMT + 500e6);
        assertEq(_pending(), 0);
    }

    function test_Fixed_F02_BlocklistedBuyer_BuyerRefundAfterDeadlineCredited() public {
        uint256 id = _create(AMT, address(0));
        vm.warp(f.getEscrow(id).refundDeadline);
        tok.setBlocked(buyer, true);
        vm.prank(buyer);
        f.refund(id);
        assertEq(uint8(_status(id)), uint8(Fluxora.Status.Refunded));
        assertEq(_credit(buyer), AMT);
    }

    // ── claim ──

    function _deferSellerCredit() internal returns (uint256 id) {
        id = _create(AMT, address(0));
        tok.setBlocked(seller, true);
        vm.prank(buyer);
        f.release(id);
        assertEq(_credit(seller), 990e6);
    }

    function test_Claim_ToAlternateAddress_ZeroesCreditAndEmits() public {
        _deferSellerCredit();
        vm.expectEmit(true, true, false, true, address(f));
        emit Fluxora.Claimed(address(tok), seller, altDest, 990e6);
        vm.prank(seller); // the seller is blocklisted; an alternate destination works
        uint256 got = f.claim(address(tok), altDest);
        assertEq(got, 990e6);
        assertEq(tok.balanceOf(altDest), 990e6);
        assertEq(_credit(seller), 0);
        assertEq(_pending(), 0);
        assertEq(tok.balanceOf(address(f)), 0);
        vm.prank(seller);
        vm.expectRevert(Fluxora.NothingToClaim.selector);
        f.claim(address(tok), altDest);
    }

    function test_Revert_Claim_NothingToClaim_BadTo_WrongAccount() public {
        _deferSellerCredit();
        vm.prank(stranger);
        vm.expectRevert(Fluxora.NothingToClaim.selector);
        f.claim(address(tok), stranger);
        vm.prank(owner);
        vm.expectRevert(Fluxora.NothingToClaim.selector);
        f.claim(address(tok), owner);
        vm.prank(seller);
        vm.expectRevert(Fluxora.ZeroAddress.selector);
        f.claim(address(tok), address(0));
        vm.prank(seller);
        vm.expectRevert(abi.encodeWithSelector(Fluxora.InvalidActor.selector, address(f)));
        f.claim(address(tok), address(f));
        // a different token has no credit for the seller
        SecToken other = new SecToken();
        vm.prank(seller);
        vm.expectRevert(Fluxora.NothingToClaim.selector);
        f.claim(address(other), altDest);
        assertEq(_credit(seller), 990e6, "failed claims never touch the credit");
    }

    function test_Revert_Claim_FailedTransferPreservesCredit() public {
        _deferSellerCredit();
        tok.setBlocked(altDest, true); // destination is blocked too, so the token rejects the transfer
        vm.prank(seller);
        vm.expectRevert(abi.encodeWithSelector(SecToken.Blocked.selector, altDest));
        f.claim(address(tok), altDest);
        assertEq(_credit(seller), 990e6);
        assertEq(_pending(), 990e6);
        assertEq(tok.balanceOf(address(f)), 990e6);

        tok.setBlocked(altDest, false);
        vm.prank(seller);
        f.claim(address(tok), altDest);
        assertEq(tok.balanceOf(altDest), 990e6);
        assertEq(_credit(seller), 0);
    }

    function test_Claim_OwnerCannotTouchCredits_AdminActionsDoNotAffectThem() public {
        _deferSellerCredit();
        vm.startPrank(owner);
        f.pause();
        f.setTokenSupported(address(tok), false);
        f.setFeeBps(0);
        f.setFeeRecipient(makeAddr("x"));
        vm.expectRevert(Fluxora.NothingToClaim.selector);
        f.claim(address(tok), owner);
        vm.stopPrank();
        assertEq(_credit(seller), 990e6);
        assertEq(_pending(), 990e6);
        // the owner pausing / de-listing does not stop the rightful claimant
        vm.prank(seller);
        f.claim(address(tok), altDest);
        assertEq(tok.balanceOf(altDest), 990e6);
    }

    function test_Claim_CreditsAccumulateAndPayInOneClaim() public {
        _deferSellerCredit();
        uint256 id2 = _create(AMT, address(0));
        vm.prank(buyer);
        f.release(id2);
        assertEq(_credit(seller), 1980e6);
        assertEq(_pending(), 1980e6);
        vm.prank(seller);
        assertEq(f.claim(address(tok), altDest), 1980e6);
        assertEq(tok.balanceOf(altDest), 1980e6);
    }

    function test_Claim_UnblockedAccountMayClaimToItself() public {
        _deferSellerCredit();
        tok.setBlocked(seller, false);
        vm.prank(seller);
        f.claim(address(tok), seller);
        assertEq(tok.balanceOf(seller), 990e6);
    }

    // ── accounting ──

    function test_Fixed_F02_Accounting_BalanceCoversOpenEscrowsPlusPending() public {
        uint256 open1 = _create(AMT, arbiter); // stays Funded
        uint256 open2 = _createPending(2 * AMT, arbiter); // stays Pending
        uint256 open3 = _create(3 * AMT, arbiter);
        _dispute(open3); // stays Disputed
        uint256 done = _create(AMT, address(0));
        tok.setBlocked(feeCol, true);
        tok.setBlocked(seller, true);
        vm.prank(buyer);
        f.release(done);
        assertEq(_pending(), 1000e6);
        uint256 openSum = f.getEscrow(open1).amount + f.getEscrow(open2).amount + f.getEscrow(open3).amount;
        assertEq(tok.balanceOf(address(f)), openSum + _pending());
        // a donation only ever makes the contract over-collateralised
        tok.mint(address(f), 7);
        assertGe(tok.balanceOf(address(f)), openSum + _pending());
    }

    /// @dev Any combination of blocked buyer / seller / collector: every settlement path still
    ///      reaches a terminal status and no value is created or destroyed.
    function testFuzz_Fixed_F02_AnyBlocklistCombination_SettlesAndConserves(
        uint256 amount, uint8 mask, uint8 path
    ) public {
        amount = bound(amount, 1, 1e27);
        path = uint8(bound(path, 0, 4));
        uint256 id = path == 3 ? _createRoe(amount, arbiter) : _create(amount, arbiter);
        if (path == 2 || path == 4) _dispute(id);
        uint256 fundedBuyer = tok.balanceOf(buyer);
        if (mask & 1 != 0) tok.setBlocked(buyer, true);
        if (mask & 2 != 0) tok.setBlocked(seller, true);
        if (mask & 4 != 0) tok.setBlocked(feeCol, true);

        Fluxora.Status expected;
        if (path == 0) { // buyer release
            vm.prank(buyer);
            f.release(id);
            expected = Fluxora.Status.Released;
        } else if (path == 1) { // seller refund
            vm.prank(seller);
            f.refund(id);
            expected = Fluxora.Status.Refunded;
        } else if (path == 2) { // arbiter resolve
            vm.prank(arbiter);
            f.resolve(id, amount % 2 == 0);
            expected = amount % 2 == 0 ? Fluxora.Status.Released : Fluxora.Status.Refunded;
        } else if (path == 3) { // permissionless expiry release
            vm.warp(f.getEscrow(id).refundDeadline);
            f.releaseExpired(id);
            expected = Fluxora.Status.Released;
        } else { // permissionless split
            vm.warp(f.getEscrow(id).disputeDeadline);
            f.resolveExpired(id);
            expected = Fluxora.Status.Split;
        }
        assertEq(uint8(_status(id)), uint8(expected));
        uint256 got = (tok.balanceOf(seller) + tok.balanceOf(feeCol) + tok.balanceOf(buyer)) - fundedBuyer;
        uint256 credited = _credit(seller) + _credit(feeCol) + _credit(buyer);
        assertEq(got + credited, amount, "paid + credited == amount");
        assertEq(credited, _pending());
        assertEq(tok.balanceOf(address(f)), _pending());
    }
}

// ═════════════════════════ F-03 (FIXED): seller acceptance, arbiter limits, explicit expiry rule ═════════════════════════

contract FluxoraFixedF03Test is FluxoraSecBase {
    // ── Pending: nobody can settle before the seller accepts ──

    function test_Fixed_F03_PendingEscrow_CannotBeSettledByAnyone() public {
        uint256 id = _createPending(AMT, arbiter);
        bytes memory pending = _invalidStatus(id, Fluxora.Status.Pending);
        address[5] memory who = [buyer, seller, arbiter, stranger, owner];
        for (uint256 i; i < who.length; ++i) {
            vm.startPrank(who[i]);
            vm.expectRevert(pending);
            f.release(id);
            vm.expectRevert(pending);
            f.refund(id);
            vm.expectRevert(pending);
            f.dispute(id);
            vm.expectRevert(pending);
            f.resolve(id, true);
            vm.expectRevert(pending);
            f.resolve(id, false);
            vm.expectRevert(pending);
            f.releaseExpired(id);
            vm.expectRevert(pending);
            f.resolveExpired(id);
            vm.stopPrank();
        }
        assertEq(uint8(_status(id)), uint8(Fluxora.Status.Pending));
        assertEq(tok.balanceOf(address(f)), AMT);
    }

    function test_Fixed_F03_PendingEscrow_NoSettlementEvenAfterDeadlines() public {
        uint256 id = _createPending(AMT, arbiter);
        vm.warp(f.getEscrow(id).refundDeadline + 1);
        bytes memory pending = _invalidStatus(id, Fluxora.Status.Pending);
        vm.prank(buyer);
        vm.expectRevert(pending);
        f.refund(id); // the buyer's only exit is cancel
        vm.expectRevert(pending);
        f.releaseExpired(id);
        assertEq(tok.balanceOf(address(f)), AMT);
    }

    function test_Fixed_F03_OnlySellerCanAccept() public {
        uint256 id = _createPending(AMT, arbiter);
        address[4] memory who = [buyer, arbiter, stranger, owner];
        for (uint256 i; i < who.length; ++i) {
            vm.prank(who[i]);
            vm.expectRevert(Fluxora.Unauthorized.selector);
            f.acceptEscrow(id);
        }
        _accept(id);
        assertEq(uint8(_status(id)), uint8(Fluxora.Status.Funded));
    }

    function test_Fixed_F03_AcceptRevertsAtAndAfterReleaseDeadline_BuyerCanStillCancel() public {
        uint256 id = _createPending(AMT, arbiter);
        uint256 id2 = _createPending(AMT, arbiter); // same deadline
        uint256 rd = f.getEscrow(id).releaseDeadline;
        vm.warp(rd - 1);
        _accept(id2); // one second before the deadline still works
        assertEq(uint8(_status(id2)), uint8(Fluxora.Status.Funded));
        vm.warp(rd);
        vm.prank(seller);
        vm.expectRevert(Fluxora.ReleaseWindowClosed.selector);
        f.acceptEscrow(id);
        vm.warp(rd + 90 days);
        vm.prank(seller);
        vm.expectRevert(Fluxora.ReleaseWindowClosed.selector);
        f.acceptEscrow(id);
        uint256 before_ = tok.balanceOf(buyer);
        vm.prank(buyer);
        f.cancel(id);
        assertEq(tok.balanceOf(buyer), before_ + AMT, "funds are never stuck in Pending");
    }

    function test_Fixed_F03_CancelByBuyerAndSeller_RefundsFully_StrangerCannot() public {
        _setFee(100);
        uint256 a = _createPending(AMT, arbiter);
        uint256 b = _createPending(AMT, arbiter);
        address[3] memory bad = [stranger, arbiter, owner];
        for (uint256 i; i < bad.length; ++i) {
            vm.prank(bad[i]);
            vm.expectRevert(Fluxora.Unauthorized.selector);
            f.cancel(a);
        }
        uint256 before_ = tok.balanceOf(buyer);
        vm.prank(buyer);
        f.cancel(a);
        vm.prank(seller);
        f.cancel(b);
        assertEq(tok.balanceOf(buyer), before_ + 2 * AMT, "full refund, no fee");
        assertEq(tok.balanceOf(seller), 0);
        assertEq(tok.balanceOf(owner), 0);
        assertEq(tok.balanceOf(address(f)), 0);
        assertEq(uint8(_status(a)), uint8(Fluxora.Status.Refunded));
        assertEq(uint8(_status(b)), uint8(Fluxora.Status.Refunded));
    }

    function test_Fixed_F03_CancelAndAcceptWorkWhilePaused() public {
        uint256 a = _createPending(AMT, arbiter);
        uint256 b = _createPending(AMT, arbiter);
        vm.prank(owner);
        f.pause();
        _accept(a);
        vm.prank(buyer);
        f.cancel(b);
        assertEq(uint8(_status(a)), uint8(Fluxora.Status.Funded));
        assertEq(uint8(_status(b)), uint8(Fluxora.Status.Refunded));
    }

    // ── Arbiter limits ──

    function test_Fixed_F03_ArbiterCannotReleaseOrRefundFundedEscrow() public {
        uint256 id = _create(AMT, arbiter);
        vm.startPrank(arbiter);
        vm.expectRevert(Fluxora.Unauthorized.selector);
        f.release(id);
        vm.expectRevert(Fluxora.Unauthorized.selector);
        f.refund(id);
        vm.stopPrank();
        // not even after the buyer-refund window (where RefundNotAvailable guards the buyer)
        vm.warp(f.getEscrow(id).refundDeadline + 100 days);
        vm.startPrank(arbiter);
        vm.expectRevert(Fluxora.Unauthorized.selector);
        f.refund(id);
        vm.stopPrank();
        assertEq(uint8(_status(id)), uint8(Fluxora.Status.Funded));
        assertEq(tok.balanceOf(address(f)), AMT);
    }

    function test_Fixed_F03_ArbiterCanOnlyResolveAfterDispute() public {
        uint256 id = _create(AMT, arbiter);
        vm.prank(arbiter);
        vm.expectRevert(_invalidStatus(id, Fluxora.Status.Funded));
        f.resolve(id, true);
        vm.prank(arbiter);
        vm.expectRevert(_invalidStatus(id, Fluxora.Status.Funded));
        f.resolve(id, false);
        _dispute(id);
        vm.prank(arbiter);
        f.resolve(id, true);
        assertEq(tok.balanceOf(seller), AMT);
    }

    function test_Fixed_F03_ArbiterHasNoPowerBeforeSellerAccepts() public {
        uint256 id = _createPending(AMT, arbiter);
        vm.startPrank(arbiter);
        vm.expectRevert(_invalidStatus(id, Fluxora.Status.Pending));
        f.resolve(id, true);
        vm.expectRevert(_invalidStatus(id, Fluxora.Status.Pending));
        f.release(id);
        vm.expectRevert(_invalidStatus(id, Fluxora.Status.Pending));
        f.refund(id);
        vm.expectRevert(Fluxora.Unauthorized.selector);
        f.cancel(id);
        vm.stopPrank();
    }

    // ── Explicit expiry rule ──

    function test_Fixed_F03_ReleaseOnExpiry_BuyerCannotReclaim_AnyoneReleasesAtDeadline() public {
        _setFee(100);
        _setCollector(feeCol);
        address[4] memory callers = [stranger, buyer, seller, arbiter];
        for (uint256 i; i < callers.length; ++i) {
            uint256 id = _createRoe(AMT, address(0));
            uint256 fd = f.getEscrow(id).refundDeadline;
            vm.warp(fd - 1);
            vm.prank(callers[i]);
            vm.expectRevert(abi.encodeWithSelector(Fluxora.ExpiryReleaseNotAvailable.selector, id));
            f.releaseExpired(id);
            vm.prank(buyer);
            vm.expectRevert(Fluxora.RefundNotAvailable.selector);
            f.refund(id);

            vm.warp(fd); // exactly at refundDeadline
            vm.prank(buyer);
            vm.expectRevert(Fluxora.RefundNotAvailable.selector);
            f.refund(id);
            uint256 sellerBefore = tok.balanceOf(seller);
            uint256 feeBefore = tok.balanceOf(feeCol);
            vm.prank(callers[i]);
            f.releaseExpired(id);
            assertEq(tok.balanceOf(seller) - sellerBefore, 990e6);
            assertEq(tok.balanceOf(feeCol) - feeBefore, 10e6);
            assertEq(uint8(_status(id)), uint8(Fluxora.Status.Released));
        }
        assertEq(tok.balanceOf(address(f)), 0);
    }

    function test_Fixed_F03_ReleaseOnExpiry_SellerStillRefundsAndBuyerStillReleases() public {
        uint256 a = _createRoe(AMT, address(0));
        uint256 b = _createRoe(AMT, address(0));
        vm.prank(buyer);
        f.release(b); // normal release before the release deadline
        assertEq(tok.balanceOf(seller), AMT);
        vm.warp(f.getEscrow(a).refundDeadline + 50 days);
        uint256 before_ = tok.balanceOf(buyer);
        vm.prank(seller);
        f.refund(a); // the seller may always give the money back
        assertEq(tok.balanceOf(buyer), before_ + AMT);
    }

    function test_Fixed_F03_ReleaseOnExpiry_DisputeBeforeDeadlineBlocksExpiryRelease() public {
        uint256 id = _createRoe(AMT, arbiter);
        _dispute(id);
        vm.warp(f.getEscrow(id).refundDeadline);
        vm.expectRevert(_invalidStatus(id, Fluxora.Status.Disputed));
        f.releaseExpired(id);
    }

    function test_Fixed_F03_NoReleaseOnExpiry_BuyerRefundOpensAtDeadline_ReleaseExpiredReverts() public {
        uint256 id = _create(AMT, address(0));
        uint256 fd = f.getEscrow(id).refundDeadline;
        bytes memory notAvail = abi.encodeWithSelector(Fluxora.ExpiryReleaseNotAvailable.selector, id);
        vm.warp(fd - 1);
        vm.prank(buyer);
        vm.expectRevert(Fluxora.RefundNotAvailable.selector);
        f.refund(id);
        vm.expectRevert(notAvail);
        f.releaseExpired(id);
        vm.warp(fd);
        vm.expectRevert(notAvail);
        f.releaseExpired(id);
        vm.warp(fd + 365 days);
        vm.expectRevert(notAvail);
        f.releaseExpired(id);
        vm.prank(stranger);
        vm.expectRevert(Fluxora.Unauthorized.selector);
        f.refund(id);
        uint256 before_ = tok.balanceOf(buyer);
        vm.prank(buyer);
        f.refund(id);
        assertEq(tok.balanceOf(buyer), before_ + AMT);
        assertEq(tok.balanceOf(seller), 0);
    }

    // ── Terms are immutable once created; fee snapshots survive admin changes ──

    function _sameTerms(Fluxora.Escrow memory x, Fluxora.Escrow memory y) internal pure {
        assertEq(x.buyer, y.buyer);
        assertEq(x.seller, y.seller);
        assertEq(x.arbiter, y.arbiter);
        assertEq(x.token, y.token);
        assertEq(x.amount, y.amount);
        assertEq(x.releaseDeadline, y.releaseDeadline);
        assertEq(x.refundDeadline, y.refundDeadline);
        assertEq(x.fee, y.fee);
        assertEq(x.feeCollector, y.feeCollector);
        assertEq(x.ref, y.ref);
        assertEq(x.releaseOnExpiry, y.releaseOnExpiry);
    }

    function test_Fixed_F03_TermsImmutableAcrossLifecycleAndAdminChanges() public {
        _setFee(100);
        _setCollector(feeCol);
        uint256 id = _createP(AMT, arbiter, true);
        Fluxora.Escrow memory created = f.getEscrow(id);

        _setFee(0);
        _setCollector(makeAddr("otherCol"));
        vm.startPrank(owner);
        f.pause();
        f.setTokenSupported(address(tok), false);
        vm.stopPrank();
        _sameTerms(created, f.getEscrow(id));

        _accept(id);
        _sameTerms(created, f.getEscrow(id));
        _dispute(id);
        Fluxora.Escrow memory disputed = f.getEscrow(id);
        _sameTerms(created, disputed);
        assertEq(disputed.fee, 10e6, "fee snapshot survives setFeeBps");
        assertEq(disputed.feeCollector, feeCol, "collector snapshot survives setFeeRecipient");

        vm.prank(arbiter);
        f.resolve(id, true);
        assertEq(tok.balanceOf(feeCol), 10e6);
        assertEq(tok.balanceOf(seller), 990e6);
        _sameTerms(created, f.getEscrow(id));
    }

    function test_Fixed_F03_NoEntryPointCanChangeArbiterOrDeadlines() public {
        uint256 id = _create(AMT, arbiter);
        Fluxora.Escrow memory before_ = f.getEscrow(id);
        // every state-changing call by a non-authorised or wrong-state caller reverts and changes nothing
        vm.prank(arbiter);
        vm.expectRevert();
        f.release(id);
        vm.prank(stranger);
        vm.expectRevert();
        f.cancel(id);
        vm.prank(seller);
        vm.expectRevert();
        f.acceptEscrow(id);
        _sameTerms(before_, f.getEscrow(id));
        assertEq(uint8(f.getEscrow(id).status), uint8(Fluxora.Status.Funded));
    }

    function test_Fixed_F03_SellerCanRefundAnyTime() public {
        uint256 id = _create(AMT, address(0));
        uint256 before_ = tok.balanceOf(buyer);
        vm.prank(seller);
        f.refund(id);
        assertEq(tok.balanceOf(buyer), before_ + AMT);

        uint256 id2 = _create(AMT, address(0));
        vm.warp(f.getEscrow(id2).refundDeadline + 100 days);
        vm.prank(seller);
        f.refund(id2);
        assertEq(uint8(_status(id2)), uint8(Fluxora.Status.Refunded));

        uint256 id3 = _create(AMT, arbiter);
        vm.prank(owner);
        f.pause();
        vm.prank(seller);
        f.refund(id3); // also while paused
        assertEq(uint8(_status(id3)), uint8(Fluxora.Status.Refunded));
    }

    // ── Regressions of previously documented behaviours that must still hold ──

    function test_Regression_F03_SellerCannotPullFundsAfterReleaseDeadline_NoReleaseOnExpiry() public {
        uint256 id = _create(AMT, address(0));
        Fluxora.Escrow memory e = f.getEscrow(id);
        vm.warp(e.releaseDeadline);

        vm.prank(seller);
        vm.expectRevert(Fluxora.Unauthorized.selector); // seller can never release
        f.release(id);
        vm.prank(buyer);
        vm.expectRevert(Fluxora.ReleaseWindowClosed.selector);
        f.release(id);
        vm.prank(buyer);
        vm.expectRevert(Fluxora.RefundNotAvailable.selector);
        f.refund(id);
        vm.prank(seller); // no arbiter => no dispute either
        vm.expectRevert(Fluxora.DisputesDisabled.selector);
        f.dispute(id);

        vm.warp(e.refundDeadline);
        vm.prank(seller);
        vm.expectRevert(Fluxora.Unauthorized.selector);
        f.release(id);
        vm.prank(buyer);
        f.refund(id); // with releaseOnExpiry == false, the buyer reclaims everything
        assertEq(tok.balanceOf(seller), 0);
    }

    function test_Regression_F03_SellerOptionAfterReleaseDeadlineIsDisputeOrGiveUp() public {
        uint256 id = _create(AMT, arbiter);
        vm.warp(f.getEscrow(id).releaseDeadline + 1 days);
        vm.prank(seller);
        f.dispute(id); // keeps funds from the buyer's later refund
        vm.warp(f.getEscrow(id).refundDeadline + 1);
        vm.prank(buyer);
        vm.expectRevert(_invalidStatus(id, Fluxora.Status.Disputed));
        f.refund(id);
    }

    function test_Regression_RemovedTokenDoesNotBlockSettlement() public {
        uint256 a = _create(AMT, arbiter);
        uint256 b = _create(AMT, arbiter);
        uint256 c = _create(AMT, arbiter);
        uint256 d = _createPending(AMT, arbiter);
        uint256 e = _createPending(AMT, arbiter);
        vm.prank(owner);
        f.setTokenSupported(address(tok), false);

        vm.prank(buyer);
        vm.expectRevert(abi.encodeWithSelector(Fluxora.UnsupportedToken.selector, address(tok)));
        f.createEscrow(address(tok), seller, address(0), AMT, block.timestamp + DUR, false, 0);

        vm.prank(buyer);
        f.release(a);
        vm.prank(seller);
        f.refund(b);
        vm.prank(buyer);
        f.dispute(c);
        vm.prank(arbiter);
        f.resolve(c, true);
        _accept(d); // acceptance and cancellation are not gated by the allowlist either
        vm.prank(buyer);
        f.cancel(e);
        assertEq(tok.balanceOf(address(f)), AMT); // only d (accepted) remains
    }

    function test_Regression_NoArbiterEscrowDisablesDisputes() public {
        uint256 id = _create(AMT, address(0));
        vm.prank(buyer);
        vm.expectRevert(Fluxora.DisputesDisabled.selector);
        f.dispute(id);
        vm.prank(seller);
        vm.expectRevert(Fluxora.DisputesDisabled.selector);
        f.dispute(id);
        vm.prank(address(0)); // address(0) "arbiter" can't be exploited as a caller identity
        vm.expectRevert(Fluxora.Unauthorized.selector);
        f.dispute(id);
        vm.prank(buyer);
        vm.expectRevert(_invalidStatus(id, Fluxora.Status.Funded));
        f.resolve(id, true);
        vm.prank(address(0));
        vm.expectRevert(_invalidStatus(id, Fluxora.Status.Funded));
        f.resolve(id, true);
    }

    function test_Regression_ReleaseAtExactlyReleaseDeadlineReverts() public {
        uint256 id = _create(AMT, address(0));
        uint256 rd = f.getEscrow(id).releaseDeadline;
        vm.warp(rd);
        vm.prank(buyer);
        vm.expectRevert(Fluxora.ReleaseWindowClosed.selector);
        f.release(id);
        vm.warp(rd - 1);
        vm.prank(buyer);
        f.release(id);
        assertEq(tok.balanceOf(seller), AMT);
    }

    function test_Regression_BuyerRefundAtExactlyRefundDeadlineSucceeds() public {
        uint256 id = _create(AMT, arbiter);
        uint256 fd = f.getEscrow(id).refundDeadline;
        vm.warp(fd - 1);
        vm.prank(buyer);
        vm.expectRevert(Fluxora.RefundNotAvailable.selector);
        f.refund(id);
        vm.warp(fd);
        vm.prank(buyer);
        f.refund(id);
        assertEq(uint8(_status(id)), uint8(Fluxora.Status.Refunded));
    }

    function test_Regression_DisputeBoundary_LastSecondBeforeRefundDeadline() public {
        uint256 id = _create(AMT, arbiter);
        uint256 id2 = _create(AMT, arbiter);
        uint256 fd = f.getEscrow(id).refundDeadline;
        vm.warp(fd - 1);
        vm.prank(seller);
        f.dispute(id); // allowed
        assertEq(f.getEscrow(id).disputeDeadline, fd - 1 + 14 days);
        vm.warp(fd);
        vm.prank(seller);
        vm.expectRevert(Fluxora.DisputeWindowClosed.selector);
        f.dispute(id2);
    }
}

// ═════════════════════════ Residual risks (documented, still present; tests PASS by demonstrating them) ═════════════════════════

contract FluxoraResidualTest is FluxoraSecBase {
    /// F-04: the owner can change the fee and collector right before a buyer's createEscrow lands;
    /// the buyer has no maxFee / expected-collector guard. Bounded by the 1% cap, and the seller
    /// sees the snapshotted fee before accepting (and may cancel).
    function test_Residual_F04_OwnerFeeFrontRunChargesNewFee() public {
        assertEq(f.feeBps(), 0); // buyer prepared the tx while fee was 0
        _setFee(100); // owner tx lands first in the block
        uint256 id = _create(AMT, address(0));
        assertEq(f.getEscrow(id).fee, 10e6);
        vm.prank(buyer);
        f.release(id);
        assertEq(tok.balanceOf(seller), 990e6);
        assertEq(tok.balanceOf(owner), 10e6);
        assertLe(f.getEscrow(id).fee, AMT / 100); // bounded by the hard cap
    }

    function test_Residual_F04_OwnerCollectorFrontRunRedirectsFee() public {
        _setFee(100);
        address ownerAlt = makeAddr("ownerAlt");
        _setCollector(ownerAlt);
        uint256 id = _create(AMT, address(0));
        assertEq(f.getEscrow(id).feeCollector, ownerAlt);
        vm.prank(buyer);
        f.release(id);
        assertEq(tok.balanceOf(ownerAlt), 10e6);
    }

    function test_Residual_F04_SellerCanRejectUnexpectedFeeByCancelling() public {
        _setFee(100); // front-run fee
        uint256 id = _createPending(AMT, address(0));
        uint256 before_ = tok.balanceOf(buyer);
        vm.prank(seller); // the seller sees the snapshotted fee via getEscrow before accepting
        f.cancel(id);
        assertEq(tok.balanceOf(buyer), before_ + AMT);
    }

    /// Arbiter liveness is part of the terms the seller accepts: a buyer who names a dead arbiter and
    /// disputes in the last second before refundDeadline forces a 50/50 split after 14 days. The seller
    /// consented to that arbiter by accepting (and could have cancelled instead).
    function test_Residual_DeadArbiter_LastSecondDisputeForcesSplit() public {
        address deadArbiter = makeAddr("deadArbiter"); // never acts
        uint256 id = _create(AMT, deadArbiter);
        uint256 fd = f.getEscrow(id).refundDeadline;
        vm.warp(fd - 1);
        _dispute(id); // buyer disputes in the last possible second
        // seller cannot be paid in full and the buyer cannot reclaim: the funds wait out the window
        vm.prank(buyer);
        vm.expectRevert(_invalidStatus(id, Fluxora.Status.Disputed));
        f.refund(id);
        vm.warp(block.timestamp + WINDOW - 1);
        vm.expectRevert(abi.encodeWithSelector(Fluxora.DisputeNotExpired.selector, id));
        f.resolveExpired(id);
        vm.warp(block.timestamp + 1);
        uint256 buyerBefore = tok.balanceOf(buyer);
        f.resolveExpired(id);
        assertEq(tok.balanceOf(seller), AMT / 2, "seller who delivered only gets half");
        assertEq(tok.balanceOf(buyer), buyerBefore + AMT / 2);
        assertEq(uint8(_status(id)), uint8(Fluxora.Status.Split));
    }

    /// F-07: the token issuer freezes the Fluxora contract address. Payouts then accrue as credits but
    /// cannot be transferred out until the issuer unfreezes; Fluxora cannot work around the issuer.
    function test_Residual_F07_IssuerFreezeOfContract_PayoutsAccrueButNotTransferable() public {
        uint256 id = _create(AMT, address(0));
        tok.setBlocked(address(f), true); // issuer blocklists the Fluxora contract itself
        vm.prank(buyer);
        f.release(id); // settlement does not revert...
        assertEq(uint8(_status(id)), uint8(Fluxora.Status.Released));
        assertEq(tok.balanceOf(seller), 0); // ...but nobody was paid in tokens
        assertEq(f.claimable(address(tok), seller), AMT);
        assertEq(f.totalPending(address(tok)), AMT);

        vm.prank(seller);
        vm.expectRevert(abi.encodeWithSelector(SecToken.Blocked.selector, address(f)));
        f.claim(address(tok), altDest); // claims fail while frozen, and keep the credit
        assertEq(f.claimable(address(tok), seller), AMT);

        tok.setBlocked(address(f), false); // issuer unfreezes
        vm.prank(seller);
        f.claim(address(tok), altDest);
        assertEq(tok.balanceOf(altDest), AMT);
    }

    /// F-08: transferOwnership(address(0)) still reverts (ownership cannot be bricked by a typo).
    function test_Residual_F08_TransferOwnershipToZeroStillReverts() public {
        vm.prank(owner);
        vm.expectRevert(Fluxora.ZeroAddress.selector);
        f.transferOwnership(address(0));
        assertEq(f.owner(), owner);
        assertEq(f.pendingOwner(), address(0));
        vm.prank(owner);
        vm.expectRevert(Fluxora.RenunciationDisabled.selector);
        f.renounceOwnership();
    }
}

// ═════════════════════════ Stateful invariants ═════════════════════════

contract FluxoraHandler is Test {
    Fluxora public f;
    SecToken public tok;
    address public owner;
    address[2] public buyers;
    address[2] public sellers;
    address public arb;
    address public hfee;
    address public claimDest;
    uint256[] public ids;
    uint256 public donated;
    uint256 public nAcc;
    uint256 public nCancel;
    uint256 public nRel;
    uint256 public nRef;
    uint256 public nRelExp;
    uint256 public nDis;
    uint256 public nRes;
    uint256 public nSplit;
    uint256 public nClaim;
    uint256 public nDeferred;

    constructor(Fluxora f_, SecToken tok_, address owner_) {
        f = f_;
        tok = tok_;
        owner = owner_;
        buyers = [makeAddr("hb0"), makeAddr("hb1")];
        sellers = [makeAddr("hs0"), makeAddr("hs1")];
        arb = makeAddr("harb");
        hfee = makeAddr("hfee");
        claimDest = makeAddr("hclaimDest");
        for (uint256 i; i < 2; ++i) {
            tok.mint(buyers[i], 1e30);
            vm.prank(buyers[i]);
            tok.approve(address(f), type(uint256).max);
        }
    }

    function idsLength() external view returns (uint256) {
        return ids.length;
    }

    /// @dev Accounts that can ever hold payout credits (buyers, sellers, both collectors).
    function holder(uint256 i) public view returns (address) {
        if (i < 2) return buyers[i];
        if (i < 4) return sellers[i - 2];
        return i == 4 ? owner : hfee;
    }

    function create(uint256 amt, uint256 s, uint256 dur, bool roe) external {
        amt = bound(amt, 1, 1e12);
        dur = bound(dur, 1, 30 days);
        address b = buyers[s % 2];
        address sel = sellers[(s / 2) % 2];
        address a = (s / 4) % 2 == 0 ? address(0) : arb;
        uint256 rd = block.timestamp + dur;
        vm.prank(b);
        try f.createEscrow(address(tok), sel, a, amt, rd, roe, bytes32(0)) returns (uint256 id) {
            ids.push(id);
        } catch {}
    }

    function _pick(uint256 s) internal view returns (uint256 id, Fluxora.Escrow memory e) {
        id = ids[s % ids.length];
        e = f.getEscrow(id);
    }

    /// @dev Prefers an escrow currently in `want` (scanning from a fuzzed offset) so that valid
    ///      transitions are exercised often; falls back to a random escrow to also probe invalid ones.
    function _pickIn(uint256 s, Fluxora.Status want) internal view returns (uint256 id, Fluxora.Escrow memory e) {
        uint256 n = ids.length;
        if ((s / 11) % 5 != 0) {
            for (uint256 i; i < n; ++i) {
                uint256 cand = ids[(s + i) % n];
                Fluxora.Escrow memory c = f.getEscrow(cand);
                if (c.status == want) return (cand, c);
            }
        }
        return _pick(s);
    }

    function _who(Fluxora.Escrow memory e, uint256 s) internal view returns (address) {
        uint256 r = (s / 7) % 10;
        if (r < 4) return e.buyer;
        if (r < 8) return e.seller;
        if (r == 8) return e.arbiter == address(0) ? e.buyer : e.arbiter;
        return arb; // may or may not be this escrow's arbiter
    }

    function accept(uint256 s) external {
        if (ids.length == 0) return;
        (uint256 id, Fluxora.Escrow memory e) = _pickIn(s, Fluxora.Status.Pending);
        vm.prank((s / 7) % 6 == 0 ? e.buyer : e.seller);
        try f.acceptEscrow(id) { nAcc++; } catch {}
    }

    function cancel(uint256 s) external {
        if (ids.length == 0) return;
        (uint256 id, Fluxora.Escrow memory e) = _pickIn(s, Fluxora.Status.Pending);
        vm.prank(_who(e, s));
        try f.cancel(id) { nCancel++; } catch {}
    }

    function release(uint256 s) external {
        if (ids.length == 0) return;
        (uint256 id, Fluxora.Escrow memory e) = _pickIn(s, Fluxora.Status.Funded);
        vm.prank(_who(e, s));
        try f.release(id) { nRel++; } catch {}
    }

    function refund(uint256 s) external {
        if (ids.length == 0) return;
        (uint256 id, Fluxora.Escrow memory e) = _pickIn(s, Fluxora.Status.Funded);
        vm.prank(_who(e, s));
        try f.refund(id) { nRef++; } catch {}
    }

    function releaseExpired(uint256 s) external {
        if (ids.length == 0) return;
        (uint256 id,) = _pickIn(s, Fluxora.Status.Funded);
        vm.prank(makeAddr("anyone"));
        try f.releaseExpired(id) { nRelExp++; } catch {}
    }

    function dispute(uint256 s) external {
        if (ids.length == 0) return;
        (uint256 id, Fluxora.Escrow memory e) = _pickIn(s, Fluxora.Status.Funded);
        vm.prank(_who(e, s));
        try f.dispute(id) { nDis++; } catch {}
    }

    function resolve(uint256 s, bool toSeller) external {
        if (ids.length == 0 || s % 4 != 0) return; // arbiter is often "inactive", so splits happen
        (uint256 id, Fluxora.Escrow memory e) = _pickIn(s, Fluxora.Status.Disputed);
        vm.prank((s / 7) % 5 == 0 ? _who(e, s) : e.arbiter); // mostly the real arbiter
        try f.resolve(id, toSeller) { nRes++; } catch {}
    }

    function resolveExpired(uint256 s) external {
        if (ids.length == 0) return;
        (uint256 id,) = _pickIn(s, Fluxora.Status.Disputed);
        vm.prank(makeAddr("anyone"));
        try f.resolveExpired(id) { nSplit++; } catch {}
    }

    function claim(uint256 s) external {
        address who = holder(s % 6);
        vm.prank(who);
        try f.claim(address(tok), claimDest) { nClaim++; } catch {}
    }

    function setFee(uint256 bps) external {
        bps = bound(bps, 0, 100);
        vm.prank(owner);
        f.setFeeBps(bps);
    }

    function setCollector(bool useAlt) external {
        vm.prank(owner);
        f.setFeeRecipient(useAlt ? hfee : owner);
    }

    /// @dev Issuer blocklist toggle over every account that can be a payout recipient.
    function toggleBlock(uint256 s, bool blocked) external {
        address who = holder(s % 6);
        blocked = blocked && (s / 6) % 3 == 0; // mostly unblock, so payouts mostly succeed
        tok.setBlocked(who, blocked);
        if (blocked) nDeferred++; // counts toggles that may cause deferrals
    }

    /// @dev Direct token donations (no recovery path) – tracked so the accounting invariant stays exact.
    function donate(uint256 amt) external {
        amt = bound(amt, 0, 1e9);
        tok.mint(address(f), amt);
        donated += amt;
    }

    function pauseToggle(bool p, uint256 s) external {
        p = p && s % 6 == 0; // mostly unpaused
        vm.startPrank(owner);
        if (p && !f.paused()) f.pause();
        else if (!p && f.paused()) f.unpause();
        vm.stopPrank();
    }

    function warp(uint256 d) external {
        skip(d % 8 == 0 ? bound(d / 8, 3 days, 25 days) : bound(d, 0, 1 days)); // mostly small, sometimes big
    }
}

contract FluxoraSecurityInvariantTest is FluxoraSecBase {
    FluxoraHandler internal h;

    function setUp() public override {
        super.setUp();
        h = new FluxoraHandler(f, tok, owner);
        targetContract(address(h));
    }

    function _openSum() internal view returns (uint256 sum) {
        uint256 n = h.idsLength();
        for (uint256 i; i < n; ++i) {
            Fluxora.Escrow memory e = f.getEscrow(h.ids(i));
            if (
                e.status == Fluxora.Status.Pending || e.status == Fluxora.Status.Funded
                    || e.status == Fluxora.Status.Disputed
            ) sum += e.amount;
        }
    }

    /// balance >= open escrows + deferred credits (never insolvent), and exactly equal absent donations
    function invariant_BalanceCoversOpenEscrowsPlusPending() public view {
        uint256 owed = _openSum() + f.totalPending(address(tok));
        uint256 bal = tok.balanceOf(address(f));
        assertGe(bal, owed, "insolvent");
        assertEq(bal, owed + h.donated(), "balance != owed + donations");
    }

    /// totalPending is exactly the sum of per-account credits
    function invariant_TotalPendingEqualsSumOfCredits() public view {
        uint256 sum;
        for (uint256 i; i < 6; ++i) sum += f.claimable(address(tok), h.holder(i));
        assertEq(f.totalPending(address(tok)), sum);
    }

    /// fees are always within the 1% cap, and terminal/non-pending escrows keep consistent deadlines
    function invariant_EscrowTermsSane() public view {
        uint256 n = h.idsLength();
        for (uint256 i; i < n; ++i) {
            Fluxora.Escrow memory e = f.getEscrow(h.ids(i));
            assertLe(e.fee, e.amount / 100);
            assertEq(e.refundDeadline, e.releaseDeadline + 7 days);
            if (e.status == Fluxora.Status.Disputed || e.status == Fluxora.Status.Split) {
                assertGt(e.disputeDeadline, 0);
                assertTrue(e.arbiter != address(0));
            }
        }
    }

    function invariant_IdsAreSequential() public view {
        assertEq(f.nextEscrowId(), h.idsLength() + 1);
    }

    /// all minted tokens remain accounted for among known actors (plus Fluxora itself)
    function invariant_NoTokensLeakOrAppear() public view {
        uint256 total = tok.balanceOf(address(f)) + tok.balanceOf(owner) + tok.balanceOf(buyer);
        total += tok.balanceOf(h.buyers(0)) + tok.balanceOf(h.buyers(1));
        total += tok.balanceOf(h.sellers(0)) + tok.balanceOf(h.sellers(1));
        total += tok.balanceOf(h.arb()) + tok.balanceOf(h.hfee()) + tok.balanceOf(h.claimDest());
        assertEq(total, tok.totalSupply());
    }

    function afterInvariant() public {
        emit log_named_uint("accepts", h.nAcc());
        emit log_named_uint("cancels", h.nCancel());
        emit log_named_uint("releases", h.nRel());
        emit log_named_uint("refunds", h.nRef());
        emit log_named_uint("releaseExpired", h.nRelExp());
        emit log_named_uint("disputes", h.nDis());
        emit log_named_uint("resolves", h.nRes());
        emit log_named_uint("splits", h.nSplit());
        emit log_named_uint("claims", h.nClaim());
        emit log_named_uint("block toggles", h.nDeferred());
    }
}
