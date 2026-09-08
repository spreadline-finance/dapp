// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {SpreadlineVault, IERC20, IV3Router} from "../src/SpreadlineVault.sol";

contract TestToken is IERC20 {
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;
    bool public fee;
    bool public falseReturn;
    address public callbackTarget;
    bytes public callbackData;
    bool public callbackSucceeded;
    function mint(address account, uint256 amount) external { balanceOf[account] += amount; }
    function setFee(bool next) external { fee = next; }
    function setFalseReturn(bool next) external { falseReturn = next; }
    function setCallback(address target, bytes memory data) external { callbackTarget = target; callbackData = data; }
    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        return !falseReturn;
    }
    function transfer(address receiver, uint256 amount) external returns (bool) {
        _transfer(msg.sender, receiver, amount);
        return !falseReturn;
    }
    function transferFrom(address sender, address receiver, uint256 amount) external returns (bool) {
        allowance[sender][msg.sender] -= amount;
        _transfer(sender, receiver, amount);
        if (callbackTarget != address(0)) (callbackSucceeded,) = callbackTarget.call(callbackData);
        return !falseReturn;
    }
    function _transfer(address sender, address receiver, uint256 amount) private {
        balanceOf[sender] -= amount;
        balanceOf[receiver] += fee && amount > 0 ? amount - 1 : amount;
    }
}

contract TestRouter is IV3Router {
    address public immutable settlement;
    int256 public profit;
    bool public enforceMinimum = true;
    bool public lieAboutReturn;
    uint256 public calls;
    uint256 public lastBuyAmount;
    uint256 public lastSellAmount;
    constructor(address settlement_) { settlement = settlement_; }
    function configure(int256 profit_, bool enforceMinimum_, bool lie_) external {
        profit = profit_;
        enforceMinimum = enforceMinimum_;
        lieAboutReturn = lie_;
    }
    function exactInputSingle(ExactInputSingleParams calldata params) external payable returns (uint256 result) {
        calls++;
        IERC20(params.tokenIn).transferFrom(msg.sender, address(this), params.amountIn);
        if (params.tokenIn == settlement) {
            result = params.amountIn;
            lastBuyAmount = params.amountIn;
        } else {
            result = uint256(int256(params.amountIn) + profit);
            lastSellAmount = params.amountIn;
        }
        if (enforceMinimum) require(result >= params.amountOutMinimum, "router slippage");
        TestToken(params.tokenOut).mint(params.recipient, result);
        if (lieAboutReturn) return type(uint256).max;
    }
}

contract VaultUser {
    function approve(TestToken token, SpreadlineVault vault, uint256 assets) external { token.approve(address(vault), assets); }
    function deposit(SpreadlineVault vault, uint256 assets, uint256 minShares) external returns (uint256) {
        return vault.deposit(assets, address(this), minShares);
    }
    function withdraw(SpreadlineVault vault, uint256 shares, uint256 minAssets) external returns (uint256) {
        return vault.withdraw(shares, address(this), minAssets);
    }
    function claim(SpreadlineVault vault) external returns (uint256) { return vault.claim(address(this)); }
    function donate(TestToken token, SpreadlineVault vault, uint256 assets) external { token.transfer(address(vault), assets); }
    function tryCall(address target, bytes calldata data) external returns (bool, bytes memory) { return target.call(data); }
}

