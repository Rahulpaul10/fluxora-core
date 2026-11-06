// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";

/// @title Fluxora ERC-20 Escrow
/// @notice Buyer-funded escrow with seller acceptance, optional arbitration, and raw token amounts.
/// @dev Unaudited and not upgradeable. Parties trust their chosen arbiter; the owner is trusted to
/// vet standard, non-rebasing, non-fee-on-transfer tokens. Exact funding checks cannot detect every
/// malicious token or future behavior change. The owner controls token admission, future fee terms,
/// and creation-only pausing, but cannot withdraw, redirect, freeze, or resolve escrow funds merely
/// by being owner. Existing escrows retain their fee and collector; ownership uses two-step transfer
/// and cannot be renounced. Failed payouts become account-owned credits claimable to another address;
/// claims still depend on the token permitting transfers. After 14 days of arbitration, anyone may
/// split a dispute equally, with the odd unit to the buyer and a proportional fee on the seller share.
/// The arbiter may still resolve until settlement. Direct token donations and forced native currency
/// have no recovery path. Uses OpenZeppelin Contracts 5.6.1 APIs.
contract Fluxora is Ownable2Step, Pausable, ReentrancyGuard {
    using SafeERC20 for IERC20;

    // -------------------------------------------------------------------------
    // Constants
    // -------------------------------------------------------------------------

    /// @notice Maximum seller-paid release fee: 100 basis points (1%).
    uint256 public constant MAX_FEE_BPS = 100;
    /// @notice Maximum time from funding until the derived refund deadline.
    uint256 public constant MAX_DURATION = 365 days;
    /// @notice Grace period between the release and refund deadlines.
    uint256 public constant REFUND_GRACE_PERIOD = 7 days;
    /// @notice Time after opening a dispute until anyone can trigger a split.
    uint256 public constant ARBITRATION_WINDOW = 14 days;
    /// @notice Maximum ids returned by a single history query.
    uint256 public constant MAX_PAGE_SIZE = 100;

    // -------------------------------------------------------------------------
    // Types
    // -------------------------------------------------------------------------

    /// @notice Lifecycle states; None denotes an unknown id and terminal states cannot reopen.
    enum Status {
        None,
        Pending,
        Funded,
        Disputed,
        Released,
        Refunded,
        Split
    }

    /// @notice Fixed agreement terms with mutable lifecycle status and dispute deadline.
    /// @param buyer Funder and recipient of refunds or the buyer split share.
    /// @param seller Recipient of releases or the seller split share, less fees.
    /// @param arbiter Optional resolver; zero disables disputes.
    /// @param token Underlying ERC-20 contract.
    /// @param amount Gross funded amount in raw token units.
    /// @param releaseDeadline Exclusive acceptance and ordinary release cutoff.
    /// @param refundDeadline Inclusive expiry settlement start and exclusive dispute cutoff.
    /// @param fee Full-release fee snapshot; split fees are proportional to the seller share.
    /// @param feeCollector Collector snapshot, unaffected by later owner changes.
    /// @param ref Public application reference; zero is permitted.
    /// @param status Current lifecycle state.
    /// @param disputeDeadline Inclusive permissionless split start; zero until disputed.
    /// @param releaseOnExpiry Whether expiry permits seller release instead of buyer refund.
    struct Escrow {
        address buyer;
        address seller;
        address arbiter;
        address token;
        uint256 amount;
        uint256 releaseDeadline;
        uint256 refundDeadline;
        uint256 fee;
        address feeCollector;
        bytes32 ref;
        Status status;
        uint256 disputeDeadline;
        bool releaseOnExpiry;
    }

    // -------------------------------------------------------------------------
    // State
    // -------------------------------------------------------------------------

    /// @notice Allowlist governing creation only, never settlement.
    mapping(address token => bool supported) public supportedTokens;
    /// @notice Release fee rate for future escrows; initially zero.
    uint256 public feeBps;
    /// @notice Collector for future escrows; initially the initial owner.
    address public feeRecipient;
    /// @notice Next id; numbering starts at one.
    uint256 public nextEscrowId = 1;
    /// @notice Failed payouts withdrawable only by the credited account.
    mapping(address token => mapping(address account => uint256)) public claimable;
    /// @notice Aggregate unclaimed payout credits for each token.
    mapping(address token => uint256) public totalPending;

    mapping(uint256 id => Escrow) private _escrows;
    mapping(address user => uint256[]) private _userIds;

    // -------------------------------------------------------------------------
    // Errors
    // -------------------------------------------------------------------------

    /// @notice A required nonzero address is zero.
    error ZeroAddress();
    /// @notice An actor address is invalid or overlaps a prohibited actor.
    error InvalidActor(address actor);
    /// @notice A token is not a usable contract address.
    error InvalidToken(address token);
    /// @notice Creation is not allowed for this token.
    error UnsupportedToken(address token);
    /// @notice Escrows must fund a positive amount.
    error ZeroAmount();
    /// @notice The release deadline is not future or exceeds the duration bound.
    error InvalidDeadline(uint256 releaseDeadline);
    /// @notice The requested fee exceeds the immutable cap.
    error InvalidFee(uint256 bps);
    /// @notice The incoming token balance delta does not equal the funded amount.
    error InexactFunding();
    /// @notice No escrow exists with the supplied id.
    error UnknownEscrow(uint256 id);
    /// @notice The lifecycle state does not permit this operation.
    error InvalidStatus(uint256 id, Status actual);
    /// @notice The caller lacks the required escrow authority.
    error Unauthorized();
    /// @notice The acceptance or ordinary release window has ended.
    error ReleaseWindowClosed();
    /// @notice The buyer refund deadline or expiry rule does not permit a refund.
    error RefundNotAvailable();
    /// @notice The deadline or expiry rule does not permit permissionless seller release.
    error ExpiryReleaseNotAvailable(uint256 id);
    /// @notice No arbiter was selected for this escrow.
    error DisputesDisabled();
    /// @notice The deadline for opening a dispute has been reached.
    error DisputeWindowClosed();
    /// @notice The arbitration window has not expired.
    error DisputeNotExpired(uint256 id);
    /// @notice The caller has no payout credit for this token.
    error NothingToClaim();
    /// @notice The requested page exceeds MAX_PAGE_SIZE.
    error PageTooLarge();
    /// @notice Ownership must be transferred rather than renounced.
    error RenunciationDisabled();

    // -------------------------------------------------------------------------
    // Events
    // -------------------------------------------------------------------------

    /// @notice Emitted when a token's creation permission changes.
    event TokenSupportUpdated(address indexed token, bool supported);
    /// @notice Emitted when future-escrow fee terms change.
    event FeeUpdated(uint256 feeBps, address indexed feeRecipient);
    /// @notice Emitted after exact funding; getEscrow exposes the complete stored terms.
    event EscrowCreated(
        uint256 indexed id,
        address indexed buyer,
        address indexed seller,
        address token,
        address arbiter,
        uint256 amount,
        uint256 releaseDeadline,
        uint256 refundDeadline,
        uint256 fee,
        address feeCollector,
        bool releaseOnExpiry,
        bytes32 ref
    );
    /// @notice Emitted when the seller accepts the Pending escrow's terms.
    event EscrowAccepted(uint256 indexed id, address indexed seller);
    /// @notice Emitted when either party cancels a Pending escrow.
    event EscrowCancelled(uint256 indexed id, address indexed caller);
    /// @notice Emitted when a party freezes ordinary settlement pending arbitration.
    event EscrowDisputed(uint256 indexed id, address indexed caller);
    /// @notice Emitted on seller settlement; failed payouts become credits.
    event EscrowReleased(uint256 indexed id, address indexed caller, uint256 sellerAmount, uint256 fee);
    /// @notice Emitted on buyer settlement, including cancellation; refunds have no fee.
    event EscrowRefunded(uint256 indexed id, address indexed caller, uint256 amount);
    /// @notice Emitted after the terminal payment event for arbiter resolution.
    event EscrowResolved(uint256 indexed id, address indexed arbiter, bool toSeller);
    /// @notice Emitted on timeout split settlement; failed payouts become credits.
    event EscrowSplit(
        uint256 indexed id, address indexed caller, uint256 sellerAmount, uint256 fee, uint256 buyerAmount
    );
    /// @notice Emitted when a failed payout is credited for later withdrawal.
    event PayoutDeferred(address indexed token, address indexed account, uint256 amount);
    /// @notice Emitted when an account successfully withdraws its payout credit.
    event Claimed(address indexed token, address indexed account, address to, uint256 amount);

    // -------------------------------------------------------------------------
    // Constructor
    // -------------------------------------------------------------------------

    /// @notice Initializes ownership, a zero fee, and the creation allowlist.
    /// @dev Ownable rejects a zero owner. Empty lists and duplicate valid tokens are allowed.
    /// @param initialOwner Initial owner and fee recipient; cannot be this contract.
    /// @param initialTokens Standard ERC-20 contracts to admit initially.
    constructor(address initialOwner, address[] memory initialTokens) Ownable(initialOwner) {
        if (initialOwner == address(this)) revert InvalidActor(initialOwner);
        feeRecipient = initialOwner;
        emit FeeUpdated(0, initialOwner);
        for (uint256 i; i < initialTokens.length; ++i) {
            _setTokenSupported(initialTokens[i], true);
        }
    }

    // -------------------------------------------------------------------------
    // Owner functions
    // -------------------------------------------------------------------------

    /// @notice Pauses new escrow creation only; settlement remains available.
    function pause() external onlyOwner {
        _pause();
    }

    /// @notice Resumes new escrow creation.
    function unpause() external onlyOwner {
        _unpause();
    }

    /// @notice Changes token admission for future escrows only.
    /// @param token Nonzero ERC-20 address; enabling requires deployed code.
    /// @param supported Whether to allow new escrows in this token.
    function setTokenSupported(address token, bool supported) external onlyOwner {
        _setTokenSupported(token, supported);
    }

    /// @notice Sets the future release fee, rounded down in raw token units.
    /// @param bps Basis points, from zero through MAX_FEE_BPS.
    function setFeeBps(uint256 bps) external onlyOwner {
        if (bps > MAX_FEE_BPS) revert InvalidFee(bps);
        feeBps = bps;
        emit FeeUpdated(bps, feeRecipient);
    }

    /// @notice Sets the fee collector for future escrows, not existing escrows.
    /// @param recipient Nonzero address other than this contract.
    function setFeeRecipient(address recipient) external onlyOwner {
        _requireRecipient(recipient);
        feeRecipient = recipient;
        emit FeeUpdated(feeBps, recipient);
    }

    /// @notice Starts a two-step handover; the new owner must call acceptOwnership.
    /// @param newOwner Nonzero recipient other than this contract.
    function transferOwnership(address newOwner) public override onlyOwner {
        _requireRecipient(newOwner);
        super.transferOwnership(newOwner);
    }

    /// @notice Always reverts; ownership cannot be abandoned.
    function renounceOwnership() public view override onlyOwner {
        revert RenunciationDisabled();
    }

    // -------------------------------------------------------------------------
    // Escrow lifecycle
    // -------------------------------------------------------------------------

    /// @notice Funds a Pending escrow with a previously approved, allowlisted ERC-20.
    /// @dev Stores terms and indexes before funding; inexact receipt reverts everything. The refund
    /// deadline adds REFUND_GRACE_PERIOD. Current fee and collector are snapshotted at execution.
    /// Seller acceptance is required before ordinary settlement or disputes.
    /// @param token Standard ERC-20 on the creation allowlist.
    /// @param seller Nonzero recipient distinct from the buyer and this contract.
    /// @param arbiter Zero disables disputes; otherwise distinct from both parties and this contract.
    /// @param amount Positive raw token amount; no decimal conversion is performed.
    /// @param releaseDeadline Future acceptance and release cutoff, leaving grace within MAX_DURATION.
    /// @param releaseOnExpiry True permits seller release at expiry; false permits buyer refund.
    /// @param ref Public application reference; do not include private information.
    /// @return id New escrow id.
    function createEscrow(
        address token,
        address seller,
        address arbiter,
        uint256 amount,
        uint256 releaseDeadline,
        bool releaseOnExpiry,
        bytes32 ref
    ) external nonReentrant whenNotPaused returns (uint256 id) {
        if (!supportedTokens[token]) revert UnsupportedToken(token);
        if (seller == address(0)) revert ZeroAddress();
        if (seller == msg.sender || seller == address(this)) revert InvalidActor(seller);
        if (arbiter != address(0) && (arbiter == msg.sender || arbiter == seller || arbiter == address(this))) {
            revert InvalidActor(arbiter);
        }
        if (amount == 0) revert ZeroAmount();
        if (
            releaseDeadline <= block.timestamp
                || releaseDeadline - block.timestamp > MAX_DURATION - REFUND_GRACE_PERIOD
        ) {
            revert InvalidDeadline(releaseDeadline);
        }

        id = nextEscrowId++;
        Escrow storage e = _escrows[id];
        e.buyer = msg.sender;
        e.seller = seller;
        e.arbiter = arbiter;
        e.token = token;
        e.amount = amount;
        e.releaseDeadline = releaseDeadline;
        e.refundDeadline = releaseDeadline + REFUND_GRACE_PERIOD;
        e.fee = Math.mulDiv(amount, feeBps, 10_000);
        e.feeCollector = feeRecipient;
        e.ref = ref;
        e.status = Status.Pending;
        e.releaseOnExpiry = releaseOnExpiry;
        _userIds[msg.sender].push(id);
        _userIds[seller].push(id);

        IERC20 asset = IERC20(token);
        uint256 beforeBalance = asset.balanceOf(address(this));
        asset.safeTransferFrom(msg.sender, address(this), amount);
        uint256 afterBalance = asset.balanceOf(address(this));
        if (afterBalance < beforeBalance || afterBalance - beforeBalance != amount) revert InexactFunding();
        _emitCreated(id, e);
    }

    /// @notice Seller accepts the Pending escrow's terms before the release deadline.
    /// @param id Pending escrow id.
    function acceptEscrow(uint256 id) external nonReentrant {
        Escrow storage e = _inStatus(id, Status.Pending);
        if (msg.sender != e.seller) revert Unauthorized();
        if (block.timestamp >= e.releaseDeadline) revert ReleaseWindowClosed();
        e.status = Status.Funded;
        emit EscrowAccepted(id, msg.sender);
    }

    /// @notice Either party cancels a Pending escrow for a full buyer refund at any time.
    /// @param id Pending escrow id.
    function cancel(uint256 id) external nonReentrant {
        Escrow storage e = _inStatus(id, Status.Pending);
        if (msg.sender != e.buyer && msg.sender != e.seller) revert Unauthorized();
        e.status = Status.Refunded;
        _payout(e.token, e.buyer, e.amount);
        emit EscrowCancelled(id, msg.sender);
        emit EscrowRefunded(id, msg.sender, e.amount);
    }

    /// @notice Buyer releases an undisputed escrow before its release deadline.
    /// @param id Funded escrow id.
    function release(uint256 id) external nonReentrant {
        Escrow storage e = _inStatus(id, Status.Funded);
        if (msg.sender != e.buyer) revert Unauthorized();
        if (block.timestamp >= e.releaseDeadline) revert ReleaseWindowClosed();
        _settle(id, e, true);
    }

    /// @notice Seller refunds anytime; buyer refunds at expiry only if releaseOnExpiry is false.
    /// @param id Funded escrow id.
    function refund(uint256 id) external nonReentrant {
        Escrow storage e = _inStatus(id, Status.Funded);
        if (msg.sender != e.seller) {
            if (msg.sender != e.buyer) revert Unauthorized();
            if (block.timestamp < e.refundDeadline || e.releaseOnExpiry) revert RefundNotAvailable();
        }
        _settle(id, e, false);
    }

    /// @notice Anyone releases at refundDeadline or later if releaseOnExpiry is true.
    /// @param id Funded escrow id.
    function releaseExpired(uint256 id) external nonReentrant {
        Escrow storage e = _inStatus(id, Status.Funded);
        if (!e.releaseOnExpiry || block.timestamp < e.refundDeadline) revert ExpiryReleaseNotAvailable(id);
        _settle(id, e, true);
    }

    /// @notice Either party opens a dispute before refundDeadline if an arbiter exists.
    /// @dev Disputes disable ordinary settlement until arbitration or a timeout split.
    /// @param id Funded escrow id.
    function dispute(uint256 id) external nonReentrant {
        Escrow storage e = _inStatus(id, Status.Funded);
        if (msg.sender != e.buyer && msg.sender != e.seller) revert Unauthorized();
        if (e.arbiter == address(0)) revert DisputesDisabled();
        if (block.timestamp >= e.refundDeadline) revert DisputeWindowClosed();
        e.status = Status.Disputed;
        e.disputeDeadline = block.timestamp + ARBITRATION_WINDOW;
        emit EscrowDisputed(id, msg.sender);
    }

    /// @notice Only the nominated arbiter resolves while Disputed, even after its deadline.
    /// @param id Disputed escrow id.
    /// @param toSeller True releases less the stored fee; false refunds the buyer in full.
    function resolve(uint256 id, bool toSeller) external nonReentrant {
        Escrow storage e = _inStatus(id, Status.Disputed);
        if (msg.sender != e.arbiter) revert Unauthorized();
        _settle(id, e, toSeller);
        emit EscrowResolved(id, msg.sender, toSeller);
    }

    /// @notice Anyone splits a disputed escrow once the arbitration window expires.
    /// @dev Seller receives half less a proportional fee; any odd unit goes to the buyer.
    /// @param id Disputed escrow id.
    function resolveExpired(uint256 id) external nonReentrant {
        Escrow storage e = _inStatus(id, Status.Disputed);
        if (block.timestamp < e.disputeDeadline) revert DisputeNotExpired(id);
        uint256 sellerGross = e.amount / 2;
        uint256 buyerAmount = e.amount - sellerGross;
        uint256 fee = Math.mulDiv(e.fee, sellerGross, e.amount);
        uint256 sellerAmount = sellerGross - fee;
        e.status = Status.Split;
        _payout(e.token, e.seller, sellerAmount);
        _payout(e.token, e.feeCollector, fee);
        _payout(e.token, e.buyer, buyerAmount);
        emit EscrowSplit(id, msg.sender, sellerAmount, fee, buyerAmount);
    }

    // -------------------------------------------------------------------------
    // Claim
    // -------------------------------------------------------------------------

    /// @notice Withdraws the caller's entire deferred payout credit to a chosen recipient.
    /// @dev Clears credit before transfer; transfer failure reverts and preserves the credit.
    /// @param token Underlying ERC-20 contract for the credit.
    /// @param to Nonzero recipient other than this contract.
    /// @return amount Credit successfully withdrawn in raw token units.
    function claim(address token, address to) external nonReentrant returns (uint256 amount) {
        _requireRecipient(to);
        amount = claimable[token][msg.sender];
        if (amount == 0) revert NothingToClaim();
        claimable[token][msg.sender] = 0;
        totalPending[token] -= amount;
        IERC20(token).safeTransfer(to, amount);
        emit Claimed(token, msg.sender, to, amount);
    }

    // -------------------------------------------------------------------------
    // Views
    // -------------------------------------------------------------------------

    /// @notice Returns the full agreement and status; unknown ids revert.
    /// @param id Escrow id.
    /// @return Agreement Stored terms and lifecycle state.
    function getEscrow(uint256 id) external view returns (Escrow memory Agreement) {
        if (_escrows[id].status == Status.None) revert UnknownEscrow(id);
        return _escrows[id];
    }

    /// @notice Counts buyer/seller history entries; arbiter-only roles are not indexed.
    /// @param user Account whose history to inspect.
    /// @return count Total entries, including terminal escrows.
    function escrowCount(address user) external view returns (uint256 count) {
        return _userIds[user].length;
    }

    /// @notice Returns buyer/seller escrow ids oldest first, without duplicates per escrow.
    /// @param user Account whose history to inspect.
    /// @param offset Zero-based start; past-end returns an empty page.
    /// @param limit Maximum entries, at most MAX_PAGE_SIZE; zero returns an empty page.
    /// @return ids Selected ids, clamped to available entries.
    function escrowsOf(address user, uint256 offset, uint256 limit) external view returns (uint256[] memory ids) {
        if (limit > MAX_PAGE_SIZE) revert PageTooLarge();
        uint256 length = _userIds[user].length;
        uint256 size = offset >= length ? 0 : Math.min(limit, length - offset);
        ids = new uint256[](size);
        for (uint256 i; i < size; ++i) {
            ids[i] = _userIds[user][offset + i];
        }
    }

    // -------------------------------------------------------------------------
    // Internal helpers
    // -------------------------------------------------------------------------

    /// @dev Terminal status precedes payouts; current owner settings never gate settlement.
    function _settle(uint256 id, Escrow storage e, bool toSeller) private {
        e.status = toSeller ? Status.Released : Status.Refunded;
        if (toSeller) {
            _payout(e.token, e.seller, e.amount - e.fee);
            _payout(e.token, e.feeCollector, e.fee);
            emit EscrowReleased(id, msg.sender, e.amount - e.fee, e.fee);
        } else {
            _payout(e.token, e.buyer, e.amount);
            emit EscrowRefunded(id, msg.sender, e.amount);
        }
    }

    /// @dev Failed transfers become credits; zero amounts require no token interaction.
    function _payout(address token, address to, uint256 amount) private {
        if (amount == 0) return;
        if (!SafeERC20.trySafeTransfer(IERC20(token), to, amount)) {
            claimable[token][to] += amount;
            totalPending[token] += amount;
            emit PayoutDeferred(token, to, amount);
        }
    }

    /// @dev Distinguishes unknown ids from an incorrect lifecycle state.
    function _inStatus(uint256 id, Status expected) private view returns (Escrow storage e) {
        e = _escrows[id];
        if (e.status == Status.None) revert UnknownEscrow(id);
        if (e.status != expected) revert InvalidStatus(id, e.status);
    }

    /// @dev Enabling requires code; disabling cannot affect previously funded escrows.
    function _setTokenSupported(address token, bool supported) private {
        if (token == address(0)) revert ZeroAddress();
        if (token == address(this) || (supported && token.code.length == 0)) revert InvalidToken(token);
        supportedTokens[token] = supported;
        emit TokenSupportUpdated(token, supported);
    }

    /// @dev Shares recipient checks without changing their error precedence.
    function _requireRecipient(address recipient) private view {
        if (recipient == address(0)) revert ZeroAddress();
        if (recipient == address(this)) revert InvalidActor(recipient);
    }

    /// @dev Isolates the full terms event from the funding entry point.
    function _emitCreated(uint256 id, Escrow storage e) private {
        emit EscrowCreated(
            id,
            e.buyer,
            e.seller,
            e.token,
            e.arbiter,
            e.amount,
            e.releaseDeadline,
            e.refundDeadline,
            e.fee,
            e.feeCollector,
            e.releaseOnExpiry,
            e.ref
        );
    }
}
