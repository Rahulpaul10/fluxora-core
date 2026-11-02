// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {SafeCast} from "@openzeppelin/contracts/utils/math/SafeCast.sol";

/// @title FLUXORA noncustodial payments and payment requests
/// @notice Transfers allowlisted ERC-20s directly from payer to payee and fee recipient.
/// @dev The allowlist must contain only standard, non-rebasing, non-fee-on-transfer tokens.
///      SafeERC20 success is trusted; recipient balance deltas are deliberately not checked.
///      No native payments or token-recovery/arbitrary-transfer endpoint is provided.
/// @custom:upgrade-strategy Direct, non-upgradeable deployment (no proxy).
/// @dev Code changes require a replacement deployment and migration.
contract FluxoraPayments is AccessControl, Pausable, ReentrancyGuard {
    using SafeERC20 for IERC20;

    bytes32 public constant PAUSER_ROLE = keccak256("PAUSER_ROLE");
    uint256 public constant MAX_FEE_BPS = 100;
    uint256 public constant MAX_MEMO_BYTES = 140;
    uint256 public feeBps;
    address public feeRecipient;
    uint256 public nextPaymentId = 1;
    uint256 public nextRequestId = 1;
    mapping(address => bool) public supportedTokens;

    enum RequestStatus { None, Open, Paid, Cancelled }

    struct Receipt {
        address payer;
        address recipient;
        address token;
        uint256 amount;
        uint256 fee;
        uint64 timestamp;
        uint256 requestId;
        bytes32 ref;
    }

    struct Request {
        address creator;
        address token;
        uint256 amount;
        uint64 expiry;
        RequestStatus status;
        bytes32 ref;
        address paidBy;
        uint256 paymentId;
    }

    mapping(uint256 => Receipt) private _receipts;
    mapping(uint256 => Request) private _requests;
    mapping(uint256 => string) private _requestMemos;
    mapping(address => uint256[]) private _sentIds;
    mapping(address => uint256[]) private _receivedIds;
    mapping(address => uint256[]) private _requestIds;

    error ZeroAddress();
    error InvalidToken(address token);
    error UnsupportedToken(address token);
    error InvalidRecipient(address recipient);
    error ZeroAmount();
    error MemoTooLong(uint256 length, uint256 maximum);
    error FeeTooHigh(uint256 fee, uint256 maxFee);
    error InvalidFeeBps(uint256 bps);
    error InvalidFeeRecipient(address recipient);
    error InvalidExpiry(uint64 expiry, uint256 currentTime);
    error UnknownPayment(uint256 id);
    error UnknownRequest(uint256 id);
    error RequestNotOpen(uint256 id);
    error RequestExpired(uint256 id);
    error NotRequestCreator(address caller, address creator);

    event PaymentMade(uint256 indexed paymentId, address indexed payer, address indexed recipient,
        address token, uint256 amount, uint256 fee, uint256 requestId, bytes32 ref, string memo);
    event RequestCreated(uint256 indexed requestId, address indexed creator, address token,
        uint256 amount, uint64 expiry, bytes32 ref, string memo);
    event RequestCancelled(uint256 indexed requestId, address indexed creator);
    event TokenSupportUpdated(address indexed token, bool supported);
    event FeeUpdated(uint256 feeBps, address indexed feeRecipient);

    constructor(address admin, address pauser, address[] memory initialTokens) {
        if (admin == address(0) || pauser == address(0)) revert ZeroAddress();
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(PAUSER_ROLE, pauser);
        for (uint256 i; i < initialTokens.length; ++i) {
            _setTokenSupported(initialTokens[i], true);
        }
    }

    function pause() external onlyRole(PAUSER_ROLE) { _pause(); }
    function unpause() external onlyRole(PAUSER_ROLE) { _unpause(); }

    /// @notice The admin is responsible for vetting exact-transfer token semantics.
    function setTokenSupported(address token, bool supported) external onlyRole(DEFAULT_ADMIN_ROLE) {
        _setTokenSupported(token, supported);
    }

    function setFeeBps(uint256 bps) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (bps > MAX_FEE_BPS) revert InvalidFeeBps(bps);
        if (bps != 0 && feeRecipient == address(0)) revert InvalidFeeRecipient(feeRecipient);
        feeBps = bps;
        emit FeeUpdated(bps, feeRecipient);
    }

    function setFeeRecipient(address recipient) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (recipient == address(this) || (recipient == address(0) && feeBps != 0)) {
            revert InvalidFeeRecipient(recipient);
        }
        feeRecipient = recipient;
        emit FeeUpdated(feeBps, recipient);
    }

    /// @notice Fee charged in addition to the requested amount, rounded up.
    function quoteFee(uint256 amount) public view returns (uint256) {
        return Math.mulDiv(amount, feeBps, 10_000, Math.Rounding.Ceil);
    }

    /// @notice Pay exactly `amount` to the payee, plus a separately transferred fee.
    function pay(address token, address recipient, uint256 amount, bytes32 ref,
        string calldata memo, uint256 maxFee)
        external nonReentrant whenNotPaused returns (uint256 paymentId)
    {
        _validatePayment(token, recipient, amount, memo);
        uint256 fee = _checkedFee(amount, maxFee);
        address collector = feeRecipient;
        paymentId = _recordPayment(token, recipient, amount, fee, 0, ref);
        _transferPayment(paymentId, collector, memo);
    }

    /// @notice Create a request payable once; zero expiry means no deadline.
    function createRequest(address token, uint256 amount, uint64 expiry, bytes32 ref, string calldata memo)
        external nonReentrant whenNotPaused returns (uint256 requestId)
    {
        _validatePayment(token, msg.sender, amount, memo, false);
        if (expiry != 0 && expiry <= block.timestamp) revert InvalidExpiry(expiry, block.timestamp);
        requestId = nextRequestId++;
        _requests[requestId] = Request(msg.sender, token, amount, expiry, RequestStatus.Open, ref, address(0), 0);
        _requestMemos[requestId] = memo;
        _requestIds[msg.sender].push(requestId);
        emit RequestCreated(requestId, msg.sender, token, amount, expiry, ref, memo);
    }

    function payRequest(uint256 requestId, uint256 maxFee)
        external nonReentrant whenNotPaused returns (uint256 paymentId)
    {
        Request storage request = _openRequest(requestId);
        if (request.expiry != 0 && block.timestamp >= request.expiry) revert RequestExpired(requestId);
        string memory memo = _requestMemos[requestId];
        _validatePayment(request.token, request.creator, request.amount, memo);
        uint256 fee = _checkedFee(request.amount, maxFee);
        address collector = feeRecipient;
        paymentId = _recordPayment(request.token, request.creator, request.amount, fee, requestId, request.ref);
        request.status = RequestStatus.Paid;
        request.paidBy = msg.sender;
        request.paymentId = paymentId;
        delete _requestMemos[requestId];
        _transferPayment(paymentId, collector, memo);
    }

    /// @notice Creators can cancel an open request even while payments are paused.
    function cancelRequest(uint256 requestId) external nonReentrant {
        Request storage request = _openRequest(requestId);
        if (request.creator != msg.sender) revert NotRequestCreator(msg.sender, request.creator);
        request.status = RequestStatus.Cancelled;
        delete _requestMemos[requestId];
        emit RequestCancelled(requestId, msg.sender);
    }

    function sentCount(address user) external view returns (uint256) { return _sentIds[user].length; }
    function receivedCount(address user) external view returns (uint256) { return _receivedIds[user].length; }
    function requestCount(address user) external view returns (uint256) { return _requestIds[user].length; }

    /// @notice Pages clamp to available entries; offsets at or past the end return an empty array.
    function getSentIds(address user, uint256 offset, uint256 limit) external view returns (uint256[] memory) {
        return _page(_sentIds[user], offset, limit);
    }

    function getReceivedIds(address user, uint256 offset, uint256 limit) external view returns (uint256[] memory) {
        return _page(_receivedIds[user], offset, limit);
    }

    function getRequestIds(address user, uint256 offset, uint256 limit) external view returns (uint256[] memory) {
        return _page(_requestIds[user], offset, limit);
    }

    function getReceipt(uint256 id) external view returns (Receipt memory) {
        if (id == 0 || id >= nextPaymentId) revert UnknownPayment(id);
        return _receipts[id];
    }

    function getRequest(uint256 id) external view returns (Request memory) {
        if (id == 0 || id >= nextRequestId) revert UnknownRequest(id);
        return _requests[id];
    }

    function _setTokenSupported(address token, bool supported) private {
        if (token == address(0) || (supported && token.code.length == 0)) revert InvalidToken(token);
        supportedTokens[token] = supported;
        emit TokenSupportUpdated(token, supported);
    }

    function _validatePayment(address token, address recipient, uint256 amount, string memory memo) private view {
        _validatePayment(token, recipient, amount, memo, true);
    }

    function _validatePayment(address token, address recipient, uint256 amount, string memory memo,
        bool rejectSelf) private view
    {
        if (!supportedTokens[token]) revert UnsupportedToken(token);
        if (recipient == address(0) || recipient == address(this) || (rejectSelf && recipient == msg.sender)) {
            revert InvalidRecipient(recipient);
        }
        if (amount == 0) revert ZeroAmount();
        if (bytes(memo).length > MAX_MEMO_BYTES) revert MemoTooLong(bytes(memo).length, MAX_MEMO_BYTES);
    }

    function _checkedFee(uint256 amount, uint256 maxFee) private view returns (uint256 fee) {
        fee = quoteFee(amount);
        if (fee > maxFee) revert FeeTooHigh(fee, maxFee);
    }

    function _recordPayment(address token, address recipient, uint256 amount, uint256 fee,
        uint256 requestId, bytes32 ref) private returns (uint256 id)
    {
        id = nextPaymentId++;
        _receipts[id] = Receipt(msg.sender, recipient, token, amount, fee,
            SafeCast.toUint64(block.timestamp), requestId, ref);
        _sentIds[msg.sender].push(id);
        _receivedIds[recipient].push(id);
    }

    // All receipt/request effects precede either external token transfer; reverts roll them back.
    function _transferPayment(uint256 id, address collector, string memory memo) private {
        Receipt memory receipt = _receipts[id];
        IERC20(receipt.token).safeTransferFrom(receipt.payer, receipt.recipient, receipt.amount);
        if (receipt.fee != 0) IERC20(receipt.token).safeTransferFrom(receipt.payer, collector, receipt.fee);
        emit PaymentMade(id, receipt.payer, receipt.recipient, receipt.token, receipt.amount,
            receipt.fee, receipt.requestId, receipt.ref, memo);
    }

    function _openRequest(uint256 id) private view returns (Request storage request) {
        request = _requests[id];
        if (request.status == RequestStatus.None) revert UnknownRequest(id);
        if (request.status != RequestStatus.Open) revert RequestNotOpen(id);
    }

    function _page(uint256[] storage ids, uint256 offset, uint256 limit) private view returns (uint256[] memory page) {
        uint256 length = ids.length;
        uint256 size = offset >= length ? 0 : Math.min(limit, length - offset);
        page = new uint256[](size);
        for (uint256 i; i < size; ++i) page[i] = ids[offset + i];
    }
}
