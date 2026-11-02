// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {DeployFluxora} from "../script/DeployFluxora.s.sol";
import {DeployFluxoraBase} from "./DeployFluxora.Base.t.sol";

/// @dev Pre-broadcast configuration validation scenarios (run serially by DeployFluxoraTest).
///      Every invalid value must revert before ANY contract is created.
abstract contract DeployFluxoraConfigScenarios is DeployFluxoraBase {
    function scenario_ZeroInitialHolderIsInvalid() public {
        _reset();
        _setAddr("FLUX_INITIAL_HOLDER", address(0));
        _expectPreBroadcastRevert(abi.encodeWithSelector(DeployFluxora.InvalidConfiguration.selector));
    }

    function scenario_AdminTransferDelayOutOfRangeIsInvalid() public {
        _reset();
        bytes memory err = abi.encodeWithSelector(DeployFluxora.InvalidConfiguration.selector);
        uint256[4] memory bad = [uint256(0), 1 days - 1, 30 days + 1, uint256(type(uint48).max) + 1];
        for (uint256 i; i < bad.length; ++i) {
            _setUint("PAYMENTS_ADMIN_TRANSFER_DELAY", bad[i]);
            _expectPreBroadcastRevert(err);
        }
    }

    function scenario_ConfigErrorsArePrioritisedOverUsdcChecks() public {
        _reset();
        vm.etch(USDC, "");
        _setAddr("FLUX_INITIAL_HOLDER", address(0));
        _expectPreBroadcastRevert(abi.encodeWithSelector(DeployFluxora.InvalidConfiguration.selector));
        _unsetEnv("FLUX_INITIAL_HOLDER");
        _expectPreBroadcastRevert(abi.encodeWithSelector(DeployFluxora.UsdcHasNoCode.selector, USDC));
    }
}
