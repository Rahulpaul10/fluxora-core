// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {DeployFluxora} from "../script/DeployFluxora.s.sol";
import {DeployFluxoraBase} from "./DeployFluxora.Base.t.sol";

/// @dev Pre-broadcast configuration validation scenarios (run serially by DeployFluxoraTest).
///      Every invalid value must revert before ANY contract is created.
abstract contract DeployFluxoraConfigScenarios is DeployFluxoraBase {
    function scenario_ZeroAddressRolesAreInvalid() public {
        _reset();
        bytes memory err = abi.encodeWithSelector(DeployFluxora.InvalidConfiguration.selector);
        string[3] memory names = ["FLUX_INITIAL_HOLDER", "PAYMENTS_ADMIN", "PAUSER"];
        for (uint256 i; i < 3; ++i) {
            _setAddr(names[i], address(0));
            _expectPreBroadcastRevert(err);
            _unsetEnv(names[i]);
        }
    }

    function scenario_ConfigErrorsArePrioritisedOverUsdcChecks() public {
        _reset();
        vm.etch(USDC, "");
        _setAddr("PAUSER", address(0));
        _expectPreBroadcastRevert(abi.encodeWithSelector(DeployFluxora.InvalidConfiguration.selector));
        _unsetEnv("PAUSER");
        _expectPreBroadcastRevert(abi.encodeWithSelector(DeployFluxora.UsdcHasNoCode.selector, USDC));
    }
}
