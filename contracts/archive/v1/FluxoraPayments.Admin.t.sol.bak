// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {IAccessControl} from "@openzeppelin/contracts/access/IAccessControl.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {FluxoraPayments} from "../src/FluxoraPayments.sol";
import {FluxoraPaymentsTestBase} from "./FluxoraPayments.Base.t.sol";

contract FluxoraPaymentsAdminTest is FluxoraPaymentsTestBase {
    bytes32 internal constant PAUSER = keccak256("PAUSER_ROLE");

    function _unauth(address who, bytes32 role) internal pure returns (bytes memory) {
        return abi.encodeWithSelector(IAccessControl.AccessControlUnauthorizedAccount.selector, who, role);
    }

    // ------------------------------------------------------------ constructor
    function test_ConstructorSetsRolesAndTokens() public view {
        assertTrue(pay.hasRole(pay.DEFAULT_ADMIN_ROLE(), admin));
        assertTrue(pay.hasRole(pay.PAUSER_ROLE(), pauser));
        assertFalse(pay.hasRole(pay.DEFAULT_ADMIN_ROLE(), pauser));
        assertTrue(pay.supportedTokens(address(usdc)));
        assertFalse(pay.supportedTokens(address(tokenB)));
        assertEq(pay.nextPaymentId(), 1);
        assertEq(pay.nextRequestId(), 1);
        assertEq(pay.feeBps(), 0);
        assertEq(pay.MAX_FEE_BPS(), 100);
        assertEq(pay.MAX_MEMO_BYTES(), 140);
    }

    function test_ConstructorEmitsTokenSupportUpdated() public {
        address[] memory tokens = new address[](1);
        tokens[0] = address(usdc);
        vm.expectEmit(true, false, false, true);
        emit FluxoraPayments.TokenSupportUpdated(address(usdc), true);
        new FluxoraPayments(admin, pauser, tokens);
    }

    function test_RevertConstructorZeroAdmin() public {
        vm.expectRevert(FluxoraPayments.ZeroAddress.selector);
        new FluxoraPayments(address(0), pauser, new address[](0));
    }

    function test_RevertConstructorZeroPauser() public {
        vm.expectRevert(FluxoraPayments.ZeroAddress.selector);
        new FluxoraPayments(admin, address(0), new address[](0));
    }

    function test_RevertConstructorZeroToken() public {
        address[] memory tokens = new address[](1);
        vm.expectRevert(abi.encodeWithSelector(FluxoraPayments.InvalidToken.selector, address(0)));
        new FluxoraPayments(admin, pauser, tokens);
    }

    function test_RevertConstructorEoaToken() public {
        address[] memory tokens = new address[](1);
        tokens[0] = alice;
        vm.expectRevert(abi.encodeWithSelector(FluxoraPayments.InvalidToken.selector, alice));
        new FluxoraPayments(admin, pauser, tokens);
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
        vm.prank(admin); // admin is NOT automatically a pauser
        vm.expectRevert(_unauth(admin, PAUSER));
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

    // ------------------------------------------------------------ setTokenSupported
    function test_AdminSetsTokenSupportedAndEmits() public {
        vm.expectEmit(true, false, false, true, address(pay));
        emit FluxoraPayments.TokenSupportUpdated(address(tokenB), true);
        vm.prank(admin);
        pay.setTokenSupported(address(tokenB), true);
        assertTrue(pay.supportedTokens(address(tokenB)));

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
        vm.expectRevert(abi.encodeWithSelector(FluxoraPayments.InvalidToken.selector, address(0)));
        pay.setTokenSupported(address(0), true);
        vm.expectRevert(abi.encodeWithSelector(FluxoraPayments.InvalidToken.selector, alice));
        pay.setTokenSupported(alice, true);
        vm.expectRevert(abi.encodeWithSelector(FluxoraPayments.InvalidToken.selector, address(0)));
        pay.setTokenSupported(address(0), false);
        vm.stopPrank();
    }

    // ------------------------------------------------------------ fee config
    function test_SetFeeRecipientThenFeeBpsEmits() public {
        vm.expectEmit(true, false, false, true, address(pay));
        emit FluxoraPayments.FeeUpdated(0, collector);
        vm.prank(admin);
        pay.setFeeRecipient(collector);
        assertEq(pay.feeRecipient(), collector);

        vm.expectEmit(true, false, false, true, address(pay));
        emit FluxoraPayments.FeeUpdated(75, collector);
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
        vm.expectRevert(abi.encodeWithSelector(FluxoraPayments.InvalidFeeBps.selector, 101));
        pay.setFeeBps(101);
    }

    function test_RevertSetFeeBpsWithoutRecipient() public {
        vm.prank(admin);
        vm.expectRevert(abi.encodeWithSelector(FluxoraPayments.InvalidFeeRecipient.selector, address(0)));
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
        vm.expectRevert(abi.encodeWithSelector(FluxoraPayments.InvalidFeeRecipient.selector, address(pay)));
        pay.setFeeRecipient(address(pay));
    }

    function test_RevertSetFeeRecipientZeroWhileFeeActive() public {
        _setFee(50);
        vm.prank(admin);
        vm.expectRevert(abi.encodeWithSelector(FluxoraPayments.InvalidFeeRecipient.selector, address(0)));
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

    function testFuzz_QuoteFeeIsCeilAndBounded(uint256 amount, uint256 bps) public {
        amount = bound(amount, 0, type(uint128).max);
        bps = bound(bps, 0, 100);
        _setFee(bps);
        uint256 fee = pay.quoteFee(amount);
        uint256 exact = amount * bps;
        // ceil(amount * bps / 10_000)
        assertEq(fee, (exact + 9_999) / 10_000);
        // never undercharges, overcharges by < 1 unit
        assertGe(fee * 10_000, exact);
        assertLt(fee * 10_000, exact + 10_000);
        // fee <= 1% of amount, up to the single rounding unit
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
