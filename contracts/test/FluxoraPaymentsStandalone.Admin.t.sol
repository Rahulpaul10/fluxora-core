// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {IAccessControl} from "@openzeppelin/contracts/access/IAccessControl.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {FluxoraPaymentsStandalone} from "../src/FluxoraPaymentsStandalone.sol";
import {FluxoraPaymentsStandaloneTestBase} from "./FluxoraPaymentsStandalone.Base.t.sol";

contract FluxoraPaymentsStandaloneAdminTest is FluxoraPaymentsStandaloneTestBase {
    bytes32 internal constant PAUSER = keccak256("PAUSER_ROLE");

    function _unauth(address who, bytes32 role) internal pure returns (bytes memory) {
        return abi.encodeWithSelector(IAccessControl.AccessControlUnauthorizedAccount.selector, who, role);
    }

    // ------------------------------------------------------------ constructor (ported)
    function test_ConstructorSetsRolesAndTokens() public view {
        assertTrue(pay.hasRole(pay.DEFAULT_ADMIN_ROLE(), admin));
        assertTrue(pay.hasRole(pay.PAUSER_ROLE(), pauser));
        assertTrue(pay.supportedTokens(address(usdc)));
        assertFalse(pay.supportedTokens(address(tokenB)));
        assertEq(pay.nextPaymentId(), 1);
        assertEq(pay.nextRequestId(), 1);
        assertEq(pay.feeBps(), 0);
        assertEq(pay.feeRecipient(), address(0));
        assertEq(pay.MAX_FEE_BPS(), 100);
        assertEq(pay.MAX_MEMO_BYTES(), 140);
    }

    function test_ConstructorEmitsTokenSupportUpdated() public {
        address[] memory tokens = new address[](1);
        tokens[0] = address(usdc);
        vm.expectEmit(true, false, false, true);
        emit FluxoraPaymentsStandalone.TokenSupportUpdated(address(usdc), true);
        new FluxoraPaymentsStandalone(DELAY, tokens);
    }

    function test_RevertConstructorZeroToken() public {
        address[] memory tokens = new address[](1);
        vm.expectRevert(abi.encodeWithSelector(FluxoraPaymentsStandalone.InvalidToken.selector, address(0)));
        new FluxoraPaymentsStandalone(DELAY, tokens);
    }

    function test_RevertConstructorEoaToken() public {
        address[] memory tokens = new address[](1);
        tokens[0] = alice;
        vm.expectRevert(abi.encodeWithSelector(FluxoraPaymentsStandalone.InvalidToken.selector, alice));
        new FluxoraPaymentsStandalone(DELAY, tokens);
    }

    // ------------------------------------------------------------ pause
    function test_PauserCanPauseAndUnpause() public {
        vm.prank(pauser);
        pay.pause();
        assertTrue(pay.paused());
        vm.prank(pauser);
        pay.unpause();
        assertFalse(pay.paused());
    }

    function test_RevertNonPauserPause() public {
        vm.prank(alice);
        vm.expectRevert(_unauth(alice, PAUSER));
        pay.pause();
    }

    function test_RevertNonPauserUnpause() public {
        vm.prank(pauser);
        pay.pause();
        vm.prank(alice);
        vm.expectRevert(_unauth(alice, PAUSER));
        pay.unpause();
    }

    function test_RevertUnpauseWhenNotPaused() public {
        vm.prank(pauser);
        vm.expectRevert(Pausable.ExpectedPause.selector);
        pay.unpause();
    }

    function test_RevertPauseWhenAlreadyPaused() public {
        vm.startPrank(pauser);
        pay.pause();
        vm.expectRevert(Pausable.EnforcedPause.selector);
        pay.pause();
        vm.stopPrank();
    }

    // ------------------------------------------------------------ setTokenSupported
    function test_AdminSetsTokenSupportedAndEmits() public {
        vm.expectEmit(true, false, false, true, address(pay));
        emit FluxoraPaymentsStandalone.TokenSupportUpdated(address(tokenB), true);
        vm.prank(admin);
        pay.setTokenSupported(address(tokenB), true);
        assertTrue(pay.supportedTokens(address(tokenB)));

        vm.expectEmit(true, false, false, true, address(pay));
        emit FluxoraPaymentsStandalone.TokenSupportUpdated(address(tokenB), false);
        vm.prank(admin);
        pay.setTokenSupported(address(tokenB), false);
        assertFalse(pay.supportedTokens(address(tokenB)));
    }

    function test_RevertSetTokenSupportedNonAdmin() public {
        vm.prank(alice);
        vm.expectRevert(_unauth(alice, bytes32(0)));
        pay.setTokenSupported(address(tokenB), true);
    }

    function test_RevertSetTokenSupportedZeroOrEoa() public {
        vm.startPrank(admin);
        vm.expectRevert(abi.encodeWithSelector(FluxoraPaymentsStandalone.InvalidToken.selector, address(0)));
        pay.setTokenSupported(address(0), true);
        vm.expectRevert(abi.encodeWithSelector(FluxoraPaymentsStandalone.InvalidToken.selector, alice));
        pay.setTokenSupported(alice, true);
        vm.expectRevert(abi.encodeWithSelector(FluxoraPaymentsStandalone.InvalidToken.selector, address(0)));
        pay.setTokenSupported(address(0), false);
        vm.stopPrank();
    }

    function test_RemoveEoaFromAllowlistIsAllowed() public {
        // removing only requires non-zero (matches original behaviour)
        vm.prank(admin);
        pay.setTokenSupported(alice, false);
        assertFalse(pay.supportedTokens(alice));
    }

    function test_DelistedTokenBlocksPayAndCreateRequest() public {
        vm.prank(admin);
        pay.setTokenSupported(address(usdc), false);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(FluxoraPaymentsStandalone.UnsupportedToken.selector, address(usdc)));
        pay.pay(address(usdc), bob, 1, bytes32(0), "", 0);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(FluxoraPaymentsStandalone.UnsupportedToken.selector, address(usdc)));
        pay.createRequest(address(usdc), 1, 0, bytes32(0), "");
    }

    function test_NewlyAllowlistedTokenWorks() public {
        vm.prank(admin);
        pay.setTokenSupported(address(tokenB), true);
        vm.prank(alice);
        pay.pay(address(tokenB), bob, 10, bytes32(0), "", 0);
        assertEq(tokenB.balanceOf(bob), 10);
    }

    // ------------------------------------------------------------ fee config
    function test_SetFeeRecipientThenFeeBpsEmits() public {
        vm.expectEmit(true, false, false, true, address(pay));
        emit FluxoraPaymentsStandalone.FeeUpdated(0, collector);
        vm.prank(admin);
        pay.setFeeRecipient(collector);
        assertEq(pay.feeRecipient(), collector);

        vm.expectEmit(true, false, false, true, address(pay));
        emit FluxoraPaymentsStandalone.FeeUpdated(75, collector);
        vm.prank(admin);
        pay.setFeeBps(75);
        assertEq(pay.feeBps(), 75);
    }

    function test_SetFeeBpsMaxAllowedAndZero() public {
        _setFee(100);
        assertEq(pay.feeBps(), 100);
        vm.prank(admin);
        pay.setFeeBps(0);
        assertEq(pay.feeBps(), 0);
    }

    function test_RevertSetFeeBpsAboveMax() public {
        _setFee(1);
        vm.prank(admin);
        vm.expectRevert(abi.encodeWithSelector(FluxoraPaymentsStandalone.InvalidFeeBps.selector, 101));
        pay.setFeeBps(101);
    }

    function test_RevertSetFeeBpsWithoutRecipient() public {
        vm.prank(admin);
        vm.expectRevert(abi.encodeWithSelector(FluxoraPaymentsStandalone.InvalidFeeRecipient.selector, address(0)));
        pay.setFeeBps(1);
    }

    function test_SetFeeBpsZeroWithoutRecipientOk() public {
        vm.prank(admin);
        pay.setFeeBps(0);
        assertEq(pay.feeBps(), 0);
    }

    function test_RevertSetFeeBpsNonAdmin() public {
        vm.prank(alice);
        vm.expectRevert(_unauth(alice, bytes32(0)));
        pay.setFeeBps(1);
    }

    function test_RevertSetFeeRecipientNonAdmin() public {
        vm.prank(alice);
        vm.expectRevert(_unauth(alice, bytes32(0)));
        pay.setFeeRecipient(collector);
    }

    function test_RevertSetFeeRecipientSelf() public {
        vm.prank(admin);
        vm.expectRevert(abi.encodeWithSelector(FluxoraPaymentsStandalone.InvalidFeeRecipient.selector, address(pay)));
        pay.setFeeRecipient(address(pay));
    }

    function test_RevertSetFeeRecipientZeroWhileFeeActive() public {
        _setFee(50);
        vm.prank(admin);
        vm.expectRevert(abi.encodeWithSelector(FluxoraPaymentsStandalone.InvalidFeeRecipient.selector, address(0)));
        pay.setFeeRecipient(address(0));
    }

    function test_SetFeeRecipientZeroWhenFeeZeroOk() public {
        _setFee(0);
        vm.prank(admin);
        pay.setFeeRecipient(address(0));
        assertEq(pay.feeRecipient(), address(0));
    }

    // ------------------------------------------------------------ quoteFee + fuzz
    function test_QuoteFeeRoundsUp() public {
        _setFee(100);
        assertEq(pay.quoteFee(0), 0);
        assertEq(pay.quoteFee(1), 1);
        assertEq(pay.quoteFee(100), 1);
        assertEq(pay.quoteFee(101), 2);
        assertEq(pay.quoteFee(10_000), 100);
    }

    function test_QuoteFeeZeroWhenFeeDisabled() public view {
        assertEq(pay.quoteFee(123_456_789), 0);
    }

    function testFuzz_QuoteFeeIsCeilAndBounded(uint256 amount, uint256 bps) public {
        amount = bound(amount, 0, type(uint128).max);
        bps = bound(bps, 0, 100);
        _setFee(bps);
        uint256 fee = pay.quoteFee(amount);
        uint256 exact = amount * bps;
        assertEq(fee, (exact + 9_999) / 10_000);
        assertGe(fee * 10_000, exact);
        assertLt(fee * 10_000, exact + 10_000);
        assertLe(fee, amount / 100 + 1);
        if (amount % 100 == 0) assertLe(fee, amount / 100);
    }

    function testFuzz_QuoteFeeMonotonicInAmount(uint256 a, uint256 b, uint256 bps) public {
        a = bound(a, 0, type(uint120).max);
        b = bound(b, a, type(uint120).max);
        bps = bound(bps, 0, 100);
        _setFee(bps);
        assertLe(pay.quoteFee(a), pay.quoteFee(b));
    }
}
