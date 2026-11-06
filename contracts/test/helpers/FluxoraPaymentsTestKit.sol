// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {FluxoraPayments} from "../../FluxoraPayments.sol";
import {MockERC20} from "./MockERC20.sol";

/// @dev USDC-like token whose transfers revert when sender or receiver is blocklisted.
contract FPBlocklistToken is ERC20 {
    mapping(address => bool) public blocked;

    error Blocked(address account);

    constructor() ERC20("Blocklist USD", "bUSD") {}

    function decimals() public pure override returns (uint8) {
        return 6;
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    function setBlocked(address account, bool value) external {
        blocked[account] = value;
    }

    function _update(address from, address to, uint256 value) internal override {
        if (blocked[from]) revert Blocked(from);
        if (blocked[to]) revert Blocked(to);
        super._update(from, to, value);
    }
}

/// @dev Fee-on-transfer token: 1% of every transfer is burned.
contract FPFeeToken is ERC20 {
    constructor() ERC20("Fee USD", "fUSD") {}

    function decimals() public pure override returns (uint8) {
        return 6;
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    function _update(address from, address to, uint256 value) internal override {
        if (from != address(0) && to != address(0)) {
            uint256 fee = value / 100;
            super._update(from, to, value - fee);
            super._update(from, address(0), fee);
        } else {
            super._update(from, to, value);
        }
    }
}

/// @dev Malicious token: on the next transferFrom it first calls back into `target` with
///      `payload` (msg.sender == this token), records the outcome, then transfers normally.
contract FPReentrantToken is ERC20 {
    address public target;
    bytes public payload;
    bool public armed;
    bool public lastOk;
    bytes public lastRet;
    uint256 public attempts;

    constructor() ERC20("Evil USD", "eUSD") {}

    function decimals() public pure override returns (uint8) {
        return 6;
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    function arm(address target_, bytes calldata payload_) external {
        target = target_;
        payload = payload_;
        armed = true;
    }

    function transferFrom(address from, address to, uint256 value) public override returns (bool) {
        if (armed) {
            armed = false;
            attempts++;
            (lastOk, lastRet) = target.call(payload);
        }
        return super.transferFrom(from, to, value);
    }
}

/// @dev Invariant handler: bounded random actions against a USDC-backed FluxoraPayments.
contract FPHandler is Test {
    FluxoraPayments public c;
    MockERC20 public usdc;
    address[3] public actors;

    uint256 public ghostMoved;
    uint256 public ghostPayments;
    uint256 public ghostRequests;
    uint256 public ghostMinted;

    constructor(FluxoraPayments c_, MockERC20 usdc_, address[3] memory actors_) {
        c = c_;
        usdc = usdc_;
        actors = actors_;
    }

    function _actor(uint256 seed) internal view returns (address) {
        return actors[seed % 3];
    }

    function _fund(address who, uint256 amount) internal {
        usdc.mint(who, amount);
        ghostMinted += amount;
        vm.prank(who);
        usdc.approve(address(c), type(uint256).max);
    }

    function pay(uint256 fromSeed, uint256 toSeed, uint256 amount, uint256 memoLen) external {
        address from = _actor(fromSeed);
        address to = _actor(toSeed);
        amount = bound(amount, 0, 1e9);
        memoLen = bound(memoLen, 0, 160);
        _fund(from, amount);
        vm.prank(from);
        try c.pay(to, amount, bytes32(0), string(new bytes(memoLen))) {
            ghostMoved += amount;
            ghostPayments++;
        } catch {}
    }

    function createRequest(uint256 fromSeed, uint256 amount, uint256 expiryDelta) external {
        address from = _actor(fromSeed);
        amount = bound(amount, 0, 1e9);
        expiryDelta = bound(expiryDelta, 0, 10_000);
        uint64 expiry = expiryDelta == 0 ? 0 : uint64(block.timestamp + expiryDelta);
        vm.prank(from);
        try c.createRequest(amount, expiry, bytes32(0), "") {
            ghostRequests++;
        } catch {}
    }

    function payRequest(uint256 payerSeed, uint256 idSeed) external {
        address payer = _actor(payerSeed);
        uint256 id = bound(idSeed, 1, c.nextRequestId());
        if (c.requestStatus(id) != FluxoraPayments.RequestStatus.Open) return;
        (FluxoraPayments.Request memory r,) = c.getRequest(id);
        _fund(payer, r.amount);
        vm.prank(payer);
        try c.payRequest(id) {
            ghostMoved += r.amount;
            ghostPayments++;
        } catch {}
    }

    function cancelRequest(uint256 callerSeed, uint256 idSeed) external {
        uint256 id = bound(idSeed, 1, c.nextRequestId());
        vm.prank(_actor(callerSeed));
        try c.cancelRequest(id) {} catch {}
    }

    function warp(uint256 secs) external {
        skip(bound(secs, 0, 5_000));
    }

    function actorBalanceSum() external view returns (uint256 sum) {
        for (uint256 i; i < 3; ++i) {
            sum += usdc.balanceOf(actors[i]);
        }
    }
}