contract SpreadlineVaultTest {
    TestToken private cash;
    TestToken private stock;
    TestRouter private router;
    SpreadlineVault private vault;
    VaultUser private alice;
    VaultUser private bob;
    uint256 private constant U = 1e6;

    function setUp() public {
        cash = new TestToken();
        stock = new TestToken();
        router = new TestRouter(address(cash));
        vault = new SpreadlineVault(address(cash), address(router), address(this), address(this), 1_000_000 * U);
        alice = new VaultUser();
        bob = new VaultUser();
        cash.mint(address(alice), 1e24);
        cash.mint(address(bob), 1e24);
        alice.approve(cash, vault, type(uint256).max);
        bob.approve(cash, vault, type(uint256).max);
        vault.setAllowedToken(address(stock), true);
    }

    function testDepositsAndWithdrawalsRemainAvailableWhilePaused() public {
        require(vault.paused(), "starts paused");
        uint256 a = _deposit(alice, 1_000 * U);
        uint256 b = _deposit(bob, 2_000 * U);
        _eq(vault.totalShares(), a + b);
        _eq(vault.managedAssets(), 3_000 * U);
        _eq(vault.earned(address(alice)), 0);
        _eq(alice.withdraw(vault, a, 1_000 * U), 1_000 * U);
        _eq(bob.withdraw(vault, b, 2_000 * U), 2_000 * U);
        _eq(vault.totalShares(), 0);
        _eq(vault.managedAssets(), 0);
        _eq(vault.totalDeposited(), vault.totalWithdrawn());
    }

    function testProfitableTradeFundsRewardsAndRetainsCapital() public {
        _deposit(alice, 1_000 * U);
        _trade(100 * U);
        _eq(vault.totalRealizedProfit(), 100 * U);
        _eq(vault.totalRewardsReserved(), 75 * U);
        _eq(vault.earned(address(alice)), 75 * U);
        _eq(vault.managedAssets(), 1_025 * U);
        _eq(cash.allowance(address(vault), address(router)), 0);
        _eq(stock.allowance(address(vault), address(router)), 0);
        _eq(router.lastBuyAmount(), router.lastSellAmount());
        _eq(alice.claim(vault), 75 * U);
        _eq(vault.managedAssets(), 1_025 * U);
        _eq(vault.totalRewardsReserved(), 0);
        _eq(vault.totalClaimed(), 75 * U);
        _expectUserRevert(alice, abi.encodeCall(vault.claim, (address(alice))), SpreadlineVault.InvalidAmount.selector);
    }

    function testNewDepositsCannotClaimOldRewards() public {
        uint256 a = _deposit(alice, 1_000 * U);
        _trade(100 * U);
        uint256 expected = vault.previewDeposit(1_000 * U);
        uint256 b = _deposit(bob, 1_000 * U);
        _eq(b, expected);
        require(b < a, "retained profit increases share price");
        _eq(vault.earned(address(bob)), 0);
        _eq(vault.earned(address(alice)), 75 * U);
        _trade(100 * U);
        uint256 bEarned = vault.earned(address(bob));
        uint256 expectedBob = 75 * U * b / (a + b);
        require(bEarned <= expectedBob && expectedBob - bEarned <= 1, "new epoch allocation");
        uint256 aEarned = vault.earned(address(alice));
        require(aEarned + bEarned <= 150 * U, "cash covers claims");
        _eq(alice.claim(vault), aEarned);
        _eq(bob.claim(vault), bEarned);
        _eq(vault.totalClaimed() + vault.totalRewardsReserved(), 150 * U);
    }

    function testWithdrawThenClaimPreservesAccruedRewards() public {
        uint256 shares = _deposit(alice, 1_000 * U);
        _trade(100 * U);
        uint256 assets = vault.previewRedeem(shares);
        _eq(alice.withdraw(vault, shares, assets), assets);
        _eq(vault.sharesOf(address(alice)), 0);
        _eq(vault.earned(address(alice)), 75 * U);
        _eq(alice.claim(vault), 75 * U);
        _eq(vault.totalShares(), 0);
        require(vault.managedAssets() <= 1, "bounded ordinary final redemption dust");
    }

    function testLosingTradeRevertsBothLegsAndAccounting() public {
        _deposit(alice, 1_000 * U);
        vault.setPaused(false);
        router.configure(-int256(10 * U), false, false);
        uint256 beforeCash = cash.balanceOf(address(vault));
        _expectRevert(address(vault), _tradeData(1), SpreadlineVault.InsufficientProfit.selector);
        _eq(cash.balanceOf(address(vault)), beforeCash);
        _eq(stock.balanceOf(address(vault)), 0);
        _eq(router.calls(), 0);
        _eq(vault.totalRealizedProfit(), 0);
        _eq(vault.totalRewardsReserved(), 0);
        _eq(cash.allowance(address(vault), address(router)), 0);
    }

    function testMinimumProfitCannotBeBypassed() public {
        _deposit(alice, 1_000 * U);
        vault.setPaused(false);
        vault.setRiskLimits(100 * U, 10 * U, 60);
        router.configure(int256(5 * U), false, false);
        _expectRevert(address(vault), _tradeData(1), SpreadlineVault.InvalidAmount.selector);
        _expectRevert(address(vault), _tradeData(10 * U), SpreadlineVault.InsufficientProfit.selector);
        _eq(vault.totalRealizedProfit(), 0);
    }

    function testRouterReturnValueCannotInventEarnings() public {
        _deposit(alice, 1_000 * U);
        vault.setPaused(false);
        router.configure(int256(3 * U), true, true);
        _eq(vault.executeArbitrage(address(stock), 500, 3000, 100 * U, 1, 1, block.timestamp + 60), 3 * U);
        _eq(vault.totalRealizedProfit(), 3 * U);
    }

    function testExistingStockDonationIsNotSpent() public {
        _deposit(alice, 1_000 * U);
        stock.mint(address(vault), 17 * U);
        _trade(10 * U);
        _eq(stock.balanceOf(address(vault)), 17 * U);
        _eq(router.lastSellAmount(), 100 * U);
    }

    function testUnauthorizedUsersCannotTradeOrChangePolicy() public {
        _deposit(alice, 1_000 * U);
        vault.setPaused(false);
        _expectUserRevert(alice, _tradeData(1), SpreadlineVault.Unauthorized.selector);
        _expectUserRevert(alice, abi.encodeCall(vault.setPaused, (false)), SpreadlineVault.Unauthorized.selector);
        _expectUserRevert(alice, abi.encodeCall(vault.setOperator, (address(alice))), SpreadlineVault.Unauthorized.selector);
        _expectUserRevert(alice, abi.encodeCall(vault.setAllowedToken, (address(stock), false)), SpreadlineVault.Unauthorized.selector);
        _expectUserRevert(alice, abi.encodeCall(vault.setRiskLimits, (1, 1, 1)), SpreadlineVault.Unauthorized.selector);
    }

    function testNoOwnerOrOperatorPrincipalWithdrawal() public {
        _deposit(alice, 1_000 * U);
        _expectRevert(address(vault), abi.encodeCall(vault.withdraw, (vault.totalShares(), address(this), 1)), SpreadlineVault.InvalidAmount.selector);
        (bool withdrawn,) = address(vault).call(abi.encodeWithSignature("withdrawAll(address)", address(this)));
        require(!withdrawn, "no admin sweep");
        (bool arbitrary,) = address(vault).call(abi.encodeWithSignature("execute(address,bytes)", address(cash), abi.encodeCall(cash.transfer, (address(this), U))));
        require(!arbitrary, "no arbitrary call");
        _eq(vault.managedAssets(), 1_000 * U);
    }

    function testExecutionRiskGuards() public {
        _deposit(alice, 1_000 * U);
        _expectRevert(address(vault), _tradeData(1), SpreadlineVault.ExecutionPaused.selector);
        vault.setPaused(false);
        _expectRevert(address(vault), abi.encodeCall(vault.executeArbitrage, (address(stock), 500, 500, U, 1, 1, block.timestamp)), SpreadlineVault.InvalidRoute.selector);
        _expectRevert(address(vault), abi.encodeCall(vault.executeArbitrage, (address(stock), 123, 500, U, 1, 1, block.timestamp)), SpreadlineVault.InvalidRoute.selector);
        _expectRevert(address(vault), abi.encodeCall(vault.executeArbitrage, (address(cash), 100, 500, U, 1, 1, block.timestamp)), SpreadlineVault.InvalidRoute.selector);
        _expectRevert(address(vault), abi.encodeCall(vault.executeArbitrage, (address(stock), 100, 500, U, 1, 1, block.timestamp + 121)), SpreadlineVault.Expired.selector);
        _expectRevert(address(vault), abi.encodeCall(vault.executeArbitrage, (address(stock), 100, 500, 1_001 * U, 1, 1, block.timestamp)), SpreadlineVault.InvalidAmount.selector);
        vault.setRiskLimits(10 * U, 1, 60);
        _expectRevert(address(vault), _tradeData(1), SpreadlineVault.InvalidAmount.selector);
    }

    function testReservedRewardsCannotFundTrades() public {
        _deposit(alice, 100 * U);
        _trade(100 * U);
        _eq(vault.managedAssets(), 125 * U);
        _expectRevert(address(vault), abi.encodeCall(vault.executeArbitrage, (address(stock), 100, 500, 126 * U, 1, 1, block.timestamp)), SpreadlineVault.InvalidAmount.selector);
        _eq(vault.totalRewardsReserved(), 75 * U);
    }

    function testDonationDoesNotCountAsProfit() public {
        _deposit(alice, 1_000 * U);
        bob.donate(cash, vault, 100 * U);
        _eq(vault.managedAssets(), 1_100 * U);
        _eq(vault.totalRealizedProfit(), 0);
        _eq(vault.earned(address(alice)), 0);
    }

    function testDonationFrontRunFailsUserShareMinimum() public {
        _deposit(alice, 1);
        uint256 expected = vault.previewDeposit(100 * U);
        alice.donate(cash, vault, 1_000 * U);
        _expectRevert(address(bob), abi.encodeCall(bob.deposit, (vault, 100 * U, expected * 999 / 1000)), SpreadlineVault.Slippage.selector);
        _eq(vault.sharesOf(address(bob)), 0);
    }

    function testVirtualSharesMakeInflationAttackUnprofitable() public {
        uint256 initial = cash.balanceOf(address(alice));
        uint256 attackerShares = _deposit(alice, 1);
        alice.donate(cash, vault, 1e15);
        uint256 victimShares = _deposit(bob, 1_000 * U);
        bob.withdraw(vault, victimShares, 1);
        alice.withdraw(vault, attackerShares, 1);
        require(cash.balanceOf(address(alice)) < initial, "donation cannot be recovered from victim");
    }

    function testTransferFeeAndFalseReturnRejected() public {
        cash.setFee(true);
        _expectRevert(address(alice), abi.encodeCall(alice.deposit, (vault, 1_000 * U, 1)), SpreadlineVault.UnsupportedToken.selector);
        _eq(vault.totalShares(), 0);
        cash.setFee(false);
        cash.setFalseReturn(true);
        _expectRevert(address(alice), abi.encodeCall(alice.deposit, (vault, 1_000 * U, 1)), SpreadlineVault.TokenTransferFailed.selector);
        _eq(vault.totalShares(), 0);
    }

    function testTokenCallbackCannotReenter() public {
        cash.setCallback(address(vault), abi.encodeCall(vault.claim, (address(cash))));
        _deposit(alice, 1_000 * U);
        require(!cash.callbackSucceeded(), "no callback reentrancy");
        _eq(vault.managedAssets(), 1_000 * U);
    }

    function testWithdrawMinimumAndReceiverGuards() public {
        uint256 shares = _deposit(alice, 100 * U);
        _expectUserRevert(alice, abi.encodeCall(vault.withdraw, (shares, address(alice), 101 * U)), SpreadlineVault.Slippage.selector);
        _expectUserRevert(alice, abi.encodeCall(vault.withdraw, (shares, address(vault), 1)), SpreadlineVault.InvalidReceiver.selector);
        _expectUserRevert(alice, abi.encodeCall(vault.deposit, (U, address(0), 1)), SpreadlineVault.InvalidReceiver.selector);
        _expectUserRevert(alice, abi.encodeCall(vault.withdraw, (shares, address(alice), 0)), SpreadlineVault.InvalidAmount.selector);
        _eq(vault.sharesOf(address(alice)), shares);
    }

    function testTwoStepOwnerRotation() public {
        vault.transferOwnership(address(alice));
        _eq(uint256(uint160(vault.owner())), uint256(uint160(address(this))));
        _expectUserRevert(bob, abi.encodeCall(vault.acceptOwnership, ()), SpreadlineVault.Unauthorized.selector);
        (bool accepted,) = alice.tryCall(address(vault), abi.encodeCall(vault.acceptOwnership, ()));
        require(accepted && vault.owner() == address(alice), "new owner accepted");
        _expectRevert(address(vault), abi.encodeCall(vault.setPaused, (false)), SpreadlineVault.Unauthorized.selector);
    }

    function testFuzzCashBacksAllClaimsAndWithdrawals(uint96 rawA, uint96 rawB, uint80 rawProfit, uint8 rawRounds) public {
        uint256 aAssets = uint256(rawA) % (1_000_000 * U) + 100 * U;
        uint256 bAssets = uint256(rawB) % (1_000_000 * U) + 100 * U;
        uint256 profit = uint256(rawProfit) % (100_000 * U) + 4;
        uint256 rounds = uint256(rawRounds) % 12 + 1;
        _deposit(alice, aAssets);
        _trade(profit);
        _deposit(bob, bAssets);
        for (uint256 i; i < rounds; i++) {
            _trade(profit + i);
            uint256 aliceEarned = vault.earned(address(alice));
            if (aliceEarned > 0) alice.claim(vault);
            if (i % 2 == 0) {
                uint256 partialShares = vault.sharesOf(address(bob)) / 3;
                if (partialShares > 0 && vault.previewRedeem(partialShares) > 0) bob.withdraw(vault, partialShares, 1);
                _deposit(bob, 17 + i);
            }
            require(vault.earned(address(alice)) + vault.earned(address(bob)) <= vault.totalRewardsReserved(), "reward solvency");
            _eq(cash.balanceOf(address(vault)), vault.managedAssets() + vault.totalRewardsReserved());
        }
        uint256 aShares = vault.sharesOf(address(alice));
        uint256 bShares = vault.sharesOf(address(bob));
        if (aShares > 0) alice.withdraw(vault, aShares, 1);
        if (bShares > 0) bob.withdraw(vault, bShares, 1);
        if (vault.earned(address(alice)) > 0) alice.claim(vault);
        if (vault.earned(address(bob)) > 0) bob.claim(vault);
        _eq(vault.totalShares(), 0);
        _eq(vault.totalDeposited() + vault.totalRealizedProfit(), vault.totalWithdrawn() + vault.totalClaimed() + cash.balanceOf(address(vault)));
        require(vault.totalClaimed() <= vault.totalRealizedProfit() * 3 / 4, "no unfunded payouts");
    }

    function _deposit(VaultUser user, uint256 assets) private returns (uint256) {
        return user.deposit(vault, assets, vault.previewDeposit(assets));
    }
    function _trade(uint256 profit) private {
        vault.setPaused(false);
        router.configure(int256(profit), true, false);
        vault.executeArbitrage(address(stock), 500, 3000, 100 * U, 1, 1, block.timestamp + 60);
    }
    function _tradeData(uint256 minProfit) private view returns (bytes memory) {
        return abi.encodeCall(vault.executeArbitrage, (address(stock), 500, 3000, 100 * U, 1, minProfit, block.timestamp + 60));
    }
    function _expectUserRevert(VaultUser user, bytes memory data, bytes4 selector) private {
        (bool success, bytes memory result) = user.tryCall(address(vault), data);
        require(!success && result.length >= 4 && bytes4(result) == selector, "expected user revert");
    }
    function _expectRevert(address target, bytes memory data, bytes4 selector) private {
        (bool success, bytes memory result) = target.call(data);
        require(!success && result.length >= 4 && bytes4(result) == selector, "expected revert");
    }
    function _eq(uint256 actual, uint256 expected) private pure { require(actual == expected, "not equal"); }
}
