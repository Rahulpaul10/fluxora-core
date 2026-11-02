// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {AccessControlDefaultAdminRules} from "@openzeppelin/contracts/access/extensions/AccessControlDefaultAdminRules.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {SafeCast} from "@openzeppelin/contracts/utils/math/SafeCast.sol";

/// @title FLUXORA Payments (standalone, self-administered)
/// @author FLUXORA
/// @notice Non-custodial ERC-20 payments, payment requests and onchain receipts for the FLUXORA wallet.
///         This is the only FLUXORA contract the wallet frontend needs: the "Others Pay" page (pay an
///         address, create payment requests, payment history and receipts) talks to it directly.
///
/// @dev ---------------------------------------------------------------------------------------------
///      WHAT THIS CONTRACT DOES
///      ---------------------------------------------------------------------------------------------
///      * `pay` moves an allowlisted ERC-20 straight from the payer to the recipient (and, when a fee is
///        configured, from the payer to the fee recipient) using `transferFrom`. The payer must first
///        approve this contract for `amount + fee`.
///      * `createRequest` / `payRequest` / `cancelRequest` implement payable-once payment requests. The
///        request creator is the payee. Anybody except the creator can pay an open, unexpired request.
///      * Every payment is stored as a numbered receipt (payer, recipient, token, amount, fee, time,
///        request id, reference) and indexed per user so the frontend can page through "sent" and
///        "received" history without scanning logs.
///
///      ---------------------------------------------------------------------------------------------
///      WHO CAN DO WHAT
///      ---------------------------------------------------------------------------------------------
///      * Anyone: pay, createRequest, payRequest, cancelRequest (own requests only), all view functions.
///      * DEFAULT_ADMIN (the deployer at first, exactly one account at any time): allowlist or remove
///        payment tokens, set the fee (hard-capped at 1 %) and fee recipient, grant or revoke
///        PAUSER_ROLE, and start a two-step admin transfer. The admin role can NOT be granted, revoked or
///        renounced: it moves only through `beginDefaultAdminTransfer` followed, after the configured delay
///        (1 to 30 days), by `acceptDefaultAdminTransfer` from the new admin (OpenZeppelin
///        AccessControlDefaultAdminRules). A mistyped address therefore never takes control, and the
///        contract can never be left without an admin: transferring to the zero address and renouncing
///        the admin role are both disabled on purpose.
///      * PAUSER_ROLE (the deployer at first): pause / unpause new payments and new requests. The pauser
///        role FOLLOWS the admin: whoever becomes admin also becomes a pauser, and an account that stops
///        being admin loses its pauser role in the same transaction. The admin can also remove or
///        renounce its own pauser role, but it can always grant it back to itself, so because an admin
///        always exists a paused contract can always be unpaused. The admin may additionally grant
///        PAUSER_ROLE to other accounts (for example a hot wallet); those extra pausers stay until the
///        admin revokes them, so review them after every admin handover.
///
///      ---------------------------------------------------------------------------------------------
///      TRUST MODEL AND SAFETY PROPERTIES
///      ---------------------------------------------------------------------------------------------
///      * The contract never holds user funds. Tokens only ever move payer -> recipient and payer ->
///        fee recipient inside a single call. There is no deposit, no balance, no withdrawal function,
///        no token-rescue function and no arbitrary external call, so neither the admin nor the pauser
///        can move or freeze anyone's tokens. Pausing only blocks NEW payments and requests;
///        `cancelRequest` keeps working while paused.
///      * The fee is charged on top of the amount: the recipient always receives exactly `amount`.
///        It is rounded up, capped at MAX_FEE_BPS (1 %), starts at 0, and every payer passes a `maxFee`
///        limit, so a fee change between signing and mining can never charge more than the payer
///        accepted.
///      * There is no minting, no upgradeability (no proxy, no delegatecall, no selfdestruct), no
///        native-currency payment path and no hidden privileged function.
///      * The allowlist MUST contain only standard ERC-20s: no rebasing, no fee-on-transfer, no
///        hooks that can reenter. Arc USDC (6 decimals) and EURC satisfy this. Arc USDC has an issuer
///        blocklist: a payment involving a blocklisted address simply reverts for that payment. If the
///        FEE RECIPIENT is ever blocklisted, every payment of that token reverts until the admin calls
///        `setFeeBps(0)` (always allowed) or sets a different recipient; no funds are ever trapped.
///      * The admin is trusted to maintain the allowlist and the fee; use a hardware wallet or a
///        multisig as the admin. This contract has NOT been independently audited.
/// @custom:upgrade-strategy Direct, non-upgradeable deployment (no proxy). A code change requires a new
///         deployment, and users would then have to start using the new address.
contract FluxoraPaymentsStandalone is AccessControlDefaultAdminRules, Pausable, ReentrancyGuard {
    using SafeERC20 for IERC20;

    // ---------------------------------------------------------------------------------------------
    // Constants and configuration
    // ---------------------------------------------------------------------------------------------

    /// @notice Role allowed to pause and unpause new payments and requests.
    bytes32 public constant PAUSER_ROLE = keccak256("PAUSER_ROLE");

    /// @notice Hard cap for the optional fee, in basis points (100 = 1 %). Cannot be raised.
    uint256 public constant MAX_FEE_BPS = 100;

    /// @notice Maximum length, in bytes, of a payment or request memo.
    uint256 public constant MAX_MEMO_BYTES = 140;

    /// @notice Shortest allowed delay between starting and accepting an admin transfer.
    uint48 public constant MIN_ADMIN_TRANSFER_DELAY = 1 days;

    /// @notice Longest allowed delay between starting and accepting an admin transfer.
    uint48 public constant MAX_ADMIN_TRANSFER_DELAY = 30 days;

    /// @notice Current fee in basis points, charged on top of every payment. Starts at 0.
    uint256 public feeBps;

    /// @notice Account that receives fees. Must be set before a non-zero fee can be enabled.
    address public feeRecipient;

    /// @notice Id that the next payment receipt will get. Receipt ids start at 1.
    uint256 public nextPaymentId = 1;

    /// @notice Id that the next payment request will get. Request ids start at 1.
    uint256 public nextRequestId = 1;

    /// @notice Whether an ERC-20 may be used for payments and requests.
    mapping(address token => bool supported) public supportedTokens;

    // ---------------------------------------------------------------------------------------------
    // Types
    // ---------------------------------------------------------------------------------------------

    /// @notice Lifecycle of a payment request.
    /// @dev None = unknown id, Open = payable, Paid = settled by `payRequest`, Cancelled = withdrawn.
    enum RequestStatus {
        None,
        Open,
        Paid,
        Cancelled
    }

    /// @notice Permanent record of one payment.
    /// @param payer Account that paid.
    /// @param recipient Account that received `amount`.
    /// @param token ERC-20 that was transferred.
    /// @param amount Amount the recipient received, in token units.
    /// @param fee Fee paid by the payer on top of `amount`, in token units.
    /// @param timestamp Block timestamp of the payment.
    /// @param requestId Id of the settled request, or 0 for a direct payment.
    /// @param ref Free-form 32-byte reference chosen by the payer or request creator (e.g. an invoice id).
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

    /// @notice A payment request created by the payee.
    /// @param creator The payee; receives the payment.
    /// @param token ERC-20 the request is denominated in.
    /// @param amount Amount the creator will receive, in token units.
    /// @param expiry Unix time from which the request can no longer be paid; 0 means it never expires.
    /// @param status Current lifecycle state.
    /// @param ref Free-form 32-byte reference copied into the receipt.
    /// @param paidBy Account that settled the request, or address(0) while unpaid.
    /// @param paymentId Receipt id created when the request was paid, or 0 while unpaid.
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

    // ---------------------------------------------------------------------------------------------
    // Storage (private; read through the view functions below)
    // ---------------------------------------------------------------------------------------------

    mapping(uint256 id => Receipt) private _receipts;
    mapping(uint256 id => Request) private _requests;
    /// @dev Memo text of an open request; deleted once the request is paid or cancelled (it then lives in the event).
    mapping(uint256 id => string) private _requestMemos;
    mapping(address user => uint256[]) private _sentIds;
    mapping(address user => uint256[]) private _receivedIds;
    mapping(address user => uint256[]) private _requestIds;

    // ---------------------------------------------------------------------------------------------
    // Errors
    // ---------------------------------------------------------------------------------------------

    /// @notice A required address argument was the zero address.
    error ZeroAddress();
    /// @notice A token address is zero, or is not a contract when it is being allowlisted.
    error InvalidToken(address token);
    /// @notice The token is not on the allowlist.
    error UnsupportedToken(address token);
    /// @notice The recipient is the zero address, this contract, or (for direct payments) the payer.
    error InvalidRecipient(address recipient);
    /// @notice The amount is zero.
    error ZeroAmount();
    /// @notice The memo is longer than MAX_MEMO_BYTES.
    error MemoTooLong(uint256 length, uint256 maximum);
    /// @notice The current fee is higher than the `maxFee` the payer accepted.
    error FeeTooHigh(uint256 fee, uint256 maxFee);
    /// @notice A fee above MAX_FEE_BPS was requested.
    error InvalidFeeBps(uint256 bps);
    /// @notice The fee recipient is invalid (zero while a fee is enabled, or this contract).
    error InvalidFeeRecipient(address recipient);
    /// @notice A request expiry is not in the future.
    error InvalidExpiry(uint64 expiry, uint256 currentTime);
    /// @notice No receipt exists with this id.
    error UnknownPayment(uint256 id);
    /// @notice No request exists with this id.
    error UnknownRequest(uint256 id);
    /// @notice The request has already been paid or cancelled.
    error RequestNotOpen(uint256 id);
    /// @notice The request's expiry time has passed.
    error RequestExpired(uint256 id);
    /// @notice Only the request creator can do this.
    error NotRequestCreator(address caller, address creator);
    /// @notice The admin transfer delay given to the constructor is outside the allowed range.
    error InvalidAdminTransferDelay(uint48 delay, uint48 minimum, uint48 maximum);
    /// @notice The default admin role can only move to another account; it can never be renounced or burned.
    error AdminRenunciationDisabled();

    // ---------------------------------------------------------------------------------------------
    // Events
    // ---------------------------------------------------------------------------------------------

    /// @notice Emitted for every payment, direct or through a request.
    /// @param paymentId Receipt id (use `getReceipt`).
    /// @param payer Account that paid.
    /// @param recipient Account that received `amount`.
    /// @param token ERC-20 that was transferred.
    /// @param amount Amount received by `recipient`.
    /// @param fee Fee paid on top of `amount`.
    /// @param requestId Settled request id, or 0 for a direct payment.
    /// @param ref Free-form 32-byte reference.
    /// @param memo Free-form note (at most MAX_MEMO_BYTES bytes).
    event PaymentMade(
        uint256 indexed paymentId,
        address indexed payer,
        address indexed recipient,
        address token,
        uint256 amount,
        uint256 fee,
        uint256 requestId,
        bytes32 ref,
        string memo
    );

    /// @notice Emitted when a payment request is created.
    event RequestCreated(
        uint256 indexed requestId,
        address indexed creator,
        address token,
        uint256 amount,
        uint64 expiry,
        bytes32 ref,
        string memo
    );

    /// @notice Emitted when the creator cancels an open request.
    event RequestCancelled(uint256 indexed requestId, address indexed creator);

    /// @notice Emitted when a token is added to or removed from the allowlist.
    event TokenSupportUpdated(address indexed token, bool supported);

    /// @notice Emitted when the fee or the fee recipient changes.
    event FeeUpdated(uint256 feeBps, address indexed feeRecipient);

    // ---------------------------------------------------------------------------------------------
    // Constructor
    // ---------------------------------------------------------------------------------------------

    /// @notice Deploys the contract. The deployer (`msg.sender`) becomes the admin and the pauser.
    /// @dev The fee starts at 0 with no fee recipient. Duplicated entries in `initialTokens` are harmless.
    /// @param adminTransferDelay Seconds that must pass between `beginDefaultAdminTransfer` and
    ///        `acceptDefaultAdminTransfer`. Must be between 1 day (86400) and 30 days (2592000).
    /// @param initialTokens ERC-20 addresses to allowlist immediately (for example Arc USDC and EURC).
    ///        Every entry must be a contract; an empty list is allowed.
    constructor(uint48 adminTransferDelay, address[] memory initialTokens)
        AccessControlDefaultAdminRules(_checkedDelay(adminTransferDelay), msg.sender)
    {
        // The deployer is already a pauser (the pauser role follows the admin); granting again is a harmless no-op.
        _grantRole(PAUSER_ROLE, msg.sender);
        for (uint256 i; i < initialTokens.length; ++i) {
            _setTokenSupported(initialTokens[i], true);
        }
    }

    // ---------------------------------------------------------------------------------------------
    // Role plumbing: the pauser role follows the default admin
    // ---------------------------------------------------------------------------------------------

    /// @dev Whoever becomes the default admin (constructor or `acceptDefaultAdminTransfer`) also becomes a pauser.
    function _grantRole(bytes32 role, address account) internal override returns (bool granted) {
        granted = super._grantRole(role, account);
        if (granted && role == DEFAULT_ADMIN_ROLE) {
            super._grantRole(PAUSER_ROLE, account);
        }
    }

    /// @dev An account that stops being the default admin (handover or renunciation) loses its pauser role too,
    ///      so a former admin can never keep pausing payments after the handover.
    function _revokeRole(bytes32 role, address account) internal override returns (bool revoked) {
        revoked = super._revokeRole(role, account);
        if (revoked && role == DEFAULT_ADMIN_ROLE) {
            super._revokeRole(PAUSER_ROLE, account);
        }
    }

    // ---------------------------------------------------------------------------------------------
    // Pausing (PAUSER_ROLE)
    // ---------------------------------------------------------------------------------------------

    /// @notice Stops new payments and new requests. Cancelling an open request keeps working.
    function pause() external onlyRole(PAUSER_ROLE) {
        _pause();
    }

    /// @notice Resumes payments and requests after a pause.
    function unpause() external onlyRole(PAUSER_ROLE) {
        _unpause();
    }

    // ---------------------------------------------------------------------------------------------
    // Administration (DEFAULT_ADMIN_ROLE)
    // ---------------------------------------------------------------------------------------------

    /// @notice Adds or removes a token from the allowlist.
    /// @dev The admin must only allowlist standard ERC-20s (no rebasing, no fee-on-transfer).
    ///      Removing a token never affects past receipts and never locks funds (nothing is held here).
    /// @param token The ERC-20 address. Must be a contract when `supported` is true.
    /// @param supported True to allow the token, false to remove it.
    function setTokenSupported(address token, bool supported) external onlyRole(DEFAULT_ADMIN_ROLE) {
        _setTokenSupported(token, supported);
    }

    /// @notice Sets the fee charged on top of each payment.
    /// @dev A non-zero fee requires a fee recipient to be set first. Setting 0 disables the fee.
    /// @param bps Fee in basis points, at most MAX_FEE_BPS (100 = 1 %).
    function setFeeBps(uint256 bps) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (bps > MAX_FEE_BPS) revert InvalidFeeBps(bps);
        if (bps != 0 && feeRecipient == address(0)) revert InvalidFeeRecipient(feeRecipient);
        feeBps = bps;
        emit FeeUpdated(bps, feeRecipient);
    }

    /// @notice Sets the account that receives fees.
    /// @dev The zero address is only allowed while the fee is 0. This contract cannot be the recipient.
    /// @param recipient The new fee recipient.
    function setFeeRecipient(address recipient) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (recipient == address(this) || (recipient == address(0) && feeBps != 0)) {
            revert InvalidFeeRecipient(recipient);
        }
        feeRecipient = recipient;
        emit FeeUpdated(feeBps, recipient);
    }

    /// @notice Starts the two-step transfer of the admin role to `newAdmin`.
    /// @dev The new admin must call `acceptDefaultAdminTransfer` after the delay. Transferring to the zero
    ///      address is rejected so the contract can never be left without an admin.
    /// @param newAdmin The account that will become the admin.
    function beginDefaultAdminTransfer(address newAdmin) public override onlyRole(DEFAULT_ADMIN_ROLE) {
        if (newAdmin == address(0)) revert ZeroAddress();
        super.beginDefaultAdminTransfer(newAdmin);
    }

    /// @notice Gives up a role you hold. The default admin role cannot be renounced.
    /// @dev Other roles (for example PAUSER_ROLE) can be renounced as usual.
    /// @param role The role to give up.
    /// @param account Must be the caller (checked by OpenZeppelin).
    function renounceRole(bytes32 role, address account) public override {
        if (role == DEFAULT_ADMIN_ROLE) revert AdminRenunciationDisabled();
        super.renounceRole(role, account);
    }

    /// @notice Schedules a new admin-transfer delay (takes effect after OpenZeppelin's own waiting period).
    /// @dev Same bounds as the constructor: between MIN_ADMIN_TRANSFER_DELAY (1 day) and
    ///      MAX_ADMIN_TRANSFER_DELAY (30 days), so the two-step admin protection can never be weakened to
    ///      a few minutes or switched off.
    /// @param newDelay The new delay in seconds.
    function changeDefaultAdminDelay(uint48 newDelay) public override onlyRole(DEFAULT_ADMIN_ROLE) {
        super.changeDefaultAdminDelay(_checkedDelay(newDelay));
    }

    // ---------------------------------------------------------------------------------------------
    // Payments
    // ---------------------------------------------------------------------------------------------

    /// @notice Fee that would be charged on top of `amount` at the current fee rate, rounded up.
    /// @param amount The amount the recipient should receive, in token units.
    /// @return The fee in token units (0 while the fee is disabled).
    function quoteFee(uint256 amount) public view returns (uint256) {
        return Math.mulDiv(amount, feeBps, 10_000, Math.Rounding.Ceil);
    }

    /// @notice Pays `amount` of `token` to `recipient`, plus the fee on top, in one transaction.
    /// @dev The caller must have approved this contract for at least `amount + fee` beforehand.
    ///      Reverts if the contract is paused, the token is not allowlisted, the recipient is invalid
    ///      (zero, this contract or the caller), the amount is zero, the memo is too long, or the
    ///      current fee exceeds `maxFee`.
    /// @param token Allowlisted ERC-20 to pay with.
    /// @param recipient Account that receives exactly `amount`.
    /// @param amount Amount to pay, in token units (must be greater than zero).
    /// @param ref Free-form 32-byte reference stored in the receipt (use 0x00..00 for none).
    /// @param memo Free-form note, at most MAX_MEMO_BYTES bytes, published in the event only.
    /// @param maxFee Highest fee the caller accepts; use `quoteFee(amount)` to get the exact value.
    /// @return paymentId The receipt id of this payment.
    function pay(
        address token,
        address recipient,
        uint256 amount,
        bytes32 ref,
        string calldata memo,
        uint256 maxFee
    ) external nonReentrant whenNotPaused returns (uint256 paymentId) {
        _validatePayment(token, recipient, amount, memo);
        uint256 fee = _checkedFee(amount, maxFee);
        address collector = feeRecipient;
        paymentId = _recordPayment(token, recipient, amount, fee, 0, ref);
        _transferPayment(paymentId, collector, memo);
    }

    // ---------------------------------------------------------------------------------------------
    // Payment requests
    // ---------------------------------------------------------------------------------------------

    /// @notice Creates a payment request that somebody else can pay once. The caller is the payee.
    /// @param token Allowlisted ERC-20 the request is denominated in.
    /// @param amount Amount the caller wants to receive, in token units (greater than zero).
    /// @param expiry Unix time from which the request can no longer be paid; 0 means no expiry.
    ///        A non-zero value must be in the future.
    /// @param ref Free-form 32-byte reference copied into the receipt.
    /// @param memo Free-form note, at most MAX_MEMO_BYTES bytes, published in the `RequestCreated` event.
    /// @return requestId The id to share with the payer.
    function createRequest(address token, uint256 amount, uint64 expiry, bytes32 ref, string calldata memo)
        external
        nonReentrant
        whenNotPaused
        returns (uint256 requestId)
    {
        // The creator is the payee, so the "recipient is the caller" rule of direct payments does not apply.
        _validatePayment(token, msg.sender, amount, memo, false);
        if (expiry != 0 && expiry <= block.timestamp) revert InvalidExpiry(expiry, block.timestamp);
        requestId = nextRequestId++;
        _requests[requestId] = Request(msg.sender, token, amount, expiry, RequestStatus.Open, ref, address(0), 0);
        _requestMemos[requestId] = memo;
        _requestIds[msg.sender].push(requestId);
        emit RequestCreated(requestId, msg.sender, token, amount, expiry, ref, memo);
    }

    /// @notice Pays an open request in full. The creator receives exactly the requested amount.
    /// @dev The caller must have approved this contract for at least `amount + fee`. The request creator
    ///      cannot pay their own request. A request can be paid only once.
    /// @param requestId The request to pay.
    /// @param maxFee Highest fee the caller accepts; use `quoteFee(requestAmount)` to get the exact value.
    /// @return paymentId The receipt id of this payment.
    function payRequest(uint256 requestId, uint256 maxFee)
        external
        nonReentrant
        whenNotPaused
        returns (uint256 paymentId)
    {
        Request storage request = _openRequest(requestId);
        if (request.expiry != 0 && block.timestamp >= request.expiry) revert RequestExpired(requestId);
        string memory memo = _requestMemos[requestId];
        _validatePayment(request.token, request.creator, request.amount, memo);
        uint256 fee = _checkedFee(request.amount, maxFee);
        address collector = feeRecipient;
        paymentId = _recordPayment(request.token, request.creator, request.amount, fee, requestId, request.ref);
        // Effects first: mark the request as settled before any token leaves the payer.
        request.status = RequestStatus.Paid;
        request.paidBy = msg.sender;
        request.paymentId = paymentId;
        delete _requestMemos[requestId];
        _transferPayment(paymentId, collector, memo);
    }

    /// @notice Cancels an open request. Only the creator can do this, even while payments are paused.
    /// @param requestId The request to cancel.
    function cancelRequest(uint256 requestId) external nonReentrant {
        Request storage request = _openRequest(requestId);
        if (request.creator != msg.sender) revert NotRequestCreator(msg.sender, request.creator);
        request.status = RequestStatus.Cancelled;
        delete _requestMemos[requestId];
        emit RequestCancelled(requestId, msg.sender);
    }

    // ---------------------------------------------------------------------------------------------
    // Views (used by the frontend for history, receipts and request lists)
    // ---------------------------------------------------------------------------------------------

    /// @notice Number of payments `user` has sent.
    function sentCount(address user) external view returns (uint256) {
        return _sentIds[user].length;
    }

    /// @notice Number of payments `user` has received.
    function receivedCount(address user) external view returns (uint256) {
        return _receivedIds[user].length;
    }

    /// @notice Number of requests `user` has created.
    function requestCount(address user) external view returns (uint256) {
        return _requestIds[user].length;
    }

    /// @notice Receipt ids of payments sent by `user`, oldest first.
    /// @dev Pages clamp to the available entries; an offset at or past the end returns an empty array.
    /// @param user The payer.
    /// @param offset Index of the first entry to return.
    /// @param limit Maximum number of entries to return.
    function getSentIds(address user, uint256 offset, uint256 limit) external view returns (uint256[] memory) {
        return _page(_sentIds[user], offset, limit);
    }

    /// @notice Receipt ids of payments received by `user`, oldest first. Paging works like `getSentIds`.
    function getReceivedIds(address user, uint256 offset, uint256 limit) external view returns (uint256[] memory) {
        return _page(_receivedIds[user], offset, limit);
    }

    /// @notice Request ids created by `user`, oldest first. Paging works like `getSentIds`.
    function getRequestIds(address user, uint256 offset, uint256 limit) external view returns (uint256[] memory) {
        return _page(_requestIds[user], offset, limit);
    }

    /// @notice Returns one payment receipt. Reverts with `UnknownPayment` for an id that does not exist.
    function getReceipt(uint256 id) external view returns (Receipt memory) {
        if (id == 0 || id >= nextPaymentId) revert UnknownPayment(id);
        return _receipts[id];
    }

    /// @notice Returns one payment request. Reverts with `UnknownRequest` for an id that does not exist.
    function getRequest(uint256 id) external view returns (Request memory) {
        if (id == 0 || id >= nextRequestId) revert UnknownRequest(id);
        return _requests[id];
    }

    // ---------------------------------------------------------------------------------------------
    // Internal helpers
    // ---------------------------------------------------------------------------------------------

    /// @dev Validates the constructor delay before it is handed to AccessControlDefaultAdminRules.
    function _checkedDelay(uint48 delay) private pure returns (uint48) {
        if (delay < MIN_ADMIN_TRANSFER_DELAY || delay > MAX_ADMIN_TRANSFER_DELAY) {
            revert InvalidAdminTransferDelay(delay, MIN_ADMIN_TRANSFER_DELAY, MAX_ADMIN_TRANSFER_DELAY);
        }
        return delay;
    }

    /// @dev Updates the allowlist. Adding requires a contract address; removing only requires non-zero.
    function _setTokenSupported(address token, bool supported) private {
        if (token == address(0) || (supported && token.code.length == 0)) revert InvalidToken(token);
        supportedTokens[token] = supported;
        emit TokenSupportUpdated(token, supported);
    }

    /// @dev Validation for direct payments and for paying a request: the payer may not be the recipient.
    function _validatePayment(address token, address recipient, uint256 amount, string memory memo) private view {
        _validatePayment(token, recipient, amount, memo, true);
    }

    /// @dev Shared validation. `rejectSelf` is false only when a creator registers a request for themselves.
    function _validatePayment(
        address token,
        address recipient,
        uint256 amount,
        string memory memo,
        bool rejectSelf
    ) private view {
        if (!supportedTokens[token]) revert UnsupportedToken(token);
        if (recipient == address(0) || recipient == address(this) || (rejectSelf && recipient == msg.sender)) {
            revert InvalidRecipient(recipient);
        }
        if (amount == 0) revert ZeroAmount();
        if (bytes(memo).length > MAX_MEMO_BYTES) revert MemoTooLong(bytes(memo).length, MAX_MEMO_BYTES);
    }

    /// @dev Computes the fee and enforces the caller's `maxFee` limit.
    function _checkedFee(uint256 amount, uint256 maxFee) private view returns (uint256 fee) {
        fee = quoteFee(amount);
        if (fee > maxFee) revert FeeTooHigh(fee, maxFee);
    }

    /// @dev Stores the receipt and indexes it for both parties. No tokens move here.
    function _recordPayment(
        address token,
        address recipient,
        uint256 amount,
        uint256 fee,
        uint256 requestId,
        bytes32 ref
    ) private returns (uint256 id) {
        id = nextPaymentId++;
        _receipts[id] = Receipt(msg.sender, recipient, token, amount, fee, SafeCast.toUint64(block.timestamp), requestId, ref);
        _sentIds[msg.sender].push(id);
        _receivedIds[recipient].push(id);
    }

    /// @dev Moves the tokens and emits the event. All receipt and request state is written before this
    ///      runs, and a failed transfer reverts the whole transaction, including those writes.
    function _transferPayment(uint256 id, address collector, string memory memo) private {
        Receipt memory receipt = _receipts[id];
        IERC20(receipt.token).safeTransferFrom(receipt.payer, receipt.recipient, receipt.amount);
        if (receipt.fee != 0) IERC20(receipt.token).safeTransferFrom(receipt.payer, collector, receipt.fee);
        emit PaymentMade(
            id, receipt.payer, receipt.recipient, receipt.token, receipt.amount, receipt.fee, receipt.requestId, receipt.ref, memo
        );
    }

    /// @dev Loads a request that must exist and still be open.
    function _openRequest(uint256 id) private view returns (Request storage request) {
        request = _requests[id];
        if (request.status == RequestStatus.None) revert UnknownRequest(id);
        if (request.status != RequestStatus.Open) revert RequestNotOpen(id);
    }

    /// @dev Returns up to `limit` entries of `ids` starting at `offset`, clamped to the array length.
    function _page(uint256[] storage ids, uint256 offset, uint256 limit) private view returns (uint256[] memory page) {
        uint256 length = ids.length;
        uint256 size = offset >= length ? 0 : Math.min(limit, length - offset);
        page = new uint256[](size);
        for (uint256 i; i < size; ++i) page[i] = ids[offset + i];
    }
}
