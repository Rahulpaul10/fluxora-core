// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Test} from "forge-std/Test.sol";
import {VmSafe} from "forge-std/Vm.sol";
import {DeployFluxora} from "../script/DeployFluxora.s.sol";
import {FluxoraToken} from "../src/FluxoraToken.sol";
import {FluxoraPayments} from "../src/FluxoraPayments.sol";
import {MockEtchableToken} from "./helpers/MockERC20.sol";

/// @dev Shared helpers for the DeployFluxora script tests.
///      IMPORTANT: forge runs test contracts AND test functions in parallel threads while
///      `vm.setEnv`/`vm.unsetEnv` mutate the process-wide environment. Every test that calls
///      `script.run()` (it reads env vars) therefore lives in ONE test function of ONE contract
///      (`DeployFluxoraTest`), which executes the `scenario_*` functions strictly one after another
///      and resets the environment around each one.
abstract contract DeployFluxoraBase is Test {
    address internal constant USDC = 0x3600000000000000000000000000000000000000;
    bytes32 internal constant ADMIN_ROLE = bytes32(0);
    bytes32 internal constant PAUSER_ROLE = keccak256("PAUSER_ROLE");

    DeployFluxora internal script;

    struct Deployed {
        FluxoraToken token;
        FluxoraPayments payments;
    }

    // ------------------------------------------------------------ environment hygiene
    function _envNames() internal pure returns (string[3] memory n) {
        n = ["FLUX_INITIAL_HOLDER", "PAYMENTS_ADMIN", "PAUSER"];
    }

    /// `vm.unsetEnv` is not available in this toolchain; an empty value is treated as "unset" by `vm.envOr`.
    function _unsetEnv(string memory name) internal {
        vm.setEnv(name, "");
    }

    function _resetEnv() internal {
        string[3] memory n = _envNames();
        for (uint256 i; i < n.length; ++i) _unsetEnv(n[i]);
    }

    function _setAddr(string memory name, address a) internal {
        vm.setEnv(name, vm.toString(a));
    }

    /// Clean slate for a scenario: default env, no mocks, supported chain, valid USDC at the canonical address.
    function _reset() internal {
        _resetEnv();
        vm.clearMockedCalls();
        vm.chainId(5042);
        _etchUsdc("USDC", 4, 6);
    }

    function _etchUsdc(string memory sym, uint8 len, uint8 dec) internal {
        MockEtchableToken m = new MockEtchableToken(bytes32(bytes(sym)), len, dec);
        vm.etch(USDC, address(m).code);
    }

    // ------------------------------------------------------------ run helpers
    function _stopBroadcastIfActive() internal {
        (bool ok,) = address(vm).call(abi.encodeWithSignature("stopBroadcast()"));
        ok; // no active broadcast is fine
    }

    /// The broadcaster the script will see (default sender in the test EVM).
    function _broadcaster() internal returns (address b) {
        vm.startBroadcast();
        (, b,) = vm.readCallers();
        vm.stopBroadcast();
    }

    function _deploy() internal returns (Deployed memory d, address broadcaster) {
        broadcaster = _broadcaster();
        vm.startStateDiffRecording();
        script.run();
        VmSafe.AccountAccess[] memory accesses = vm.stopAndReturnStateDiff();
        address[] memory created = new address[](2);
        uint256 n;
        for (uint256 i; i < accesses.length; ++i) {
            if (accesses[i].kind == VmSafe.AccountAccessKind.Create && n < 2) created[n++] = accesses[i].account;
        }
        assertEq(n, 2, "expected 2 contract creations");
        d.token = FluxoraToken(created[0]);
        d.payments = FluxoraPayments(created[1]);
    }

    /// Calls `script.run()`, requires it to revert with exactly `expected`, and returns how many
    /// contract creations were recorded (including inside the reverted frames).
    function _expectRunRevert(bytes memory expected) internal returns (uint256 creations) {
        vm.startStateDiffRecording();
        try script.run() {
            vm.stopAndReturnStateDiff();
            revert("script.run() did not revert");
        } catch (bytes memory err) {
            VmSafe.AccountAccess[] memory a = vm.stopAndReturnStateDiff();
            _stopBroadcastIfActive(); // a revert after startBroadcast() leaves the broadcast open
            assertEq(err, expected, "unexpected revert data");
            for (uint256 i; i < a.length; ++i) {
                if (a[i].kind == VmSafe.AccountAccessKind.Create) {
                    ++creations;
                }
            }
        }
    }

    /// `run()` must fail with `expected` BEFORE any contract is created.
    function _expectPreBroadcastRevert(bytes memory expected) internal {
        assertEq(_expectRunRevert(expected), 0, "a contract was created before the config check reverted");
    }
}
