// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {console2} from "forge-std/Test.sol";
import {DeployFluxora} from "../script/DeployFluxora.s.sol";
import {DeployFluxoraBase} from "./DeployFluxora.Base.t.sol";
import {DeployFluxoraWiringScenarios} from "./DeployFluxora.Wiring.t.sol";
import {DeployFluxoraConfigScenarios} from "./DeployFluxora.Config.t.sol";
import {DeployFluxoraPostDeployScenarios} from "./DeployFluxora.PostDeploy.t.sol";

/// @dev The ONLY test contract that executes `DeployFluxora.run()`.
///      The script reads process-global environment variables, and forge runs test functions on parallel
///      threads, so the environment-mutating scenarios must never run concurrently with anything else that
///      calls the script. `test_AllDeployScenariosSerially` therefore runs every `scenario_*` one after
///      another, each inside a snapshot, and resets/unsets all env vars before and after each one.
contract DeployFluxoraTest is
    DeployFluxoraWiringScenarios,
    DeployFluxoraConfigScenarios,
    DeployFluxoraPostDeployScenarios
{
    function setUp() public {
        _resetEnv();
        vm.clearMockedCalls();
        script = new DeployFluxora();
    }

    function _run(string memory failed, string memory name, bytes4 sel) internal returns (string memory) {
        uint256 snap = vm.snapshotState();
        (bool ok, bytes memory ret) = address(this).call(abi.encodeWithSelector(sel));
        vm.revertToState(snap);
        _stopBroadcastIfActive();
        _resetEnv();
        vm.clearMockedCalls();
        if (ok) {
            console2.log("PASS", name);
            return failed;
        }
        console2.log("FAIL", name);
        console2.logBytes(ret);
        return string.concat(failed, " ", name);
    }

    function test_AllDeployScenariosSerially() public {
        string memory f;
        // wiring + chain guard
        f = _run(f, "DeploysAndWiresEverything", this.scenario_DeploysAndWiresEverything.selector);
        f = _run(f, "SucceedsOnTestnetChainId", this.scenario_SucceedsOnTestnetChainId.selector);
        f = _run(f, "EnvOverridesAreApplied", this.scenario_EnvOverridesAreApplied.selector);
        f = _run(f, "RevertsOnWrongChainId", this.scenario_RevertsOnWrongChainId.selector);
        // USDC sanity checks
        f = _run(f, "UsdcWrongSymbol", this.scenario_UsdcWrongSymbol.selector);
        f = _run(f, "UsdcWrongSymbolCase", this.scenario_UsdcWrongSymbolCase.selector);
        f = _run(f, "UsdcWrongDecimals", this.scenario_UsdcWrongDecimals.selector);
        f = _run(f, "UsdcDecimalsAboveUint8IsNotTruncated", this.scenario_UsdcDecimalsAboveUint8IsNotTruncated.selector);
        f = _run(f, "UsdcHasNoCode", this.scenario_UsdcHasNoCode.selector);
        f = _run(f, "UsdcSymbolReturnsNothing", this.scenario_UsdcSymbolReturnsNothing.selector);
        f = _run(f, "UsdcSymbolCallReverts", this.scenario_UsdcSymbolCallReverts.selector);
        f = _run(f, "UsdcSymbolNonCanonicalEncoding", this.scenario_UsdcSymbolNonCanonicalEncoding.selector);
        f = _run(f, "UsdcDecimalsMalformed", this.scenario_UsdcDecimalsMalformed.selector);
        f = _run(f, "UsdcDecimalsCallReverts", this.scenario_UsdcDecimalsCallReverts.selector);
        // pre-broadcast config validation
        f = _run(f, "ZeroAddressRolesAreInvalid", this.scenario_ZeroAddressRolesAreInvalid.selector);
        f = _run(f, "ConfigErrorsArePrioritisedOverUsdcChecks", this.scenario_ConfigErrorsArePrioritisedOverUsdcChecks.selector);
        // post-deploy wiring assertions
        f = _run(f, "MissingPaymentsAdminRole", this.scenario_MissingPaymentsAdminRole.selector);
        f = _run(f, "MissingPaymentsPauserRole", this.scenario_MissingPaymentsPauserRole.selector);
        f = _run(f, "PredictedAddressesMatchRealDeployment", this.scenario_PredictedAddressesMatchRealDeployment.selector);
        assertEq(f, "", "failed scenarios");
    }
}
