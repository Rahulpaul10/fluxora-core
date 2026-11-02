// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Script} from "forge-std/Script.sol";
import {console} from "forge-std/console.sol";
import {FluxoraToken} from "../src/FluxoraToken.sol";
import {FluxoraPayments} from "../src/FluxoraPayments.sol";

/// @title FLUXORA deployment script for Arc mainnet and testnet
/// @notice Uses Foundry's command-line keystore/account or hardware-wallet signer; never reads a private key.
/// @dev Deploys the token and the payments contract. The payments admin defaults to the broadcaster; set
///      PAYMENTS_ADMIN to a multisig to hand admin power to it from the first block.
///      This script only describes deployment; writing it does not broadcast any transaction.
contract DeployFluxora is Script {
    address private constant ARC_USDC = 0x3600000000000000000000000000000000000000;

    struct Config {
        address broadcaster;
        address initialHolder;
        address paymentsAdmin;
        address pauser;
    }

    struct Deployment {
        FluxoraToken token;
        FluxoraPayments payments;
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
        deployed.payments = new FluxoraPayments(config.paymentsAdmin, config.pauser, tokens);
        _assertDeployment(deployed, config);
        vm.stopBroadcast();
        _log(config, deployed);
    }

    function _configuration(address broadcaster) private view returns (Config memory config) {
        config.broadcaster = broadcaster;
        config.initialHolder = vm.envOr("FLUX_INITIAL_HOLDER", broadcaster);
        config.paymentsAdmin = vm.envOr("PAYMENTS_ADMIN", broadcaster);
        config.pauser = vm.envOr("PAUSER", broadcaster);
        if (broadcaster == address(0) || config.initialHolder == address(0)
            || config.paymentsAdmin == address(0) || config.pauser == address(0)) {
            revert InvalidConfiguration();
        }
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
        if (!deployed.payments.hasRole(adminRole, config.paymentsAdmin)) {
            revert MissingDeploymentRole(address(deployed.payments), adminRole, config.paymentsAdmin);
        }
        bytes32 pauserRole = deployed.payments.PAUSER_ROLE();
        if (!deployed.payments.hasRole(pauserRole, config.pauser)) {
            revert MissingDeploymentRole(address(deployed.payments), pauserRole, config.pauser);
        }
    }

    function _log(Config memory config, Deployment memory deployed) private pure {
        console.log("FluxoraToken", address(deployed.token));
        console.log("FluxoraPayments", address(deployed.payments));
        console.log("FLUX initial holder (no admin role)", config.initialHolder);
        console.log("Payments DEFAULT_ADMIN_ROLE", config.paymentsAdmin);
        console.log("Payments PAUSER_ROLE", config.pauser);
        console.log("Payments supported USDC", ARC_USDC);
        console.log("Payments supported FLUX", address(deployed.token));
    }
}
