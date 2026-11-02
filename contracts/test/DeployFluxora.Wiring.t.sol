// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {DeployFluxora} from "../script/DeployFluxora.s.sol";
import {DeployFluxoraBase} from "./DeployFluxora.Base.t.sol";

/// @dev Happy-path wiring, chain guard and USDC sanity-check scenarios (run serially by DeployFluxoraTest).
abstract contract DeployFluxoraWiringScenarios is DeployFluxoraBase {
    // ------------------------------------------------------------ happy path wiring
    function scenario_DeploysAndWiresEverything() public {
        _reset();
        (Deployed memory d, address b) = _deploy();
        assertNotEq(b, address(0));

        assertEq(d.token.totalSupply(), 1_000_000_000e18);
        assertEq(d.token.balanceOf(b), 1_000_000_000e18); // default initial holder = broadcaster

        // default admin and pauser = broadcaster
        assertTrue(d.payments.hasRole(d.payments.DEFAULT_ADMIN_ROLE(), b));
        assertTrue(d.payments.hasRole(PAUSER_ROLE, b));
        assertEq(d.payments.defaultAdmin(), b);
        assertEq(d.payments.defaultAdminDelay(), 2 days);
        assertFalse(d.payments.hasRole(d.payments.DEFAULT_ADMIN_ROLE(), address(script)));
        assertTrue(d.payments.supportedTokens(USDC));
        assertTrue(d.payments.supportedTokens(address(d.token)));
        assertEq(d.payments.feeBps(), 0);

        // admin functions are gated
        vm.prank(makeAddr("stranger"));
        vm.expectRevert();
        d.payments.setFeeRecipient(address(0xFEE));
        vm.prank(b);
        d.payments.setFeeRecipient(address(0xFEE));
        assertEq(d.payments.feeRecipient(), address(0xFEE));
    }

    function scenario_SucceedsOnTestnetChainId() public {
        _reset();
        vm.chainId(5042002);
        (Deployed memory d,) = _deploy();
        assertEq(d.token.totalSupply(), 1_000_000_000e18);
    }

    function scenario_EnvOverridesAreApplied() public {
        _reset();
        address holder = makeAddr("holder");
        _setAddr("FLUX_INITIAL_HOLDER", holder);
        _setUint("PAYMENTS_ADMIN_TRANSFER_DELAY", 7 days);
        (Deployed memory d, address b) = _deploy();
        assertEq(d.token.balanceOf(holder), 1_000_000_000e18);
        assertEq(d.token.balanceOf(b), 0);
        assertEq(d.payments.defaultAdminDelay(), 7 days);
        assertTrue(d.payments.hasRole(d.payments.DEFAULT_ADMIN_ROLE(), b)); // the holder gets tokens, not admin power
        assertFalse(d.payments.hasRole(d.payments.DEFAULT_ADMIN_ROLE(), holder));
        assertTrue(d.payments.supportedTokens(USDC));
    }

    function scenario_AdminTransferDelayBoundariesAreAccepted() public {
        _reset();
        _setUint("PAYMENTS_ADMIN_TRANSFER_DELAY", 1 days);
        (Deployed memory lo,) = _deploy();
        assertEq(lo.payments.defaultAdminDelay(), 1 days);
        _setUint("PAYMENTS_ADMIN_TRANSFER_DELAY", 30 days);
        (Deployed memory hi,) = _deploy();
        assertEq(hi.payments.defaultAdminDelay(), 30 days);
    }

    // ------------------------------------------------------------ chain guard
    function scenario_RevertsOnWrongChainId() public {
        _reset();
        vm.chainId(1);
        vm.expectRevert(abi.encodeWithSelector(DeployFluxora.UnsupportedChain.selector, 1));
        script.run();
        vm.chainId(5043);
        vm.expectRevert(abi.encodeWithSelector(DeployFluxora.UnsupportedChain.selector, 5043));
        script.run();
    }

    // ------------------------------------------------------------ USDC sanity checks (custom errors)
    bytes4 internal constant SYMBOL_SEL = bytes4(keccak256("symbol()"));
    bytes4 internal constant DECIMALS_SEL = bytes4(keccak256("decimals()"));

    function scenario_UsdcWrongSymbol() public {
        _reset();
        _etchUsdc("USDT", 4, 6);
        _expectPreBroadcastRevert(abi.encodeWithSelector(DeployFluxora.UnexpectedUsdcSymbol.selector, USDC, "USDT", "USDC"));
    }

    function scenario_UsdcWrongSymbolCase() public {
        _reset();
        _etchUsdc("usdc", 4, 6);
        _expectPreBroadcastRevert(abi.encodeWithSelector(DeployFluxora.UnexpectedUsdcSymbol.selector, USDC, "usdc", "USDC"));
    }

    function scenario_UsdcWrongDecimals() public {
        _reset();
        _etchUsdc("USDC", 4, 18);
        _expectPreBroadcastRevert(abi.encodeWithSelector(DeployFluxora.UnexpectedUsdcDecimals.selector, USDC, 18, 6));
    }

    function scenario_UsdcDecimalsAboveUint8IsNotTruncated() public {
        _reset();
        vm.mockCall(USDC, abi.encodeWithSelector(DECIMALS_SEL), abi.encode(uint256(256 + 6)));
        _expectPreBroadcastRevert(abi.encodeWithSelector(DeployFluxora.UnexpectedUsdcDecimals.selector, USDC, 262, 6));
    }

    function scenario_UsdcHasNoCode() public {
        _reset();
        vm.etch(USDC, "");
        _expectPreBroadcastRevert(abi.encodeWithSelector(DeployFluxora.UsdcHasNoCode.selector, USDC));
    }

    function scenario_UsdcSymbolReturnsNothing() public {
        _reset();
        vm.etch(USDC, hex"00"); // STOP: staticcall succeeds with empty returndata
        _expectPreBroadcastRevert(
            abi.encodeWithSelector(DeployFluxora.InvalidUsdcMetadata.selector, USDC, SYMBOL_SEL, bytes(""))
        );
    }

    function scenario_UsdcSymbolCallReverts() public {
        _reset();
        vm.etch(USDC, hex"5f5ffd"); // PUSH0 PUSH0 REVERT
        _expectPreBroadcastRevert(
            abi.encodeWithSelector(DeployFluxora.InvalidUsdcMetadata.selector, USDC, SYMBOL_SEL, bytes(""))
        );
    }

    function scenario_UsdcSymbolNonCanonicalEncoding() public {
        _reset();
        bytes memory raw = bytes.concat(abi.encode("USDC"), bytes32(0)); // decodes, but has trailing bytes
        vm.mockCall(USDC, abi.encodeWithSelector(SYMBOL_SEL), raw);
        _expectPreBroadcastRevert(
            abi.encodeWithSelector(DeployFluxora.InvalidUsdcMetadata.selector, USDC, SYMBOL_SEL, raw)
        );
    }

    function scenario_UsdcDecimalsMalformed() public {
        _reset();
        bytes memory shortData = hex"06"; // not 32 bytes
        vm.mockCall(USDC, abi.encodeWithSelector(DECIMALS_SEL), shortData);
        _expectPreBroadcastRevert(
            abi.encodeWithSelector(DeployFluxora.InvalidUsdcMetadata.selector, USDC, DECIMALS_SEL, shortData)
        );
        vm.clearMockedCalls();
        bytes memory longData = abi.encode(uint256(6), uint256(6)); // 64 bytes
        vm.mockCall(USDC, abi.encodeWithSelector(DECIMALS_SEL), longData);
        _expectPreBroadcastRevert(
            abi.encodeWithSelector(DeployFluxora.InvalidUsdcMetadata.selector, USDC, DECIMALS_SEL, longData)
        );
    }

    function scenario_UsdcDecimalsCallReverts() public {
        _reset();
        vm.mockCallRevert(USDC, abi.encodeWithSelector(DECIMALS_SEL), bytes("nope"));
        _expectPreBroadcastRevert(
            abi.encodeWithSelector(DeployFluxora.InvalidUsdcMetadata.selector, USDC, DECIMALS_SEL, bytes("nope"))
        );
    }
}
