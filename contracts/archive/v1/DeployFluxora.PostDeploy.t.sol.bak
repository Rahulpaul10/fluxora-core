// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {DeployFluxora} from "../script/DeployFluxora.s.sol";
import {FluxoraToken} from "../src/FluxoraToken.sol";
import {FluxoraPayments} from "../src/FluxoraPayments.sol";
import {DeployFluxoraBase} from "./DeployFluxora.Base.t.sol";

/// @dev Code that `vm.mockFunction` swaps in: denies every role.
contract Sabotage {
    function hasRole(bytes32, address) external pure returns (bool) {
        return false;
    }
}

/// @dev Post-deploy wiring assertion scenarios (run serially by DeployFluxoraTest).
///      The wiring is sabotaged on the deterministic address the script is about to create
///      (derived from the broadcaster's nonce), so the in-script `_assertDeployment` must trip.
abstract contract DeployFluxoraPostDeployScenarios is DeployFluxoraBase {
    Sabotage internal sabotage;

    /// Addresses the next `script.run()` will create: the broadcaster sends the token creation, then the payments creation.
    /// `vm.mockFunction` cannot be undone, so every sabotage scenario moves the broadcaster to its own nonce
    /// range (`salt` 1..) and therefore deploys at fresh addresses that no earlier mock can affect.
    function _predict(uint64 salt) internal returns (Deployed memory d) {
        sabotage = new Sabotage();
        address b = _broadcaster();
        if (salt != 0) vm.setNonce(b, salt * 1000);
        uint256 n = vm.getNonce(b);
        d.token = FluxoraToken(vm.computeCreateAddress(b, n));
        d.payments = FluxoraPayments(vm.computeCreateAddress(b, n + 1));
    }

    /// `vm.mockCall` would etch code at the not-yet-created address and make the script's CREATE collide,
    /// so reroute the call with `vm.mockFunction` instead (it does not touch the account).
    function _mockHasRole(address target, bytes32 role, address account) internal {
        vm.mockFunction(
            target, address(sabotage), abi.encodeWithSignature("hasRole(bytes32,address)", role, account)
        );
    }

    /// The assertion fires after both contracts were created (so the creations are recorded in the reverted frame).
    function _expectPostDeployRevert(bytes memory expected) internal {
        assertEq(_expectRunRevert(expected), 2, "assertion should trip after the 2 contracts were created");
    }

    function _missing(address target, bytes32 role, address account) internal pure returns (bytes memory) {
        return abi.encodeWithSelector(DeployFluxora.MissingDeploymentRole.selector, target, role, account);
    }

    function scenario_MissingPaymentsAdminRole() public {
        _reset();
        Deployed memory d = _predict(1);
        address b = _broadcaster();
        _mockHasRole(address(d.payments), ADMIN_ROLE, b);
        _expectPostDeployRevert(_missing(address(d.payments), ADMIN_ROLE, b));
    }

    function scenario_MissingPaymentsPauserRole() public {
        _reset();
        Deployed memory d = _predict(2);
        address b = _broadcaster();
        _mockHasRole(address(d.payments), PAUSER_ROLE, b);
        _expectPostDeployRevert(_missing(address(d.payments), PAUSER_ROLE, b));
    }

    function scenario_PredictedAddressesMatchRealDeployment() public {
        _reset();
        Deployed memory predicted = _predict(0);
        (Deployed memory real,) = _deploy();
        assertEq(address(real.token), address(predicted.token));
        assertEq(address(real.payments), address(predicted.payments));
    }
}
