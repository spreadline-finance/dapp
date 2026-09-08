// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

interface IERC20 {
    function balanceOf(address account) external view returns (uint256);
    function transfer(address to, uint256 amount) external returns (bool);
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
    function approve(address spender, uint256 amount) external returns (bool);
}

// SwapRouter02 interface. The vault applies its own transaction deadline.
interface IV3Router {
    struct ExactInputSingleParams {
        address tokenIn;
        address tokenOut;
        uint24 fee;
        address recipient;
        uint256 amountIn;
        uint256 amountOutMinimum;
        uint160 sqrtPriceLimitX96;
    }
    function exactInputSingle(ExactInputSingleParams calldata params) external payable returns (uint256);
}

/// @notice Settlement-only capital vault with atomic V3 round trips and cash-funded rewards.
/// @dev Unaudited. Shares are nontransferable. Only plain, non-rebasing ERC20 tokens are supported.
///      Gas is paid by the operator externally; reported profit is settlement trading surplus.
contract SpreadlineVault {
    uint256 public constant VIRTUAL_SHARES = 1_000_000;
    uint256 private constant INDEX_SCALE = 1e27;
    uint256 public constant REWARD_BPS = 7_500;
    address public immutable settlement;
    address public immutable router;
    address public owner;
    address public pendingOwner;
    address public operator;
    uint256 public maxTradeAssets;
    uint256 public minimumProfitAssets = 1;
    uint256 public maxDeadlineSeconds = 120;
    bool public paused = true;
    uint256 public totalShares;
    uint256 public totalRewardsReserved;
    uint256 public totalRealizedProfit;
    uint256 public totalClaimed;
    uint256 public totalDeposited;
    uint256 public totalWithdrawn;
    uint256 public rewardIndex;
    mapping(address => uint256) public sharesOf;
    mapping(address => bool) public allowedTokens;
    mapping(address => uint256) private accountIndex;
    mapping(address => uint256) private pendingScaled;
    uint256 private entered;

    error Unauthorized();
    error InvalidConfiguration();
    error InvalidAmount();
    error InvalidReceiver();
    error Slippage();
    error Reentrancy();
    error UnsupportedToken();
    error ExecutionPaused();
    error InvalidRoute();
    error Expired();
    error InsufficientProfit();
    error TokenTransferFailed();

    event Deposited(address indexed caller, address indexed receiver, uint256 assets, uint256 shares);
    event Withdrawn(address indexed caller, address indexed receiver, uint256 assets, uint256 shares);
    event RewardsClaimed(address indexed account, address indexed receiver, uint256 assets);
    event ArbitrageExecuted(address indexed operator, address indexed stock, uint24 buyFee, uint24 sellFee,
        uint256 assetsIn, uint256 profit, uint256 rewards, uint256 retained);
    event OperatorUpdated(address indexed operator);
    event TokenPermissionUpdated(address indexed token, bool allowed);
    event RiskLimitsUpdated(uint256 maxTradeAssets, uint256 minimumProfitAssets, uint256 maxDeadlineSeconds);
    event PauseUpdated(bool paused);
    event OwnershipProposed(address indexed pendingOwner);
    event OwnershipTransferred(address indexed owner);

    modifier nonReentrant() {
        if (entered != 0) revert Reentrancy();
        entered = 1;
        _;
        entered = 0;
    }

    modifier onlyOwner() {
        if (msg.sender != owner) revert Unauthorized();
        _;
    }

    constructor(address settlement_, address router_, address owner_, address operator_, uint256 maxTradeAssets_) {
        if (settlement_.code.length == 0 || router_.code.length == 0 || owner_ == address(0)
            || operator_ == address(0) || maxTradeAssets_ == 0) revert InvalidConfiguration();
        settlement = settlement_;
        router = router_;
        owner = owner_;
        operator = operator_;
        maxTradeAssets = maxTradeAssets_;
    }

    /// @notice Cash backing shares. Previously allocated, unclaimed rewards are excluded.
    function managedAssets() public view returns (uint256) {
        return IERC20(settlement).balanceOf(address(this)) - totalRewardsReserved;
    }

    /// @dev Virtual assets/shares protect initial depositors from donation-based share inflation.
    function previewDeposit(uint256 assets) public view returns (uint256) {
        return assets * (totalShares + VIRTUAL_SHARES) / (managedAssets() + 1);
    }

    function previewRedeem(uint256 shares) public view returns (uint256) {
        return shares * (managedAssets() + 1) / (totalShares + VIRTUAL_SHARES);
    }

    function earned(address account) public view returns (uint256) {
        return (pendingScaled[account] + sharesOf[account] * (rewardIndex - accountIndex[account])) / INDEX_SCALE;
    }

    function deposit(uint256 assets, address receiver, uint256 minShares) external nonReentrant returns (uint256 shares) {
        _receiver(receiver);
        if (assets == 0 || minShares == 0) revert InvalidAmount();
        shares = previewDeposit(assets);
        if (shares == 0 || shares < minShares) revert Slippage();
        _accrue(receiver);
        uint256 beforeBalance = IERC20(settlement).balanceOf(address(this));
        _callToken(settlement, abi.encodeCall(IERC20.transferFrom, (msg.sender, address(this), assets)));
        if (IERC20(settlement).balanceOf(address(this)) != beforeBalance + assets) revert UnsupportedToken();
        sharesOf[receiver] += shares;
        totalShares += shares;
        totalDeposited += assets;
        emit Deposited(msg.sender, receiver, assets, shares);
    }

    function withdraw(uint256 shares, address receiver, uint256 minAssets) external nonReentrant returns (uint256 assets) {
        _receiver(receiver);
        if (shares == 0 || shares > sharesOf[msg.sender] || minAssets == 0) revert InvalidAmount();
        assets = previewRedeem(shares);
        if (assets == 0 || assets < minAssets) revert Slippage();
        _accrue(msg.sender);
        sharesOf[msg.sender] -= shares;
        totalShares -= shares;
        totalWithdrawn += assets;
        _pay(receiver, assets);
        emit Withdrawn(msg.sender, receiver, assets, shares);
    }

    function claim(address receiver) external nonReentrant returns (uint256 assets) {
        _receiver(receiver);
        _accrue(msg.sender);
        assets = pendingScaled[msg.sender] / INDEX_SCALE;
        if (assets == 0) revert InvalidAmount();
        pendingScaled[msg.sender] -= assets * INDEX_SCALE;
        totalRewardsReserved -= assets;
        totalClaimed += assets;
        _pay(receiver, assets);
        emit RewardsClaimed(msg.sender, receiver, assets);
    }

    /// @notice Buy and sell the exact newly acquired stock balance in one transaction.
    /// @dev An insufficient final cash balance reverts both swaps and reward accounting.
    function executeArbitrage(address stock, uint24 buyFee, uint24 sellFee, uint256 assetsIn,
        uint256 minStockOut, uint256 minProfit, uint256 deadline) external nonReentrant returns (uint256 profit) {
        if (msg.sender != operator) revert Unauthorized();
        if (paused) revert ExecutionPaused();
        if (!allowedTokens[stock] || stock == settlement || buyFee == sellFee
            || !_fee(buyFee) || !_fee(sellFee)) revert InvalidRoute();
        if (deadline < block.timestamp || deadline > block.timestamp + maxDeadlineSeconds) revert Expired();
        if (assetsIn == 0 || assetsIn > maxTradeAssets || assetsIn > managedAssets() || minStockOut == 0
            || minProfit < minimumProfitAssets || totalShares == 0) revert InvalidAmount();
        uint256 cashBefore = IERC20(settlement).balanceOf(address(this));
        uint256 stockBefore = IERC20(stock).balanceOf(address(this));
        _approve(settlement, assetsIn);
        IV3Router(router).exactInputSingle(IV3Router.ExactInputSingleParams({tokenIn: settlement, tokenOut: stock,
            fee: buyFee, recipient: address(this), amountIn: assetsIn, amountOutMinimum: minStockOut, sqrtPriceLimitX96: 0}));
        _approve(settlement, 0);
        uint256 stockBought = IERC20(stock).balanceOf(address(this)) - stockBefore;
        if (stockBought < minStockOut) revert Slippage();
        _approve(stock, stockBought);
        IV3Router(router).exactInputSingle(IV3Router.ExactInputSingleParams({tokenIn: stock, tokenOut: settlement,
            fee: sellFee, recipient: address(this), amountIn: stockBought,
            amountOutMinimum: assetsIn + minProfit, sqrtPriceLimitX96: 0}));
        _approve(stock, 0);
        uint256 cashAfter = IERC20(settlement).balanceOf(address(this));
        if (cashAfter < cashBefore + minProfit) revert InsufficientProfit();
        if (IERC20(stock).balanceOf(address(this)) != stockBefore) revert UnsupportedToken();
        profit = cashAfter - cashBefore;
        uint256 rewards = profit * REWARD_BPS / 10_000;
        // Reserve the entire reward budget. Fractions stay reserved, never become new income.
        totalRewardsReserved += rewards;
        rewardIndex += rewards * INDEX_SCALE / totalShares;
        totalRealizedProfit += profit;
        emit ArbitrageExecuted(msg.sender, stock, buyFee, sellFee, assetsIn, profit, rewards, profit - rewards);
    }

    function setOperator(address nextOperator) external onlyOwner {
        if (nextOperator == address(0)) revert InvalidConfiguration();
        operator = nextOperator;
        emit OperatorUpdated(nextOperator);
    }

    function setAllowedToken(address token, bool allowed) external onlyOwner {
        if (token == settlement || token.code.length == 0) revert InvalidConfiguration();
        allowedTokens[token] = allowed;
        emit TokenPermissionUpdated(token, allowed);
    }

    function setRiskLimits(uint256 maxAssets, uint256 minProfitAssets, uint256 deadlineSeconds) external onlyOwner {
        if (maxAssets == 0 || minProfitAssets == 0 || deadlineSeconds == 0 || deadlineSeconds > 300) revert InvalidConfiguration();
        maxTradeAssets = maxAssets;
        minimumProfitAssets = minProfitAssets;
        maxDeadlineSeconds = deadlineSeconds;
        emit RiskLimitsUpdated(maxAssets, minProfitAssets, deadlineSeconds);
    }

    function setPaused(bool nextPaused) external onlyOwner {
        paused = nextPaused;
        emit PauseUpdated(nextPaused);
    }

    function transferOwnership(address nextOwner) external onlyOwner {
        if (nextOwner == address(0)) revert InvalidConfiguration();
        pendingOwner = nextOwner;
        emit OwnershipProposed(nextOwner);
    }

    function acceptOwnership() external {
        if (msg.sender != pendingOwner) revert Unauthorized();
        owner = pendingOwner;
        pendingOwner = address(0);
        emit OwnershipTransferred(owner);
    }

    function _accrue(address account) private {
        pendingScaled[account] += sharesOf[account] * (rewardIndex - accountIndex[account]);
        accountIndex[account] = rewardIndex;
    }

    function _receiver(address receiver) private view {
        if (receiver == address(0) || receiver == address(this)) revert InvalidReceiver();
    }

    function _pay(address receiver, uint256 amount) private {
        uint256 cashBefore = IERC20(settlement).balanceOf(address(this));
        uint256 receivedBefore = IERC20(settlement).balanceOf(receiver);
        _callToken(settlement, abi.encodeCall(IERC20.transfer, (receiver, amount)));
        if (IERC20(settlement).balanceOf(address(this)) + amount != cashBefore
            || IERC20(settlement).balanceOf(receiver) != receivedBefore + amount) revert UnsupportedToken();
    }

    function _approve(address token, uint256 amount) private {
        _callToken(token, abi.encodeCall(IERC20.approve, (router, 0)));
        if (amount != 0) _callToken(token, abi.encodeCall(IERC20.approve, (router, amount)));
    }

    function _callToken(address token, bytes memory data) private {
        (bool success, bytes memory result) = token.call(data);
        if (!success || (result.length != 0 && (result.length != 32 || !abi.decode(result, (bool))))) revert TokenTransferFailed();
    }

    function _fee(uint24 fee) private pure returns (bool) {
        return fee == 100 || fee == 500 || fee == 3000 || fee == 10000;
    }
}
