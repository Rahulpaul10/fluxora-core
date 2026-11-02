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
/// @notice Buyer-funded escrow for the Fluxora wallet, not a token. Amounts are raw token
/// units (for example, 1 USDC with 6 decimals is 1_000_000 units).
/// @dev This unaudited, non-upgradeable contract temporarily HOLDS tokens; "non-custodial"
/// means the owner has no discretionary custody or withdrawal power, not that tokens stay
/// in the buyer's wallet. Creation locks funds in Pending until the seller accepts the terms
/// before the release deadline; either party can cancel a Pending escrow for a full refund.
/// After acceptance, only the buyer can release before the release deadline, and the seller
/// can voluntarily refund at any time. At the refund deadline, releaseOnExpiry permits anyone
/// to release to the seller when true, or permits the buyer to refund when false. A dispute
/// before that deadline freezes ordinary settlement; the nominated arbiter can resolve it
/// at any time while Disputed. After a 14-day arbitration window, anyone can trigger a 50/50
/// split, with the odd unit going to the buyer and a proportional fee on the seller's half.
/// Parties must trust their chosen arbiter's honesty; without an arbiter, disputes are disabled.
///
/// The owner controls token admission, fees for FUTURE escrows, and creation-only pausing.
/// Existing escrows snapshot their fee and collector. Removing a token or pausing never
/// prevents settlement. The owner cannot withdraw, redirect, freeze or resolve funds by
/// virtue of ownership, but may act normally if explicitly selected as a party or arbiter.
/// Ownership transfers require acceptance; renunciation is disabled.
///
/// Only standard, non-rebasing, non-fee-on-transfer ERC-20s belong on the allowlist. An exact
/// incoming balance delta rejects inexact funding but cannot detect every malicious token,
/// future rebase, or token behavior change. Issuer freezes, token pauses, and blocklisting
/// of a party or snapshotted fee collector can prevent transfers independently of Fluxora.
/// Failed payouts become pull-payment credits, claimable by the credited account to another
/// address; settlement never depends on a recipient's ability to receive. Claims still depend
/// on the token permitting the transfer. The owner is trusted to vet tokens. Direct token
/// donations and forcibly sent native currency have no recovery path. No native payment entry
/// point, arbitrary call facility, proxy, delegatecall or selfdestruct is provided. Uses
/// OpenZeppelin Contracts 5.6.1 APIs.
contract Fluxora is Ownable2Step, Pausable, ReentrancyGuard {
    using SafeERC20 for IERC20;

    /// @notice Maximum seller-paid release fee: 100 basis points (1%).
    uint256 public constant MAX_FEE_BPS = 100;
    /// @notice Maximum time from funding until the derived refund deadline.
    uint256 public constant MAX_DURATION = 365 days;
    /// @notice Fixed dispute/grace window after the release deadline.
    uint256 public constant REFUND_GRACE_PERIOD = 7 days;
    /// @notice Time after opening a dispute until anyone can trigger a split.
    uint256 public constant ARBITRATION_WINDOW = 14 days;
    /// @notice Maximum ids returned by a single history query.
    uint256 public constant MAX_PAGE_SIZE = 100;

    /// @notice Lifecycle; zero denotes an unknown id. Terminal states cannot be reopened.
    enum Status { None, Pending, Funded, Disputed, Released, Refunded, Split }

    /// @notice Immutable agreement terms plus current lifecycle status and dispute deadline.
    /// @param buyer Funder and recipient of any refund or buyer split share.
    /// @param seller Recipient of a release or seller split share, less the applicable fee.
    /// @param arbiter Optional resolver; zero disables disputes.
    /// @param token Underlying ERC-20 contract.
    /// @param amount Gross funded amount, in raw token units.
    /// @param releaseDeadline Exclusive deadline for acceptance and ordinary release.
    /// @param refundDeadline Inclusive start of expiry settlement; disputes must precede this.
    /// @param fee Full-release fee snapshot; split fees are proportional to the seller's half.
    /// @param feeCollector Snapshotted collector, unaffected by later owner changes.
    /// @param ref Public, application-defined reference; zero is permitted.
    /// @param status Current lifecycle state.
    /// @param disputeDeadline Inclusive start of permissionless split settlement; zero until disputed.
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
    /// @notice The proposed release deadline is not future or exceeds the duration bound.
    error InvalidDeadline(uint256 releaseDeadline);
    /// @notice Requested fee exceeds the immutable cap.
    error InvalidFee(uint256 bps);
    /// @notice The transfer did not increase the contract's token balance by exactly amount.
    error InexactFunding();
    /// @notice No escrow exists with the supplied id.
    error UnknownEscrow(uint256 id);
    /// @notice The lifecycle state does not permit this operation.
    error InvalidStatus(uint256 id, Status actual);
    /// @notice The caller lacks the required escrow authority.
    error Unauthorized();
    /// @notice The release window has ended.
    error ReleaseWindowClosed();
    /// @notice The unilateral buyer refund window has not started or the expiry rule forbids it.
    error RefundNotAvailable();
    /// @notice The expiry rule or deadline does not permit permissionless seller release.
    error ExpiryReleaseNotAvailable(uint256 id);
    /// @notice No arbiter was selected for this escrow.
    error DisputesDisabled();
    /// @notice Disputes cannot be opened once the expiry settlement deadline is reached.
    error DisputeWindowClosed();
    /// @notice The arbitration window has not expired.
    error DisputeNotExpired(uint256 id);
    /// @notice The caller has no payout credit for this token.
    error NothingToClaim();
    /// @notice The requested page exceeds MAX_PAGE_SIZE.
    error PageTooLarge();
    /// @notice Ownership must be transferred rather than renounced.
    error RenunciationDisabled();

    /// @notice Emitted when a token's creation permission changes.
    event TokenSupportUpdated(address indexed token, bool supported);
    /// @notice Emitted when future-escrow fee terms change.
    event FeeUpdated(uint256 feeBps, address indexed feeRecipient);
    /// @notice Emitted on exact funding of a Pending escrow; complete terms are available through getEscrow.
    event EscrowCreated(
        uint256 indexed id, address indexed buyer, address indexed seller,
        address token, address arbiter, uint256 amount, uint256 releaseDeadline,
        uint256 refundDeadline, uint256 fee, address feeCollector, bool releaseOnExpiry, bytes32 ref
    );
    /// @notice Emitted when the seller accepts the Pending escrow's terms.
    event EscrowAccepted(uint256 indexed id, address indexed seller);
    /// @notice Emitted when either party cancels a Pending escrow.
    event EscrowCancelled(uint256 indexed id, address indexed caller);
    /// @notice Emitted when a party freezes ordinary settlement pending arbitration.
    event EscrowDisputed(uint256 indexed id, address indexed caller);
    /// @notice Emitted on seller settlement, including arbiter resolution; failed payouts become credits.
    event EscrowReleased(uint256 indexed id, address indexed caller, uint256 sellerAmount, uint256 fee);
    /// @notice Emitted on buyer settlement, including cancellation and resolution; refunds have no fee.
    event EscrowRefunded(uint256 indexed id, address indexed caller, uint256 amount);
    /// @notice Emitted in addition to the terminal payment event for arbiter resolution.
    event EscrowResolved(uint256 indexed id, address indexed arbiter, bool toSeller);
    /// @notice Emitted on timeout split settlement; failed payouts become credits.
    event EscrowSplit(uint256 indexed id, address indexed caller, uint256 sellerAmount, uint256 fee, uint256 buyerAmount);
    /// @notice Emitted when a failed payout is credited for later withdrawal.
    event PayoutDeferred(address indexed token, address indexed account, uint256 amount);
    /// @notice Emitted when an account successfully withdraws its payout credit.
    event Claimed(address indexed token, address indexed account, address to, uint256 amount);

    /// @notice Initializes ownership, a zero fee, and the creation allowlist.
    /// @dev Ownable rejects a zero owner. Empty lists and duplicate valid tokens are allowed.
    /// @param initialOwner Initial owner and initial fee recipient; cannot be this contract.
    /// @param initialTokens Standard ERC-20 contracts to admit initially.
    constructor(address initialOwner, address[] memory initialTokens) Ownable(initialOwner) {
        if (initialOwner == address(this)) revert InvalidActor(initialOwner);
        feeRecipient = initialOwner;
        emit FeeUpdated(0, initialOwner);
        for (uint256 i; i < initialTokens.length; ++i) {
            _setTokenSupported(initialTokens[i], true);
        }
    }

    /// @notice Pauses only new escrow creation. All settlement paths remain available.
    function pause() external onlyOwner { _pause(); }

    /// @notice Resumes new escrow creation.
    function unpause() external onlyOwner { _unpause(); }

    /// @notice Changes token admission for future escrows only.
    /// @param token Nonzero ERC-20 address; enabling requires deployed code.
    /// @param supported Whether to allow funding new escrows in this token.
    function setTokenSupported(address token, bool supported) external onlyOwner {
        _setTokenSupported(token, supported);
    }

    /// @notice Sets the release fee for future escrows only, rounded down in token units.
    /// @param bps Basis points, between zero and MAX_FEE_BPS inclusive.
    function setFeeBps(uint256 bps) external onlyOwner {
        if (bps > MAX_FEE_BPS) revert InvalidFee(bps);
        feeBps = bps;
        emit FeeUpdated(bps, feeRecipient);
    }

    /// @notice Sets the fee collector for future escrows, never existing escrows.
    /// @param recipient Nonzero address other than this contract.
    function setFeeRecipient(address recipient) external onlyOwner {
        if (recipient == address(0)) revert ZeroAddress();
        if (recipient == address(this)) revert InvalidActor(recipient);
        feeRecipient = recipient;
        emit FeeUpdated(feeBps, recipient);
    }

    /// @notice Starts a two-step ownership handover; the new owner must acceptOwnership.
    /// @param newOwner Nonzero recipient other than this contract.
    function transferOwnership(address newOwner) public override onlyOwner {
        if (newOwner == address(0)) revert ZeroAddress();
        if (newOwner == address(this)) revert InvalidActor(newOwner);
        super.transferOwnership(newOwner);
    }

    /// @notice Always reverts; ownership cannot be abandoned.
    function renounceOwnership() public view override onlyOwner {
        revert RenunciationDisabled();
    }

    /// @notice Funds a Pending escrow using a previously approved, allowlisted ERC-20.
    /// @dev Writes agreement and indexes before transfer; any inexact receipt reverts everything.
    /// Refund deadline is releaseDeadline + REFUND_GRACE_PERIOD. Fee and collector are frozen
    /// at execution; callers should inspect current fee settings before submitting funding.
    /// The seller must accept the terms before ordinary settlement or disputes are available.
    /// @param token Standard ERC-20 on the creation allowlist.
    /// @param seller Nonzero recipient, distinct from buyer and this contract.
    /// @param arbiter Zero for no disputes, otherwise distinct from both parties and this contract.
    /// @param amount Positive amount in raw units; no decimal conversion is performed.
    /// @param releaseDeadline Exclusive acceptance and release cutoff; must be future and leave room for grace
    /// within MAX_DURATION from the current timestamp.
    /// @param releaseOnExpiry True permits seller release at expiry; false permits buyer refund.
    /// @param ref Public reference; do not include private information.
    /// @return id New escrow id.
    function createEscrow(
        address token, address seller, address arbiter, uint256 amount,
        uint256 releaseDeadline, bool releaseOnExpiry, bytes32 ref
    ) external nonReentrant whenNotPaused returns (uint256 id) {
        if (!supportedTokens[token]) revert UnsupportedToken(token);
        if (seller == address(0)) revert ZeroAddress();
        if (seller == msg.sender || seller == address(this)) revert InvalidActor(seller);
        if (arbiter != address(0) && (arbiter == msg.sender || arbiter == seller || arbiter == address(this))) {
            revert InvalidActor(arbiter);
        }
        if (amount == 0) revert ZeroAmount();
        if (releaseDeadline <= block.timestamp
            || releaseDeadline - block.timestamp > MAX_DURATION - REFUND_GRACE_PERIOD) {
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

    /// @notice Seller accepts the Pending escrow's snapshotted terms before the release deadline.
    /// @param id Pending escrow id.
    function acceptEscrow(uint256 id) external nonReentrant {
        Escrow storage e = _inStatus(id, Status.Pending);
        if (msg.sender != e.seller) revert Unauthorized();
        if (block.timestamp >= e.releaseDeadline) revert ReleaseWindowClosed();
        e.status = Status.Funded;
        emit EscrowAccepted(id, msg.sender);
    }

    /// @notice Buyer withdraws or seller rejects a Pending escrow, refunding the buyer in full.
    /// @dev Available at any time while Pending, including while creation is paused.
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

    /// @notice Refunds an undisputed escrow without a fee.
    /// @dev Seller may refund at any time. Buyer may refund only at or after refundDeadline
    /// when releaseOnExpiry is false. A permitted actor must submit a transaction.
    /// @param id Funded escrow id.
    function refund(uint256 id) external nonReentrant {
        Escrow storage e = _inStatus(id, Status.Funded);
        if (msg.sender != e.seller) {
            if (msg.sender != e.buyer) revert Unauthorized();
            if (block.timestamp < e.refundDeadline || e.releaseOnExpiry) revert RefundNotAvailable();
        }
        _settle(id, e, false);
    }

    /// @notice Anyone releases an undisputed escrow at expiry when its terms require seller payment.
    /// @param id Funded escrow id.
    function releaseExpired(uint256 id) external nonReentrant {
        Escrow storage e = _inStatus(id, Status.Funded);
        if (!e.releaseOnExpiry || block.timestamp < e.refundDeadline) revert ExpiryReleaseNotAvailable(id);
        _settle(id, e, true);
    }

    /// @notice Buyer or seller opens a dispute before refundDeadline if an arbiter exists.
    /// @dev Once disputed, ordinary settlement is disabled; resolve or a timeout split can settle.
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

    /// @notice Only the nominated arbiter can resolve a disputed escrow, at any time while Disputed.
    /// @param id Disputed escrow id.
    /// @param toSeller True releases minus the stored fee; false refunds the buyer in full.
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

    /// @notice Withdraws the caller's entire deferred payout credit to a chosen recipient.
    /// @dev Clears credit before transfer; a failed transfer reverts and preserves the credit.
    /// @param token Underlying ERC-20 contract for the credit.
    /// @param to Nonzero recipient other than this contract.
    /// @return amount Credit successfully withdrawn, in raw token units.
    function claim(address token, address to) external nonReentrant returns (uint256 amount) {
        if (to == address(0)) revert ZeroAddress();
        if (to == address(this)) revert InvalidActor(to);
        amount = claimable[token][msg.sender];
        if (amount == 0) revert NothingToClaim();
        claimable[token][msg.sender] = 0;
        totalPending[token] -= amount;
        IERC20(token).safeTransfer(to, amount);
        emit Claimed(token, msg.sender, to, amount);
    }

    /// @notice Returns the full agreement and status; unknown ids revert.
    /// @param id Escrow id.
    /// @return Agreement Stored terms and lifecycle state.
    function getEscrow(uint256 id) external view returns (Escrow memory Agreement) {
        if (_escrows[id].status == Status.None) revert UnknownEscrow(id);
        return _escrows[id];
    }

    /// @notice Counts escrows where user is buyer or seller; arbitrator-only roles are not indexed.
    /// @param user Account whose history to inspect.
    /// @return count Total entries, including terminal escrows.
    function escrowCount(address user) external view returns (uint256 count) {
        return _userIds[user].length;
    }

    /// @notice Returns buyer/seller escrow ids, oldest first, without duplicates per escrow.
    /// @param user Account whose history to inspect.
    /// @param offset Zero-based starting index; past-end returns an empty page.
    /// @param limit Maximum entries, at most MAX_PAGE_SIZE; zero returns an empty page.
    /// @return ids Selected ids, clamped to available entries.
    function escrowsOf(address user, uint256 offset, uint256 limit) external view returns (uint256[] memory ids) {
        if (limit > MAX_PAGE_SIZE) revert PageTooLarge();
        uint256 length = _userIds[user].length;
        uint256 size = offset >= length ? 0 : Math.min(limit, length - offset);
        ids = new uint256[](size);
        for (uint256 i; i < size; ++i) ids[i] = _userIds[user][offset + i];
    }

    /// @dev No settlement function checks the current allowlist, owner settings or pause state.
    /// Terminal status is set before payouts; failed transfers become account-owned credits.
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

    /// @dev Attempts a payout without reverting on transfer failure; zero amounts are skipped.
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

    /// @dev Separate emission helper keeps the funding entry point simple.
    function _emitCreated(uint256 id, Escrow storage e) private {
        emit EscrowCreated(
            id, e.buyer, e.seller, e.token, e.arbiter, e.amount, e.releaseDeadline,
            e.refundDeadline, e.fee, e.feeCollector, e.releaseOnExpiry, e.ref
        );
    }
}
