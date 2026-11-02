// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @dev Standard 6-decimals token with an issuer-style blocklist (USDC-like).
contract SecToken is ERC20 {
    error Blocked(address account);

    mapping(address => bool) public blocked;

    constructor() ERC20("Sec Token", "SEC") {}

    function decimals() public pure override returns (uint8) {
        return 6;
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    function setBlocked(address account, bool isBlocked) external {
        blocked[account] = isBlocked;
    }

    function _update(address from, address to, uint256 value) internal override {
        if (blocked[from]) revert Blocked(from);
        if (blocked[to]) revert Blocked(to);
        super._update(from, to, value);
    }
}

/// @dev Deflationary token: burns 1% of every transfer (recipient receives less).
contract SecFeeOnTransferToken is ERC20 {
    constructor() ERC20("FoT", "FOT") {}

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    function _update(address from, address to, uint256 value) internal override {
        if (from == address(0) || to == address(0)) {
            super._update(from, to, value);
            return;
        }
        uint256 cut = value / 100;
        super._update(from, to, value - cut);
        if (cut != 0) super._update(from, address(0), cut);
    }
}

/// @dev Inflationary token: recipient receives `value + 1` on every transfer.
contract SecInflatingToken is ERC20 {
    constructor() ERC20("Inflating", "INF") {}

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    function _update(address from, address to, uint256 value) internal override {
        super._update(from, to, value);
        if (from != address(0) && to != address(0)) super._update(address(0), to, 1);
    }
}

/// @dev Rebasing-like token: balances are scaled by `index`, which grows 1% on each transferFrom.
contract SecRebasingToken is ERC20 {
    uint256 public index = 1e18;

    constructor() ERC20("Rebasing", "REB") {}

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    function balanceOf(address account) public view override returns (uint256) {
        return super.balanceOf(account) * index / 1e18;
    }

    function transferFrom(address from, address to, uint256 value) public override returns (bool ok) {
        ok = super.transferFrom(from, to, value);
        index = index * 101 / 100;
    }
}

/// @dev Malicious token: on the first transfer touching `target`, it re-enters `target` with
///      `data` (as msg.sender == this token) and records the outcome without reverting.
contract SecReentrantToken is ERC20 {
    address public target;
    bytes public data;
    bool public armed;
    bool public inHook;
    uint256 public attempts;
    bool public lastSuccess;
    bytes public lastRet;
    /// @dev Issuer-style blocklist, so a deferred payout credit can be created for this token.
    mapping(address => bool) public blocked;

    constructor() ERC20("Reentrant", "RE") {}

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    function setBlocked(address account, bool isBlocked) external {
        blocked[account] = isBlocked;
    }

    function arm(address target_, bytes calldata data_) external {
        target = target_;
        data = data_;
        armed = true;
    }

    function lastSelector() external view returns (bytes4) {
        return bytes4(lastRet);
    }

    function _update(address from, address to, uint256 value) internal override {
        if (armed && !inHook && from != address(0) && (from == target || to == target)) {
            armed = false;
            inHook = true;
            attempts++;
            (bool ok, bytes memory ret) = target.call(data);
            lastSuccess = ok;
            lastRet = ret;
            inHook = false;
        }
        if (blocked[from] || blocked[to]) revert("blocked");
        super._update(from, to, value);
    }
}
