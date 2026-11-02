// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {IAccessControl} from "@openzeppelin/contracts/access/IAccessControl.sol";
import {IAccessControlDefaultAdminRules} from
    "@openzeppelin/contracts/access/extensions/IAccessControlDefaultAdminRules.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {FluxoraPaymentsStandalone as FPS} from "../src/FluxoraPaymentsStandalone.sol";
import {FluxoraPaymentsStandaloneTestBase} from "./FluxoraPaymentsStandalone.Base.t.sol";

/// @dev Tests for what differs from FluxoraPayments: constructor, default-admin rules, role model.
contract FluxoraPaymentsStandaloneAdminRulesTest is FluxoraPaymentsStandaloneTestBase {
    bytes32 internal constant ADMIN_ROLE = 0x00;
    bytes32 internal constant PAUSER = keccak256("PAUSER_ROLE");
    address internal newAdmin = makeAddr("newAdmin");

    function _unauth(address who, bytes32 role) internal pure returns (bytes memory) {
        return abi.encodeWithSelector(IAccessControl.AccessControlUnauthorizedAccount.selector, who, role);
    }

    function _deploy(uint48 delay) internal returns (FPS) {
        vm.prank(deployer);
        return new FPS(delay, new address[](0));
    }

    function _begin() internal returns (uint48 schedule) {
        schedule = uint48(block.timestamp) + DELAY;
        vm.prank(admin);
        pay.beginDefaultAdminTransfer(newAdmin);
    }

    // ------------------------------------------------------------ constructor delay bounds
    function test_ConstantsForDelayBounds() public view {
        assertEq(pay.MIN_ADMIN_TRANSFER_DELAY(), 1 days);
        assertEq(pay.MAX_ADMIN_TRANSFER_DELAY(), 30 days);
    }

    function test_RevertConstructorDelayZero() public {
        vm.expectRevert(abi.encodeWithSelector(FPS.InvalidAdminTransferDelay.selector, 0, 1 days, 30 days));
        _deploy(0);
    }

    function test_RevertConstructorDelayBelowMin() public {
        vm.expectRevert(
            abi.encodeWithSelector(FPS.InvalidAdminTransferDelay.selector, uint48(1 days - 1), 1 days, 30 days)
        );
        _deploy(1 days - 1);
    }

    function test_RevertConstructorDelayAboveMax() public {
        vm.expectRevert(
            abi.encodeWithSelector(FPS.InvalidAdminTransferDelay.selector, uint48(30 days + 1), 1 days, 30 days)
        );
        _deploy(30 days + 1);
    }

    function test_ConstructorDelayExactlyMinOk() public {
        FPS p = _deploy(1 days);
        assertEq(p.defaultAdminDelay(), 1 days);
    }

    function test_ConstructorDelayExactlyMaxOk() public {
        FPS p = _deploy(30 days);
        assertEq(p.defaultAdminDelay(), 30 days);
    }

    function testFuzz_ConstructorDelayInRangeOk(uint48 delay) public {
        delay = uint48(bound(delay, 1 days, 30 days));
        assertEq(_deploy(delay).defaultAdminDelay(), delay);
    }

    function testFuzz_ConstructorDelayOutOfRangeReverts(uint48 delay) public {
        vm.assume(delay < 1 days || delay > 30 days);
        vm.expectRevert(abi.encodeWithSelector(FPS.InvalidAdminTransferDelay.selector, delay, 1 days, 30 days));
        _deploy(delay);
    }

    // ------------------------------------------------------------ constructor tokens
    function test_ConstructorAllowlistsAllInitialTokensAndToleratesDuplicates() public {
        address[] memory tokens = new address[](3);
        tokens[0] = address(usdc);
        tokens[1] = address(tokenB);
        tokens[2] = address(usdc);
        vm.prank(deployer);
        FPS p = new FPS(DELAY, tokens);
        assertTrue(p.supportedTokens(address(usdc)));
        assertTrue(p.supportedTokens(address(tokenB)));
    }

    function test_ConstructorEmptyTokensOk() public {
        FPS p = _deploy(DELAY);
        assertFalse(p.supportedTokens(address(usdc)));
    }

    function test_ConstructorEmitsOneEventPerInitialToken() public {
        address[] memory tokens = new address[](2);
        tokens[0] = address(usdc);
        tokens[1] = address(tokenB);
        vm.expectEmit(true, false, false, true);
        emit FPS.TokenSupportUpdated(address(usdc), true);
        vm.expectEmit(true, false, false, true);
        emit FPS.TokenSupportUpdated(address(tokenB), true);
        vm.prank(deployer);
        new FPS(DELAY, tokens);
    }

    function test_RevertConstructorInvalidTokenInLaterPosition() public {
        address[] memory tokens = new address[](2);
        tokens[0] = address(usdc);
        tokens[1] = bob; // EOA
        vm.expectRevert(abi.encodeWithSelector(FPS.InvalidToken.selector, bob));
        vm.prank(deployer);
        new FPS(DELAY, tokens);
    }

    function test_ConstructorDelayCheckedBeforeTokens() public {
        address[] memory tokens = new address[](1); // zero token would be invalid
        vm.expectRevert(abi.encodeWithSelector(FPS.InvalidAdminTransferDelay.selector, 0, 1 days, 30 days));
        vm.prank(deployer);
        new FPS(0, tokens);
    }

    // ------------------------------------------------------------ initial roles
    function test_DeployerIsAdminAndPauser() public view {
        assertTrue(pay.hasRole(ADMIN_ROLE, deployer));
        assertTrue(pay.hasRole(PAUSER, deployer));
        assertEq(pay.defaultAdmin(), deployer);
        assertEq(pay.owner(), deployer);
        assertEq(pay.defaultAdminDelay(), DELAY);
        (address pendingAdmin, uint48 schedule) = pay.pendingDefaultAdmin();
        assertEq(pendingAdmin, address(0));
        assertEq(schedule, 0);
        assertEq(pay.getRoleAdmin(PAUSER), ADMIN_ROLE);
        assertEq(pay.feeBps(), 0);
        assertEq(pay.feeRecipient(), address(0));
        assertFalse(pay.paused());
    }

    function test_NobodyElseHasAnyRole() public view {
        address[8] memory others =
            [alice, bob, carol, collector, address(this), address(pay), address(usdc), address(0)];
        for (uint256 i; i < others.length; ++i) {
            assertFalse(pay.hasRole(ADMIN_ROLE, others[i]));
            assertFalse(pay.hasRole(PAUSER, others[i]));
        }
    }

    function test_DeployerIsMsgSenderNotTxOrigin() public {
        // Deployer address is msg.sender of the constructor, whatever tx.origin is.
        vm.prank(deployer, alice);
        FPS p = new FPS(DELAY, new address[](0));
        assertEq(p.defaultAdmin(), deployer);
        assertFalse(p.hasRole(ADMIN_ROLE, alice));
    }

    // ------------------------------------------------------------ direct DEFAULT_ADMIN_ROLE changes blocked
    function test_RevertAdminGrantAdminRole() public {
        vm.prank(admin);
        vm.expectRevert(IAccessControlDefaultAdminRules.AccessControlEnforcedDefaultAdminRules.selector);
        pay.grantRole(ADMIN_ROLE, alice);
        assertFalse(pay.hasRole(ADMIN_ROLE, alice));
    }

    function test_RevertAdminRevokeAdminRole() public {
        vm.prank(admin);
        vm.expectRevert(IAccessControlDefaultAdminRules.AccessControlEnforcedDefaultAdminRules.selector);
        pay.revokeRole(ADMIN_ROLE, admin);
        assertTrue(pay.hasRole(ADMIN_ROLE, admin));
    }

    function test_RevertNonAdminGrantAdminRole() public {
        vm.prank(alice);
        vm.expectRevert(IAccessControlDefaultAdminRules.AccessControlEnforcedDefaultAdminRules.selector);
        pay.grantRole(ADMIN_ROLE, alice);
    }

    function test_RevertAdminRenounceAdminRoleDirectly() public {
        // Renouncing the admin role is disabled outright, so the contract can never be left without an admin.
        vm.prank(admin);
        vm.expectRevert(FPS.AdminRenunciationDisabled.selector);
        pay.renounceRole(ADMIN_ROLE, admin);
        assertTrue(pay.hasRole(ADMIN_ROLE, admin));
    }

    function test_RevertRenounceAdminRoleWhileTransferToNonZeroPending() public {
        uint48 schedule = _begin();
        vm.warp(schedule + 1);
        vm.prank(admin);
        vm.expectRevert(FPS.AdminRenunciationDisabled.selector);
        pay.renounceRole(ADMIN_ROLE, admin);
        assertTrue(pay.hasRole(ADMIN_ROLE, admin));
    }

    function test_TransferToZeroAddressIsRejectedSoAdminCanNeverBeBurned() public {
        vm.prank(admin);
        vm.expectRevert(FPS.ZeroAddress.selector);
        pay.beginDefaultAdminTransfer(address(0));
        assertEq(pay.defaultAdmin(), admin);
        // A paused contract can always be unpaused because an admin (and pauser) always exists.
        vm.startPrank(admin);
        pay.pause();
        pay.unpause();
        vm.stopPrank();
    }

    // ------------------------------------------------------------ two-step transfer
    function test_BeginTransferSchedulesAndEmits() public {
        uint48 schedule = uint48(block.timestamp) + DELAY;
        vm.expectEmit(true, false, false, true, address(pay));
        emit IAccessControlDefaultAdminRules.DefaultAdminTransferScheduled(newAdmin, schedule);
        vm.prank(admin);
        pay.beginDefaultAdminTransfer(newAdmin);
        (address pendingAdmin, uint48 s) = pay.pendingDefaultAdmin();
        assertEq(pendingAdmin, newAdmin);
        assertEq(s, schedule);
        // nothing changed yet
        assertEq(pay.defaultAdmin(), admin);
        assertFalse(pay.hasRole(ADMIN_ROLE, newAdmin));
    }

    function test_RevertAcceptBeforeDelay() public {
        uint48 schedule = _begin();
        vm.prank(newAdmin);
        vm.expectRevert(
            abi.encodeWithSelector(IAccessControlDefaultAdminRules.AccessControlEnforcedDefaultAdminDelay.selector, schedule)
        );
        pay.acceptDefaultAdminTransfer();
        vm.warp(schedule - 1);
        vm.prank(newAdmin);
        vm.expectRevert(
            abi.encodeWithSelector(IAccessControlDefaultAdminRules.AccessControlEnforcedDefaultAdminDelay.selector, schedule)
        );
        pay.acceptDefaultAdminTransfer();
        // OZ uses a strict comparison: exactly at the schedule it is still not accepted
        vm.warp(schedule);
        vm.prank(newAdmin);
        vm.expectRevert(
            abi.encodeWithSelector(IAccessControlDefaultAdminRules.AccessControlEnforcedDefaultAdminDelay.selector, schedule)
        );
        pay.acceptDefaultAdminTransfer();
    }

    function test_RevertAcceptByAnyoneButNewAdmin() public {
        uint48 schedule = _begin();
        vm.warp(schedule + 1);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(IAccessControlDefaultAdminRules.AccessControlInvalidDefaultAdmin.selector, alice));
        pay.acceptDefaultAdminTransfer();
        vm.prank(admin);
        vm.expectRevert(abi.encodeWithSelector(IAccessControlDefaultAdminRules.AccessControlInvalidDefaultAdmin.selector, admin));
        pay.acceptDefaultAdminTransfer();
        assertEq(pay.defaultAdmin(), admin);
    }

    function test_RevertAcceptWithNoPendingTransfer() public {
        vm.prank(newAdmin);
        vm.expectRevert(abi.encodeWithSelector(IAccessControlDefaultAdminRules.AccessControlInvalidDefaultAdmin.selector, newAdmin));
        pay.acceptDefaultAdminTransfer();
    }

    function test_TransferEndToEndOldAdminLosesNewAdminGains() public {
        _setFee(10);
        uint48 schedule = _begin();
        vm.warp(schedule + 1);
        vm.prank(newAdmin);
        pay.acceptDefaultAdminTransfer();

        assertEq(pay.defaultAdmin(), newAdmin);
        assertEq(pay.owner(), newAdmin);
        assertTrue(pay.hasRole(ADMIN_ROLE, newAdmin));
        assertFalse(pay.hasRole(ADMIN_ROLE, admin));
        (address pendingAdmin, uint48 s) = pay.pendingDefaultAdmin();
        assertEq(pendingAdmin, address(0));
        assertEq(s, 0);

        // old admin lost every admin function
        vm.startPrank(admin);
        vm.expectRevert(_unauth(admin, ADMIN_ROLE));
        pay.setFeeBps(5);
        vm.expectRevert(_unauth(admin, ADMIN_ROLE));
        pay.setFeeRecipient(alice);
        vm.expectRevert(_unauth(admin, ADMIN_ROLE));
        pay.setTokenSupported(address(tokenB), true);
        vm.expectRevert(_unauth(admin, ADMIN_ROLE));
        pay.beginDefaultAdminTransfer(admin);
        vm.stopPrank();

        // new admin has them all
        vm.startPrank(newAdmin);
        pay.setFeeBps(5);
        pay.setFeeRecipient(alice);
        pay.setTokenSupported(address(tokenB), true);
        vm.stopPrank();
        assertEq(pay.feeBps(), 5);
        assertEq(pay.feeRecipient(), alice);
        assertTrue(pay.supportedTokens(address(tokenB)));
    }

    function test_PauserRoleFollowsAdminOnTransfer() public {
        uint48 schedule = _begin();
        vm.warp(schedule + 1);
        vm.prank(newAdmin);
        pay.acceptDefaultAdminTransfer();
        // The new admin is a pauser automatically and the old admin lost the pauser role in the same transaction.
        assertTrue(pay.hasRole(PAUSER, newAdmin));
        assertFalse(pay.hasRole(PAUSER, admin));
        vm.prank(admin);
        vm.expectRevert(_unauth(admin, PAUSER));
        pay.pause();
        vm.prank(newAdmin);
        pay.pause();
        assertTrue(pay.paused());
    }

    function test_ExtraPausersSurviveHandoverUntilRevoked() public {
        address hot = makeAddr("hotPauser");
        vm.prank(admin);
        pay.grantRole(PAUSER, hot);
        uint48 schedule = _begin();
        vm.warp(schedule + 1);
        vm.prank(newAdmin);
        pay.acceptDefaultAdminTransfer();
        assertTrue(pay.hasRole(PAUSER, hot));
        vm.prank(newAdmin);
        pay.revokeRole(PAUSER, hot);
        assertFalse(pay.hasRole(PAUSER, hot));
    }

    function test_ExtraRolesCanStillBeRenouncedButAdminCannot() public {
        vm.prank(admin);
        pay.renounceRole(PAUSER, admin); // pauser is renounceable; the admin can grant it again at any time
        assertFalse(pay.hasRole(PAUSER, admin));
        vm.startPrank(admin);
        pay.grantRole(PAUSER, admin);
        vm.expectRevert(FPS.AdminRenunciationDisabled.selector);
        pay.renounceRole(ADMIN_ROLE, admin);
        vm.stopPrank();
        assertEq(pay.defaultAdmin(), admin);
    }

    function test_NewAdminCanGrantItselfPauser() public {
        uint48 schedule = _begin();
        vm.warp(schedule + 1);
        vm.startPrank(newAdmin);
        pay.acceptDefaultAdminTransfer();
        pay.grantRole(PAUSER, newAdmin);
        pay.pause();
        vm.stopPrank();
        assertTrue(pay.paused());
    }

    function test_CancelTransferWorks() public {
        uint48 schedule = _begin();
        vm.expectEmit(false, false, false, true, address(pay));
        emit IAccessControlDefaultAdminRules.DefaultAdminTransferCanceled();
        vm.prank(admin);
        pay.cancelDefaultAdminTransfer();
        (address pendingAdmin, uint48 s) = pay.pendingDefaultAdmin();
        assertEq(pendingAdmin, address(0));
        assertEq(s, 0);
        vm.warp(schedule + 1);
        vm.prank(newAdmin);
        vm.expectRevert(abi.encodeWithSelector(IAccessControlDefaultAdminRules.AccessControlInvalidDefaultAdmin.selector, newAdmin));
        pay.acceptDefaultAdminTransfer();
        assertEq(pay.defaultAdmin(), admin);
    }

    function test_RevertCancelTransferNonAdmin() public {
        _begin();
        vm.prank(alice);
        vm.expectRevert(_unauth(alice, ADMIN_ROLE));
        pay.cancelDefaultAdminTransfer();
        vm.prank(newAdmin);
        vm.expectRevert(_unauth(newAdmin, ADMIN_ROLE));
        pay.cancelDefaultAdminTransfer();
    }

    function test_AdminCanReplacePendingTransfer() public {
        _begin();
        vm.warp(block.timestamp + 1 hours);
        uint48 schedule2 = uint48(block.timestamp) + DELAY;
        vm.prank(admin);
        pay.beginDefaultAdminTransfer(carol);
        (address pendingAdmin, uint48 s) = pay.pendingDefaultAdmin();
        assertEq(pendingAdmin, carol);
        assertEq(s, schedule2);
        vm.warp(schedule2 + 1);
        vm.prank(newAdmin);
        vm.expectRevert(abi.encodeWithSelector(IAccessControlDefaultAdminRules.AccessControlInvalidDefaultAdmin.selector, newAdmin));
        pay.acceptDefaultAdminTransfer();
        vm.prank(carol);
        pay.acceptDefaultAdminTransfer();
        assertEq(pay.defaultAdmin(), carol);
    }

    function test_NewAdminCanTransferAgain() public {
        uint48 schedule = _begin();
        vm.warp(schedule + 1);
        vm.prank(newAdmin);
        pay.acceptDefaultAdminTransfer();
        vm.prank(newAdmin);
        pay.beginDefaultAdminTransfer(admin);
        vm.warp(block.timestamp + DELAY + 1);
        vm.prank(admin);
        pay.acceptDefaultAdminTransfer();
        assertEq(pay.defaultAdmin(), admin);
    }

    // ------------------------------------------------------------ delay changes (informational)
    function test_ChangeDelayRespectsBounds() public {
        // Same 1..30 day bounds as the constructor: the two-step admin protection cannot be weakened later.
        vm.startPrank(admin);
        vm.expectRevert(abi.encodeWithSelector(
            FPS.InvalidAdminTransferDelay.selector, uint48(1 hours), uint48(1 days), uint48(30 days)
        ));
        pay.changeDefaultAdminDelay(1 hours);
        vm.expectRevert(abi.encodeWithSelector(
            FPS.InvalidAdminTransferDelay.selector, uint48(0), uint48(1 days), uint48(30 days)
        ));
        pay.changeDefaultAdminDelay(0);
        vm.expectRevert(abi.encodeWithSelector(
            FPS.InvalidAdminTransferDelay.selector, uint48(30 days + 1), uint48(1 days), uint48(30 days)
        ));
        pay.changeDefaultAdminDelay(30 days + 1);
        // exactly the bounds are accepted
        pay.changeDefaultAdminDelay(1 days);
        pay.changeDefaultAdminDelay(30 days);
        vm.stopPrank();
        (uint48 newDelay,) = pay.pendingDefaultAdminDelay();
        assertEq(newDelay, 30 days);
    }

    function test_RevertChangeDelayNonAdmin() public {
        vm.prank(alice);
        vm.expectRevert(_unauth(alice, ADMIN_ROLE));
        pay.changeDefaultAdminDelay(1 days);
        vm.prank(alice);
        vm.expectRevert(_unauth(alice, ADMIN_ROLE));
        pay.rollbackDefaultAdminDelay();
    }

    // ------------------------------------------------------------ non-admin cannot use admin functions
    function test_RevertNonAdminCannotCallAdminFunctions() public {
        address[3] memory callers = [alice, carol, address(this)];
        for (uint256 i; i < callers.length; ++i) {
            address c = callers[i];
            vm.startPrank(c);
            vm.expectRevert(_unauth(c, ADMIN_ROLE));
            pay.setTokenSupported(address(tokenB), true);
            vm.expectRevert(_unauth(c, ADMIN_ROLE));
            pay.setFeeBps(0);
            vm.expectRevert(_unauth(c, ADMIN_ROLE));
            pay.setFeeRecipient(c);
            vm.expectRevert(_unauth(c, ADMIN_ROLE));
            pay.beginDefaultAdminTransfer(c);
            vm.stopPrank();
        }
    }

    // ------------------------------------------------------------ pauser role management
    function test_AdminCanGrantAndRevokePauserRole() public {
        vm.expectEmit(true, true, true, true, address(pay));
        emit IAccessControl.RoleGranted(PAUSER, alice, admin);
        vm.prank(admin);
        pay.grantRole(PAUSER, alice);
        assertTrue(pay.hasRole(PAUSER, alice));

        vm.expectEmit(true, true, true, true, address(pay));
        emit IAccessControl.RoleRevoked(PAUSER, alice, admin);
        vm.prank(admin);
        pay.revokeRole(PAUSER, alice);
        assertFalse(pay.hasRole(PAUSER, alice));
        vm.prank(alice);
        vm.expectRevert(_unauth(alice, PAUSER));
        pay.pause();
    }

    function test_RevertNonAdminCannotGrantOrRevokePauser() public {
        vm.prank(alice);
        vm.expectRevert(_unauth(alice, ADMIN_ROLE));
        pay.grantRole(PAUSER, alice);
        vm.prank(alice);
        vm.expectRevert(_unauth(alice, ADMIN_ROLE));
        pay.revokeRole(PAUSER, admin);
    }

    function test_PauserNonAdminCanPauseUnpauseButNotChangeFees() public {
        vm.prank(admin);
        pay.grantRole(PAUSER, alice);
        assertFalse(pay.hasRole(ADMIN_ROLE, alice));

        vm.startPrank(alice);
        pay.pause();
        assertTrue(pay.paused());
        pay.unpause();
        assertFalse(pay.paused());

        vm.expectRevert(_unauth(alice, ADMIN_ROLE));
        pay.setFeeBps(0);
        vm.expectRevert(_unauth(alice, ADMIN_ROLE));
        pay.setFeeRecipient(alice);
        vm.expectRevert(_unauth(alice, ADMIN_ROLE));
        pay.setTokenSupported(address(tokenB), true);
        vm.expectRevert(_unauth(alice, ADMIN_ROLE));
        pay.grantRole(PAUSER, bob);
        vm.stopPrank();
    }

    function test_AdminWithoutPauserRoleCannotPause() public {
        vm.startPrank(admin);
        pay.revokeRole(PAUSER, admin);
        vm.expectRevert(_unauth(admin, PAUSER));
        pay.pause();
        vm.stopPrank();
    }

    function test_PauserCanRenounceOwnPauserRole() public {
        vm.prank(admin);
        pay.grantRole(PAUSER, alice);
        vm.prank(alice);
        pay.renounceRole(PAUSER, alice);
        assertFalse(pay.hasRole(PAUSER, alice));
    }

    function test_PausedStateBlocksPaymentsButNotCancelOrAdminConfig() public {
        vm.prank(carol);
        uint256 rid = pay.createRequest(address(usdc), 1, 0, bytes32(0), "");
        vm.prank(pauser);
        pay.pause();
        // admin config still possible while paused
        _setFee(5);
        vm.prank(carol);
        pay.cancelRequest(rid);
        vm.prank(alice);
        vm.expectRevert(Pausable.EnforcedPause.selector);
        pay.pay(address(usdc), bob, 1, bytes32(0), "", 1);
    }

    // ------------------------------------------------------------ no extraction of held tokens (informational)
    /// Tokens sent directly to the contract are not part of any accounting and no function can move them out.
    function test_InformationalTokensSentDirectlyAreStuckForever() public {
        vm.prank(alice);
        usdc.transfer(address(pay), 100e6);
        assertEq(usdc.balanceOf(address(pay)), 100e6);

        bytes[] memory calls = new bytes[](14);
        calls[0] = abi.encodeCall(pay.setTokenSupported, (address(usdc), false));
        calls[1] = abi.encodeCall(pay.setTokenSupported, (address(usdc), true));
        calls[2] = abi.encodeCall(pay.setFeeRecipient, (admin));
        calls[3] = abi.encodeCall(pay.setFeeBps, (100));
        calls[4] = abi.encodeCall(pay.pay, (address(usdc), admin, 100e6, bytes32(0), "", 100e6));
        calls[5] = abi.encodeCall(pay.pay, (address(usdc), address(pay), 1, bytes32(0), "", 0));
        calls[6] = abi.encodeCall(pay.createRequest, (address(usdc), 100e6, 0, bytes32(0), ""));
        calls[7] = abi.encodeCall(pay.payRequest, (1, 100e6));
        calls[8] = abi.encodeCall(pay.cancelRequest, (1));
        calls[9] = abi.encodeCall(pay.pause, ());
        calls[10] = abi.encodeCall(pay.unpause, ());
        calls[11] = abi.encodeCall(pay.beginDefaultAdminTransfer, (admin));
        calls[12] = abi.encodeCall(pay.acceptDefaultAdminTransfer, ());
        calls[13] = abi.encodeCall(pay.grantRole, (PAUSER, admin));

        address[3] memory callers = [admin, pauser, carol];
        for (uint256 i; i < callers.length; ++i) {
            for (uint256 j; j < calls.length; ++j) {
                vm.prank(callers[i]);
                (bool done,) = address(pay).call(calls[j]); // success or revert both fine; only balances matter
                done;
            }
        }
        assertEq(usdc.balanceOf(address(pay)), 100e6, "tokens held by the contract must be unreachable");
        // The contract also rejects native currency (no receive/fallback).
        vm.deal(admin, 1 ether);
        vm.prank(admin);
        (bool ok,) = address(pay).call{value: 1 wei}("");
        assertFalse(ok);
    }

    /// Random calldata from privileged callers can never reduce the contract's token balance.
    function testFuzz_NoCalldataCanMoveHeldTokens(uint256 who, bytes4 sel, bytes calldata args) public {
        vm.prank(alice);
        usdc.transfer(address(pay), 50e6);
        address[3] memory callers = [admin, carol, alice];
        address caller = callers[who % 3];
        vm.prank(caller);
        (bool done,) = address(pay).call(abi.encodePacked(sel, args));
        done;
        assertEq(usdc.balanceOf(address(pay)), 50e6);
    }
}
