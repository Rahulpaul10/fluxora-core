// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Test} from "forge-std/Test.sol";
import {FluxoraPayments} from "../src/FluxoraPayments.sol";
import {MockERC20} from "./helpers/MockERC20.sol";

contract PaymentsHandler is Test {
    FluxoraPayments public pay;
    MockERC20 public token;
    address public admin;
    address public pauser;
    address[] public actors;
    uint256 public totalMinted;
    uint256 public totalFees;
    uint256 public maxFeeRatioViolations;
    uint256[] public openRequests;

    constructor(FluxoraPayments pay_, MockERC20 token_, address admin_, address pauser_) {
        pay = pay_;
        token = token_;
        admin = admin_;
        pauser = pauser_;
        for (uint256 i; i < 4; ++i) {
            address a = address(uint160(0xA000 + i));
            actors.push(a);
            token.mint(a, 1e12);
            totalMinted += 1e12;
            vm.prank(a);
            token.approve(address(pay), type(uint256).max);
        }
    }

    function actorCount() external view returns (uint256) { return actors.length; }

    function doPay(uint256 fromSeed, uint256 toSeed, uint256 amount) external {
        address from = actors[fromSeed % actors.length];
        address to = actors[toSeed % actors.length];
        if (from == to) return;
        amount = bound(amount, 1, 1e9);
        uint256 fee = pay.quoteFee(amount);
        if (token.balanceOf(from) < amount + fee) return;
        if (pay.paused()) return;
        vm.prank(from);
        pay.pay(address(token), to, amount, bytes32(0), "", fee);
        totalFees += fee;
        // fee <= ceil(1% of amount)
        if (fee > amount / 100 + 1) maxFeeRatioViolations++;
        if (pay.feeBps() == 0 && fee != 0) maxFeeRatioViolations++;
    }

    function createRequest(uint256 creatorSeed, uint256 amount) external {
        if (pay.paused()) return;
        address creator = actors[creatorSeed % actors.length];
        amount = bound(amount, 1, 1e9);
        vm.prank(creator);
        openRequests.push(pay.createRequest(address(token), amount, 0, bytes32(0), ""));
    }

    function payRequest(uint256 payerSeed, uint256 idx) external {
        if (openRequests.length == 0 || pay.paused()) return;
        uint256 rid = openRequests[idx % openRequests.length];
        FluxoraPayments.Request memory q = pay.getRequest(rid);
        address payer = actors[payerSeed % actors.length];
        if (q.status != FluxoraPayments.RequestStatus.Open || payer == q.creator) return;
        uint256 fee = pay.quoteFee(q.amount);
        if (token.balanceOf(payer) < q.amount + fee) return;
        vm.prank(payer);
        pay.payRequest(rid, fee);
        totalFees += fee;
    }

    function setFee(uint256 bps) external {
        bps = bound(bps, 0, 100);
        vm.startPrank(admin);
        if (pay.feeRecipient() == address(0)) pay.setFeeRecipient(address(0xFEE));
        pay.setFeeBps(bps);
        vm.stopPrank();
    }

    function togglePause(bool p) external {
        vm.startPrank(pauser);
        if (p && !pay.paused()) pay.pause();
        else if (!p && pay.paused()) pay.unpause();
        vm.stopPrank();
    }
}

contract FluxoraPaymentsInvariantTest is Test {
    FluxoraPayments internal pay;
    MockERC20 internal token;
    PaymentsHandler internal handler;
    address internal admin = makeAddr("admin");
    address internal pauser = makeAddr("pauser");

    function setUp() public {
        token = new MockERC20("USD Coin", "USDC", 6);
        address[] memory tokens = new address[](1);
        tokens[0] = address(token);
        pay = new FluxoraPayments(admin, pauser, tokens);
        handler = new PaymentsHandler(pay, token, admin, pauser);
        targetContract(address(handler));
    }

    /// Payments is non-custodial: it never holds token balance.
    function invariant_PaymentsNeverHoldsTokens() public view {
        assertEq(token.balanceOf(address(pay)), 0);
    }

    /// Fee never exceeds 1% of amount (ceil rounding allows at most one extra unit).
    function invariant_FeeNeverAboveOnePercentPlusRounding() public view {
        assertEq(handler.maxFeeRatioViolations(), 0);
        assertLe(pay.feeBps(), pay.MAX_FEE_BPS());
    }

    /// Value is conserved: all minted tokens are held by actors + the fee collector.
    function invariant_TokensConserved() public view {
        uint256 sum = token.balanceOf(address(0xFEE));
        for (uint256 i; i < handler.actorCount(); ++i) sum += token.balanceOf(handler.actors(i));
        assertEq(sum, handler.totalMinted());
        assertEq(token.balanceOf(address(0xFEE)), handler.totalFees());
    }
}
