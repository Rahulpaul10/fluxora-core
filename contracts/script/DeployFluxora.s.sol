// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Script} from "forge-std/Script.sol";
import {console} from "forge-std/console.sol";
import {FluxoraToken} from "../src/FluxoraToken.sol";
import {FluxoraPaymentsStandalone} from "../src/FluxoraPaymentsStandalone.sol";

/// @title FLUXORA deployment script for Arc mainnet and testnet
/// @notice Uses Foundry's command-line keystore/account or hardware-wallet signer; never reads a private key.
/// @dev Deploys the token and the payments contract. The broadcaster becomes the payments default admin and
///      pauser (the constructor uses its caller). To move admin power to a multisig, call
///      `beginDefaultAdminTransfer(multisig)` after deployment and `acceptDefaultAdminTransfer()` from the
///      multisig once the delay has passed. Env overrides: FLUX_INITIAL_HOLDER, PAYMENTS_ADMIN_TRANSFER_DELAY
///      (seconds, 1 to 30 days, default 2 days).
///      This script only describes deployment; writing it does not broadcast any transaction.
contract DeployFluxora is Script {
    address private constant ARC_USDC = 0x3600000000000000000000000000000000000000;

    struct Config {
        address broadcaster;
        address initialHolder;
        uint48 adminTransferDelay;
    }

    struct Deployment {
        FluxoraToken token;
        FluxoraPaymentsStandalone payments;
    }

    error UnsupportedChain(uint256 chainId);
    error InvalidConfiguration();
    error MissingDeploymentRole(address target, bytes32 role, address account);
    error UsdcHasNoCode(address token);
    error InvalidUsdcMetadata(address token, bytes4 selector, bytes returnedData);
    error UnexpectedUsdcSymbol(address token, string symbol, string expected);
    error UnexpectedUsdcDecimals(address token, uint256 decimals, uint256 expected);

    /// @notice Deploy the suite using the configured Foundry broadcaster and optional environment overrides.
    function run() external {
        if (block.chainid != 5042 && block.chainid != 5042002) revert UnsupportedChain(block.chainid);
        vm.startBroadcast();
        (, address broadcaster,) = vm.readCallers();
        vm.stopBroadcast();
        Config memory config = _configuration(broadcaster);
        vm.startBroadcast();
        Deployment memory deployed;
        deployed.token = new FluxoraToken(config.initialHolder);
        address[] memory tokens = new address[](2);
        tokens[0] = ARC_USDC;
        tokens[1] = address(deployed.token);
        deployed.payments = new FluxoraPaymentsStandalone(config.adminTransferDelay, tokens);
        _assertDeployment(deployed, config);
        vm.stopBroadcast();
        _log(config, deployed);
    }

    function _configuration(address broadcaster) private view returns (Config memory config) {
        config.broadcaster = broadcaster;
        config.initialHolder = vm.envOr("FLUX_INITIAL_HOLDER", broadcaster);
        uint256 delay = vm.envOr("PAYMENTS_ADMIN_TRANSFER_DELAY", uint256(2 days));
        // Same bounds as the contract constructor, checked here so a bad value fails before anything is created.
        if (broadcaster == address(0) || config.initialHolder == address(0) || delay < 1 days || delay > 30 days) {
            revert InvalidConfiguration();
        }
        config.adminTransferDelay = uint48(delay);
        _checkUsdc();
    }

    function _checkUsdc() private view {
        if (ARC_USDC.code.length == 0) revert UsdcHasNoCode(ARC_USDC);
        bytes4 symbolSelector = bytes4(keccak256("symbol()"));
        (bool symbolSuccess, bytes memory symbolData) = ARC_USDC.staticcall(abi.encodeWithSelector(symbolSelector));
        if (!symbolSuccess) revert InvalidUsdcMetadata(ARC_USDC, symbolSelector, symbolData);
        (bool symbolDecoded, string memory symbol) = _decodeSymbol(symbolData);
        // The re-encoding comparison rejects non-canonical encodings (for example dirty padding bytes).
        if (!symbolDecoded || keccak256(symbolData) != keccak256(abi.encode(symbol))) {
            revert InvalidUsdcMetadata(ARC_USDC, symbolSelector, symbolData);
        }
        if (keccak256(bytes(symbol)) != keccak256(bytes("USDC"))) {
            revert UnexpectedUsdcSymbol(ARC_USDC, symbol, "USDC");
        }
        bytes4 decimalsSelector = bytes4(keccak256("decimals()"));
        (bool decimalsSuccess, bytes memory decimalsData) = ARC_USDC.staticcall(abi.encodeWithSelector(decimalsSelector));
        if (!decimalsSuccess || decimalsData.length != 32) {
            revert InvalidUsdcMetadata(ARC_USDC, decimalsSelector, decimalsData);
        }
        uint256 decimals = abi.decode(decimalsData, (uint256));
        if (decimals != 6) revert UnexpectedUsdcDecimals(ARC_USDC, decimals, 6);
    }

    /// @dev Bounds-checks ABI `string` return data before decoding, so malformed data yields a custom error.
    ///      Implemented without an external self-call because Foundry scripts must not use `address(this)`.
    function _decodeSymbol(bytes memory data) private pure returns (bool ok, string memory symbol) {
        if (data.length < 64) return (false, "");
        uint256 offset;
        uint256 length;
        assembly ("memory-safe") {
            offset := mload(add(data, 32))
            length := mload(add(data, 64))
        }
        if (offset != 32 || length > 1024 || data.length != 64 + ((length + 31) / 32) * 32) return (false, "");
        return (true, abi.decode(data, (string)));
    }

    function _assertDeployment(Deployment memory deployed, Config memory config) private view {
        bytes32 adminRole = deployed.payments.DEFAULT_ADMIN_ROLE();
        if (!deployed.payments.hasRole(adminRole, config.broadcaster)) {
            revert MissingDeploymentRole(address(deployed.payments), adminRole, config.broadcaster);
        }
        bytes32 pauserRole = deployed.payments.PAUSER_ROLE();
        if (!deployed.payments.hasRole(pauserRole, config.broadcaster)) {
            revert MissingDeploymentRole(address(deployed.payments), pauserRole, config.broadcaster);
        }
    }

    function _log(Config memory config, Deployment memory deployed) private pure {
        console.log("FluxoraToken", address(deployed.token));
        console.log("FluxoraPaymentsStandalone", address(deployed.payments));
        console.log("FLUX initial holder (no admin role)", config.initialHolder);
        console.log("Payments default admin and pauser (deployer)", config.broadcaster);
        console.log("Payments admin transfer delay (seconds)", uint256(config.adminTransferDelay));
        console.log("Payments supported USDC", ARC_USDC);
        console.log("Payments supported FLUX", address(deployed.token));
    }
}
