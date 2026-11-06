// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {SafeCast} from "@openzeppelin/contracts/utils/math/SafeCast.sol";

/**
 * @title FluxoraPayments
 * @notice Minimal USDC payments with payment requests and receipts. Payments go straight
 *         from the payer to the recipient. There is no fee, no pause and no owner.
 *
 * @dev Trust model
 *  - Ownerless and immutable: there are no roles, no admin functions and no upgrade path.
 *    The USDC address is fixed in the constructor and can never change.
 *  - The contract never holds funds. Every payment is a single `transferFrom(payer,
 *    recipient)`, so a payer must first approve this contract to spend their USDC.
 *  - If USDC refuses a transfer (for example the payer or recipient is blocklisted) the
 *    whole payment reverts and nothing is recorded or held.
 *  - Memos and references are public onchain data. Never put secrets in them.
 *  - There is no native-currency path: the contract has no receive or fallback function.
 *  - Unaudited. Test on a testnet before using real funds.
 */
contract FluxoraPayments is ReentrancyGuard {
    using SafeERC20 for IERC20;

    /*//////////////////////////////////////////////////////////////
                                CONSTANTS
    //////////////////////////////////////////////////////////////*/

    /// @notice Maximum memo length in bytes.
    uint256 public constant MAX_MEMO_BYTES = 140;

    /// @notice Maximum number of ids returned by one paginated view call.
    uint256 public constant MAX_PAGE_SIZE = 100;

    /*//////////////////////////////////////////////////////////////
                                  TYPES
    //////////////////////////////////////////////////////////////*/

    /// @notice Lifecycle of a payment request. `Expired` is only ever returned by
    ///         {requestStatus}; it is never stored.
    enum RequestStatus {
        None,
        Open,
        Paid,
        Cancelled,
        Expired
    }

    /// @notice Immutable record of a completed payment.
    /// @param payer Account that paid.
    /// @param recipient Account that received the USDC.
    /// @param amount USDC amount in the token's smallest unit (6 decimals on Arc).
    /// @param timestamp Block timestamp of the payment.
    /// @param requestId Request that was paid, or 0 for a direct payment.
    /// @param ref Caller-supplied public reference (for example an order id hash).
    struct Receipt {
        address payer;
        address recipient;
        uint256 amount;
        uint64 timestamp;
        uint256 requestId;
        bytes32 ref;
    }

    /// @notice A request for payment created by the account that wants to be paid.
    /// @param creator Account that will receive the payment.
    /// @param amount USDC amount requested.
    /// @param expiry Unix time after which the request cannot be paid; 0 means no expiry.
    /// @param ref Caller-supplied public reference.
    /// @param status Stored status (never `Expired`).
    /// @param paidBy Account that paid the request, once paid.
    /// @param paymentId Receipt id of the payment, once paid.
    struct Request {
        address creator;
        uint256 amount;
        uint64 expiry;
        bytes32 ref;
        RequestStatus status;
        address paidBy;
        uint256 paymentId;
    }

    /*//////////////////////////////////////////////////////////////
                                  STATE
    //////////////////////////////////////////////////////////////*/

    /// @notice The only token this contract moves, fixed at deployment.
    IERC20 public immutable usdc;

    /// @notice Id the next payment receipt will receive.
    uint256 public nextPaymentId = 1;

    /// @notice Id the next payment request will receive.
    uint256 public nextRequestId = 1;

    mapping(uint256 id => Receipt) private _receipts;
    mapping(uint256 id => string) private _paymentMemos;
    mapping(uint256 id => Request) private _requests;
    mapping(uint256 id => string) private _requestMemos;
    mapping(address account => uint256[]) private _sentIds;
    mapping(address account => uint256[]) private _receivedIds;
    mapping(address account => uint256[]) private _requestIdsOf;

    /*//////////////////////////////////////////////////////////////
                                  ERRORS
    //////////////////////////////////////////////////////////////*/

    /// @dev A required address was the zero address.
    error ZeroAddress();
    /// @dev The token address has no contract code.
    error InvalidToken(address token);
    /// @dev The recipient is the zero address, this contract, or the payer.
    error InvalidRecipient(address recipient);
    /// @dev The amount was zero.
    error ZeroAmount();
    /// @dev The memo is longer than {MAX_MEMO_BYTES}.
    error MemoTooLong(uint256 length, uint256 maximum);
    /// @dev The expiry is not in the future.
    error InvalidExpiry(uint64 expiry, uint256 currentTime);
    /// @dev No payment exists with this id.
    error UnknownPayment(uint256 id);
    /// @dev No request exists with this id.
    error UnknownRequest(uint256 id);
    /// @dev The request is not open (already paid or cancelled).
    error RequestNotOpen(uint256 id);
    /// @dev The request has passed its expiry.
    error RequestExpired(uint256 id);
    /// @dev A creator cannot pay their own request.
    error CannotPayOwnRequest(uint256 id);
    /// @dev Only the request creator may do this.
    error NotRequestCreator(address caller, address creator);
    /// @dev The requested page is larger than {MAX_PAGE_SIZE}.
    error PageTooLarge(uint256 limit, uint256 maximum);

    /*//////////////////////////////////////////////////////////////
                                  EVENTS
    //////////////////////////////////////////////////////////////*/

    /// @notice A payment was made. `requestId` is 0 for a direct payment.
    event PaymentMade(
        uint256 indexed paymentId,
        address indexed payer,
        address indexed recipient,
        uint256 amount,
        uint256 requestId,
        bytes32 ref,
        string memo
    );

    /// @notice A payment request was created.
    event RequestCreated(
        uint256 indexed requestId,
        address indexed creator,
        uint256 amount,
        uint64 expiry,
        bytes32 ref,
        string memo
    );

    /// @notice A payment request was cancelled by its creator.
    event RequestCancelled(uint256 indexed requestId, address indexed creator);

    /*//////////////////////////////////////////////////////////////
                               CONSTRUCTOR
    //////////////////////////////////////////////////////////////*/

    /// @param usdc_ Address of the USDC token contract on the chain you deploy to.
    constructor(address usdc_) {
        if (usdc_ == address(0)) revert ZeroAddress();
        if (usdc_.code.length == 0) revert InvalidToken(usdc_);
        usdc = IERC20(usdc_);
    }

    /*//////////////////////////////////////////////////////////////
                            PAYMENT FUNCTIONS
    //////////////////////////////////////////////////////////////*/

    /// @notice Pay `recipient` directly. The caller must have approved this contract for
    ///         at least `amount` USDC.
    /// @param recipient Account to pay. Cannot be zero, this contract, or the caller.
    /// @param amount USDC amount (smallest unit). Must be greater than zero.
    /// @param ref Public reference, or zero.
    /// @param memo Public note of at most {MAX_MEMO_BYTES} bytes.
    /// @return paymentId Id of the new receipt.
    function pay(address recipient, uint256 amount, bytes32 ref, string calldata memo)
        external
        nonReentrant
        returns (uint256 paymentId)
    {
        _requireMemo(memo);
        paymentId = _record(msg.sender, recipient, amount, 0, ref, memo);
        usdc.safeTransferFrom(msg.sender, recipient, amount);
    }

    /// @notice Create a request asking to be paid `amount` USDC.
    /// @param amount USDC amount requested. Must be greater than zero.
    /// @param expiry Unix time after which the request cannot be paid, or 0 for none.
    /// @param ref Public reference, or zero.
    /// @param memo Public note of at most {MAX_MEMO_BYTES} bytes.
    /// @return requestId Id of the new request.
    function createRequest(uint256 amount, uint64 expiry, bytes32 ref, string calldata memo)
        external
        returns (uint256 requestId)
    {
        if (amount == 0) revert ZeroAmount();
        if (expiry != 0 && expiry <= block.timestamp) revert InvalidExpiry(expiry, block.timestamp);
        _requireMemo(memo);

        requestId = nextRequestId++;
        _requests[requestId] = Request({
            creator: msg.sender,
            amount: amount,
            expiry: expiry,
            ref: ref,
            status: RequestStatus.Open,
            paidBy: address(0),
            paymentId: 0
        });
        _requestMemos[requestId] = memo;
        _requestIdsOf[msg.sender].push(requestId);

        emit RequestCreated(requestId, msg.sender, amount, expiry, ref, memo);
    }

    /// @notice Pay an open request. The caller must have approved this contract for at
    ///         least the requested amount. The creator cannot pay their own request.
    /// @param requestId Request to pay.
    /// @return paymentId Id of the new receipt.
    function payRequest(uint256 requestId) external nonReentrant returns (uint256 paymentId) {
        Request storage request = _requests[requestId];
        if (request.status == RequestStatus.None) revert UnknownRequest(requestId);
        if (request.status != RequestStatus.Open) revert RequestNotOpen(requestId);
        if (request.expiry != 0 && block.timestamp > request.expiry) revert RequestExpired(requestId);
        if (request.creator == msg.sender) revert CannotPayOwnRequest(requestId);

        address creator = request.creator;
        uint256 amount = request.amount;

        paymentId = _record(msg.sender, creator, amount, requestId, request.ref, "");
        request.status = RequestStatus.Paid;
        request.paidBy = msg.sender;
        request.paymentId = paymentId;

        usdc.safeTransferFrom(msg.sender, creator, amount);
    }

    /// @notice Cancel your own open request.
    /// @param requestId Request to cancel.
    function cancelRequest(uint256 requestId) external {
        Request storage request = _requests[requestId];
        if (request.status == RequestStatus.None) revert UnknownRequest(requestId);
        if (request.creator != msg.sender) revert NotRequestCreator(msg.sender, request.creator);
        if (request.status != RequestStatus.Open) revert RequestNotOpen(requestId);

        request.status = RequestStatus.Cancelled;
        emit RequestCancelled(requestId, msg.sender);
    }

    /*//////////////////////////////////////////////////////////////
                                  VIEWS
    //////////////////////////////////////////////////////////////*/

    /// @notice Read a payment receipt and its memo.
    function getReceipt(uint256 paymentId) external view returns (Receipt memory receipt, string memory memo) {
        receipt = _receipts[paymentId];
        if (receipt.payer == address(0)) revert UnknownPayment(paymentId);
        memo = _paymentMemos[paymentId];
    }

    /// @notice Read a payment request and its memo.
    function getRequest(uint256 requestId) external view returns (Request memory request, string memory memo) {
        request = _requests[requestId];
        if (request.status == RequestStatus.None) revert UnknownRequest(requestId);
        memo = _requestMemos[requestId];
    }

    /// @notice Current status of a request. Returns `Expired` for an open request that
    ///         has passed its expiry, and `None` for an unknown id.
    function requestStatus(uint256 requestId) external view returns (RequestStatus) {
        Request storage request = _requests[requestId];
        if (request.status == RequestStatus.Open && request.expiry != 0 && block.timestamp > request.expiry) {
            return RequestStatus.Expired;
        }
        return request.status;
    }

    /// @notice Number of payments `account` has sent.
    function sentCount(address account) external view returns (uint256) {
        return _sentIds[account].length;
    }

    /// @notice Number of payments `account` has received.
    function receivedCount(address account) external view returns (uint256) {
        return _receivedIds[account].length;
    }

    /// @notice Number of requests `account` has created.
    function requestCount(address account) external view returns (uint256) {
        return _requestIdsOf[account].length;
    }

    /// @notice Payment ids sent by `account`, oldest first.
    /// @param offset Index to start from. Past the end returns an empty list.
    /// @param limit Maximum ids to return (at most {MAX_PAGE_SIZE}).
    function sentPayments(address account, uint256 offset, uint256 limit) external view returns (uint256[] memory) {
        return _page(_sentIds[account], offset, limit);
    }

    /// @notice Payment ids received by `account`, oldest first.
    function receivedPayments(address account, uint256 offset, uint256 limit)
        external
        view
        returns (uint256[] memory)
    {
        return _page(_receivedIds[account], offset, limit);
    }

    /// @notice Request ids created by `account`, oldest first.
    function requestsOf(address account, uint256 offset, uint256 limit) external view returns (uint256[] memory) {
        return _page(_requestIdsOf[account], offset, limit);
    }

    /*//////////////////////////////////////////////////////////////
                                INTERNALS
    //////////////////////////////////////////////////////////////*/

    /// @dev Validates a payment, stores its receipt and history, and emits the event.
    ///      Callers move the tokens afterwards (checks-effects-interactions).
    function _record(
        address payer,
        address recipient,
        uint256 amount,
        uint256 requestId,
        bytes32 ref,
        string memory memo
    ) private returns (uint256 paymentId) {
        if (recipient == address(0) || recipient == address(this) || recipient == payer) {
            revert InvalidRecipient(recipient);
        }
        if (amount == 0) revert ZeroAmount();

        paymentId = nextPaymentId++;
        _receipts[paymentId] = Receipt({
            payer: payer,
            recipient: recipient,
            amount: amount,
            timestamp: SafeCast.toUint64(block.timestamp),
            requestId: requestId,
            ref: ref
        });
        if (bytes(memo).length != 0) _paymentMemos[paymentId] = memo;
        _sentIds[payer].push(paymentId);
        _receivedIds[recipient].push(paymentId);

        emit PaymentMade(paymentId, payer, recipient, amount, requestId, ref, memo);
    }

    function _requireMemo(string calldata memo) private pure {
        uint256 length = bytes(memo).length;
        if (length > MAX_MEMO_BYTES) revert MemoTooLong(length, MAX_MEMO_BYTES);
    }

    function _page(uint256[] storage ids, uint256 offset, uint256 limit) private view returns (uint256[] memory page) {
        if (limit > MAX_PAGE_SIZE) revert PageTooLarge(limit, MAX_PAGE_SIZE);
        uint256 length = ids.length;
        if (offset >= length) return new uint256[](0);

        uint256 end = offset + limit;
        if (end > length) end = length;

        page = new uint256[](end - offset);
        for (uint256 i = offset; i < end; ++i) {
            page[i - offset] = ids[i];
        }
    }
}
