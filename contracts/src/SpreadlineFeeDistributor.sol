// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

interface IFeeRewardToken {
    function balanceOf(address account) external view returns (uint256);
    function transfer(address receiver, uint256 amount) external returns (bool);
    function transferFrom(address sender, address receiver, uint256 amount) external returns (bool);
}

interface IPonsFeeEscrow {
    function claim() external;
    function claimToken(address token) external;
}

interface IPonsFeeFactory {
    struct Launch {
        address token;
        address curve;
        address deployer;
        address creatorFeeRecipient;
        address pairToken;
        uint256 graduationThreshold;
        uint24 poolFee;
        int24 tickSpacing;
        uint16 creatorTaxBps;
        bool buybackEnabled;
        uint8 phase;
        uint256 sweptQuote;
        uint256 sweptTokens;
        uint256 sweptAt;
        bool exists;
    }
    function getLaunchedToken(address token) external view returns (Launch memory);
    function memeHook() external view returns (address);
    function feeEscrow() external view returns (address);
    function poolManager() external view returns (address);
}

interface IPonsFeeCurve {
    function token() external view returns (address);
    function pairToken() external view returns (address);
    function sweepFees(uint256 minBuybackTokensOut) external;
}

interface IPonsFeeHook {
    struct Launch {
        bool registered;
        bool memecoinIsCurrency0;
        address memecoin;
        address quoteToken;
        address creator;
        address buybackCreatorRecipient;
        address protocolFeeRecipient;
        uint16 creatorTaxBps;
        uint16 protocolFeeShareBps;
        uint16 buybackBurnBps;
        uint16 hookFeeBps;
        uint16 maxInternalPriceImpactBps;
        bool buybackEnabled;
    }
    function factory() external view returns (address);
    function poolManager() external view returns (address);
    function launches(bytes32 poolId) external view returns (Launch memory);
    function sweepPoolFees(bytes32 poolId, uint256 minConversionQuoteOut, uint256 minBuybackTokensOut) external;
}

/// @notice Cash-funded, delayed Merkle distributions for an external launchpad token's holders.
/// @dev UNAUDITED. The publisher is trusted to publish honest historical balances and exclusions.
///      This contract checks proofs and solvency, not the launch token's historical storage.
///      No deposits, promised yield, transfer tax, arbitrary calls or owner balance sweep.
contract SpreadlineFeeDistributor {
    uint256 public constant BPS = 10_000;
    uint256 public constant MAX_BATCH = 64;
    uint256 public constant MAX_PROOF = 64;
    uint256 public constant MAX_ACCOUNTING = type(uint128).max;
    uint64 public constant MIN_ROOT_DELAY = 15 minutes;
    uint64 public constant MAX_ROOT_DELAY = 7 days;
    uint64 public constant MIN_INTERVAL = 60;
    uint64 public constant MAX_INTERVAL = 30 days;
    uint256 public constant PAYOUT_GAS = 100_000;
    uint256 public constant BATCH_CLAIM_GAS = 350_000;

    struct Policy {
        uint16 holderBps;
        uint16 devBps;
        uint16 treasuryBps;
        uint64 intervalSeconds;
        uint64 rootDelaySeconds;
        uint256 minimumIncome;
        address devWallet;
        address treasuryWallet;
    }

    enum EpochState { Missing, Proposed, Active, Cancelled }

    struct Epoch {
        bytes32 root;
        bytes32 manifestHash;
        bytes32 snapshotBlockHash;
        uint256 snapshotBlock;
        uint256 totalEligibleWeight;
        uint256 grossIncome;
        uint256 holderBudget;
        uint256 holderPaid;
        uint256 devBudget;
        uint256 treasuryBudget;
        address devWallet;
        address treasuryWallet;
        uint64 policyVersion;
        uint64 proposedAt;
        uint64 readyAt;
        uint64 activatedAt;
        EpochState state;
    }

    struct Claim {
        uint256 epochId;
        address account;
        uint256 weight;
        bytes32[] proof;
    }

    // Zero until the owner binds the launchpad-created token, exactly once.
    address public holderToken;
    address public immutable rewardAsset;
    address public immutable ponsEscrow;
    address public immutable ponsFactory;
    address public immutable ponsHook;
    address public owner;
    address public pendingOwner;
    address public operator;
    address public guardian;
    bool public paused = true;
    Policy public policy;
    uint64 public policyVersion = 1;
    uint64 public lastProposedAt;
    uint256 public nextEpochId = 1;
    uint256 public totalReserved;
    uint256 public totalHolderAllocated;
    uint256 public totalHolderPaid;
    uint256 public totalDevAllocated;
    uint256 public totalDevPaid;
    uint256 public totalTreasuryAllocated;
    uint256 public totalTreasuryPaid;
    uint256 public totalPonsCollected;
    uint256 public totalSuccessfulClaims;
    mapping(address => uint256) public pendingDev;
    mapping(address => uint256) public pendingTreasury;
    mapping(uint256 => mapping(address => bool)) public hasClaimed;
    mapping(uint256 => Epoch) private epochData;
    uint256 private entered;

    error Unauthorized();
    error Reentrancy();
    error InvalidConfiguration();
    error InvalidAmount();
    error InvalidReceiver();
    error InvalidSnapshot();
    error DistributionPaused();
    error TokenNotBound();
    error InvalidEpoch();
    error RootNotReady();
    error IntervalNotElapsed();
    error InsufficientIncome();
    error InvalidProof();
    error AlreadyClaimed();
    error EpochBudgetExceeded();
    error TransferFailed();
    error UnsupportedRewardToken();
    error Insolvent();
    error InvalidBatch();
    error InsufficientBatchGas();
    error InvalidPonsLaunch();
    error InvalidPonsPhase();

    event HolderTokenBound(address indexed holderToken);
    event FundingReceived(address indexed sender, uint256 amount);
    event PonsFeesCollected(address indexed caller, address indexed asset, uint256 amount);
    event PonsFeesSwept(address indexed token, address indexed source, bytes32 indexed poolId);
    event PolicyUpdated(uint64 indexed version, uint16 holderBps, uint16 devBps, uint16 treasuryBps,
        uint64 intervalSeconds, uint64 rootDelaySeconds, uint256 minimumIncome,
        address devWallet, address treasuryWallet);
    event EpochProposed(uint256 indexed epochId, bytes32 indexed root, uint256 snapshotBlock,
        bytes32 snapshotBlockHash, bytes32 manifestHash, uint256 totalEligibleWeight,
        uint256 grossIncome, uint256 holderBudget, uint256 devBudget, uint256 treasuryBudget,
        uint64 policyVersion, uint64 readyAt);
    event EpochActivated(uint256 indexed epochId);
    event EpochCancelled(uint256 indexed epochId, uint256 releasedIncome);
    event HolderPaid(uint256 indexed epochId, address indexed account, address indexed receiver, uint256 amount);
    event CashPaid(address indexed account, address indexed receiver, uint256 devAmount, uint256 treasuryAmount);
    event ClaimSkipped(uint256 indexed epochId, address indexed account, bytes4 reason);
    event BatchCompleted(uint256 attempted, uint256 successful, uint256 amount);
    event OperatorUpdated(address indexed operator);
    event GuardianUpdated(address indexed guardian);
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

    modifier onlyPublisher() {
        if (msg.sender != owner && msg.sender != operator) revert Unauthorized();
        _;
    }

    constructor(address holderToken_, address rewardAsset_, address ponsEscrow_, address ponsFactory_,
        address ponsHook_, address owner_, address operator_, Policy memory policy_) {
        if (owner_ == address(0) || operator_ == address(0) || ponsEscrow_.code.length == 0
            || ponsFactory_.code.length == 0 || ponsHook_.code.length == 0
            || (rewardAsset_ != address(0) && rewardAsset_.code.length == 0)) revert InvalidConfiguration();
        rewardAsset = rewardAsset_;
        ponsEscrow = ponsEscrow_;
        ponsFactory = ponsFactory_;
        ponsHook = ponsHook_;
        _validatePonsStack();
        owner = owner_;
        guardian = owner_;
        operator = operator_;
        _validatePolicy(policy_);
        policy = policy_;
        if (holderToken_ != address(0)) _bindHolderToken(holderToken_);
        _emitPolicy();
    }

    receive() external payable {
        if (rewardAsset != address(0)) revert UnsupportedRewardToken();
        emit FundingReceived(msg.sender, msg.value);
    }

    /// @notice ERC20 funding must transfer exactly the requested amount. Native funding uses receive().
    function fund(uint256 amount) external nonReentrant {
        if (rewardAsset == address(0) || amount == 0) revert InvalidAmount();
        uint256 beforeBalance = rewardBalance();
        _callToken(abi.encodeCall(IFeeRewardToken.transferFrom, (msg.sender, address(this), amount)));
        if (rewardBalance() != beforeBalance + amount) revert UnsupportedRewardToken();
        emit FundingReceived(msg.sender, amount);
    }

    /// @notice Pull only this contract's own credits from the deployment's fixed Pons escrow.
    /// @dev Escrow must be verified against the launchpad's deployed contracts before deployment.
    function collectPonsFees() external nonReentrant returns (uint256 amount) {
        uint256 beforeBalance = rewardBalance();
        if (rewardAsset == address(0)) IPonsFeeEscrow(ponsEscrow).claim();
        else IPonsFeeEscrow(ponsEscrow).claimToken(rewardAsset);
        uint256 afterBalance = rewardBalance();
        if (afterBalance < beforeBalance) revert UnsupportedRewardToken();
        amount = afterBalance - beforeBalance;
        totalPonsCollected += amount;
        emit PonsFeesCollected(msg.sender, rewardAsset, amount);
    }

    /// @notice Request the current launch's curve fees as its fee recipient; never performs arbitrary swaps.
    /// @dev Pons rejects sweeps requiring internal conversions/buybacks unless its own sweep operator calls.
    function sweepCurveFees() external onlyPublisher nonReentrant {
        IPonsFeeFactory.Launch memory launch = _readPonsLaunch(holderToken);
        if (launch.phase != 0) revert InvalidPonsPhase();
        if (launch.curve.code.length == 0 || IPonsFeeCurve(launch.curve).token() != holderToken
            || IPonsFeeCurve(launch.curve).pairToken() != rewardAsset) revert InvalidPonsLaunch();
        IPonsFeeCurve(launch.curve).sweepFees(0);
        emit PonsFeesSwept(holderToken, launch.curve, bytes32(0));
    }

    /// @notice Quote-only sweep of the factory-recorded graduated pool. No caller-supplied pool or slippage.
    function sweepPoolFees() external onlyPublisher nonReentrant {
        IPonsFeeFactory.Launch memory launch = _readPonsLaunch(holderToken);
        if (launch.phase != 2) revert InvalidPonsPhase();
        (address currency0, address currency1) = holderToken < rewardAsset
            ? (holderToken, rewardAsset) : (rewardAsset, holderToken);
        bytes32 poolId = keccak256(abi.encode(currency0, currency1, launch.poolFee, launch.tickSpacing, ponsHook));
        IPonsFeeHook.Launch memory pool = IPonsFeeHook(ponsHook).launches(poolId);
        if (!pool.registered || pool.memecoin != holderToken || pool.quoteToken != rewardAsset) revert InvalidPonsLaunch();
        IPonsFeeHook(ponsHook).sweepPoolFees(poolId, 0, 0);
        emit PonsFeesSwept(holderToken, ponsHook, poolId);
    }

    function bindHolderToken(address token) external onlyOwner nonReentrant {
        if (holderToken != address(0)) revert InvalidConfiguration();
        _bindHolderToken(token);
    }

    function rewardBalance() public view returns (uint256) {
        return rewardAsset == address(0) ? address(this).balance : IFeeRewardToken(rewardAsset).balanceOf(address(this));
    }

    /// @notice Cash not committed to pending epochs, activated holder rewards, or developer/treasury claims.
    function availableIncome() public view returns (uint256) {
        uint256 balance = rewardBalance();
        if (balance < totalReserved) revert Insolvent();
        return balance - totalReserved;
    }

    function epochs(uint256 epochId) external view returns (Epoch memory) { return epochData[epochId]; }

    /// @notice Propose a funded snapshot. Every setting is copied; subsequent policy changes cannot rewrite it.
    /// @dev snapshotBlockHash is checked against EVM blockhash for the last 256 blocks; older hashes rely
    ///      on the public manifest and independent archival verification. Historical balances always do.
    function proposeEpoch(bytes32 root, uint256 snapshotBlock, bytes32 snapshotBlockHash,
        bytes32 manifestHash, uint256 totalEligibleWeight, uint256 grossIncome)
        external onlyPublisher nonReentrant returns (uint256 epochId) {
        if (paused) revert DistributionPaused();
        if (holderToken == address(0)) revert TokenNotBound();
        Policy memory p = policy;
        if (lastProposedAt != 0 && block.timestamp < uint256(lastProposedAt) + p.intervalSeconds) revert IntervalNotElapsed();
        if (root == bytes32(0) || manifestHash == bytes32(0) || snapshotBlockHash == bytes32(0)
            || snapshotBlock == 0 || snapshotBlock >= block.number) revert InvalidSnapshot();
        if (block.number - snapshotBlock <= 256 && blockhash(snapshotBlock) != snapshotBlockHash) revert InvalidSnapshot();
        if (totalEligibleWeight == 0 || totalEligibleWeight > MAX_ACCOUNTING || grossIncome == 0
            || grossIncome > MAX_ACCOUNTING || grossIncome < p.minimumIncome) revert InvalidAmount();
        if (grossIncome > availableIncome()) revert InsufficientIncome();
        epochId = nextEpochId++;
        Epoch storage e = epochData[epochId];
        e.root = root;
        e.manifestHash = manifestHash;
        e.snapshotBlockHash = snapshotBlockHash;
        e.snapshotBlock = snapshotBlock;
        e.totalEligibleWeight = totalEligibleWeight;
        e.grossIncome = grossIncome;
        e.holderBudget = grossIncome * p.holderBps / BPS;
        e.devBudget = grossIncome * p.devBps / BPS;
        // All indivisible base-unit split dust belongs to the declared treasury, never new income.
        e.treasuryBudget = grossIncome - e.holderBudget - e.devBudget;
        if (e.holderBudget == 0) revert InvalidAmount();
        e.devWallet = p.devWallet;
        e.treasuryWallet = p.treasuryWallet;
        e.policyVersion = policyVersion;
        e.proposedAt = uint64(block.timestamp);
        e.readyAt = uint64(block.timestamp + p.rootDelaySeconds);
        e.state = EpochState.Proposed;
        lastProposedAt = uint64(block.timestamp);
        totalReserved += grossIncome;
        emit EpochProposed(epochId, root, snapshotBlock, snapshotBlockHash, manifestHash, totalEligibleWeight,
            grossIncome, e.holderBudget, e.devBudget, e.treasuryBudget, e.policyVersion, e.readyAt);
    }

    function activateEpoch(uint256 epochId) external nonReentrant {
        if (paused) revert DistributionPaused();
        Epoch storage e = epochData[epochId];
        if (e.state != EpochState.Proposed) revert InvalidEpoch();
        if (block.timestamp < e.readyAt) revert RootNotReady();
        // Check funding is still sound (plain, non-rebasing reward tokens only).
        availableIncome();
        e.state = EpochState.Active;
        e.activatedAt = uint64(block.timestamp);
        pendingDev[e.devWallet] += e.devBudget;
        pendingTreasury[e.treasuryWallet] += e.treasuryBudget;
        totalHolderAllocated += e.holderBudget;
        totalDevAllocated += e.devBudget;
        totalTreasuryAllocated += e.treasuryBudget;
        emit EpochActivated(epochId);
    }

    /// @notice Only unpublished payouts may be cancelled. Activated claims never expire or revert to the owner.
    function cancelEpoch(uint256 epochId) external nonReentrant {
        if (msg.sender != owner && msg.sender != guardian) revert Unauthorized();
        Epoch storage e = epochData[epochId];
        if (e.state != EpochState.Proposed) revert InvalidEpoch();
        e.state = EpochState.Cancelled;
        totalReserved -= e.grossIncome;
        emit EpochCancelled(epochId, e.grossIncome);
    }

    /// @notice Standard double-hashed leaf; sorted-pair proofs. Both chain and distributor are in the domain.
    function leafHash(uint256 epochId, address account, uint256 weight) public view returns (bytes32) {
        return keccak256(bytes.concat(keccak256(abi.encode(block.chainid, address(this), epochId, account, weight))));
    }

    function claimable(uint256 epochId, address account, uint256 weight, bytes32[] calldata proof)
        external view returns (uint256) {
        Epoch storage e = epochData[epochId];
        if (e.state != EpochState.Active || hasClaimed[epochId][account] || !_validReceiver(account)
            || weight == 0 || weight > e.totalEligibleWeight || !_verify(e.root, leafHash(epochId, account, weight), proof)) return 0;
        uint256 amount = e.holderBudget * weight / e.totalEligibleWeight;
        return amount <= e.holderBudget - e.holderPaid ? amount : 0;
    }

    /// @notice Anyone may sponsor a proof, but funds always go to the proven holder.
    function claim(uint256 epochId, address account, uint256 weight, bytes32[] calldata proof)
        external nonReentrant returns (uint256) {
        return _claim(epochId, account, weight, proof, account);
    }

    /// @notice A proven holder may redirect their own claim if their wallet cannot receive native coin.
    function claimTo(uint256 epochId, uint256 weight, bytes32[] calldata proof, address receiver)
        external nonReentrant returns (uint256) {
        return _claim(epochId, msg.sender, weight, proof, receiver);
    }

    /// @notice Gas-bounded operator push distributions. A failed recipient/proof cannot block other holders.
    function distributeClaims(Claim[] calldata claims) external onlyPublisher nonReentrant
        returns (uint256 successful, uint256 amount) {
        if (claims.length == 0 || claims.length > MAX_BATCH) revert InvalidBatch();
        uint256 attempted;
        for (uint256 i; i < claims.length; ++i) {
            // A low-gas no-op must revert, otherwise eth_estimateGas may choose a
            // successful transaction that never attempts any recipient.
            if (gasleft() < BATCH_CLAIM_GAS + 100_000) revert InsufficientBatchGas();
            attempted++;
            Claim calldata c = claims[i];
            try this.batchClaim{gas: BATCH_CLAIM_GAS}(c) returns (uint256 paid) {
                successful++;
                amount += paid;
            } catch (bytes memory reason) {
                bytes4 selector;
                if (reason.length >= 4) assembly ("memory-safe") { selector := mload(add(reason, 32)) }
                emit ClaimSkipped(c.epochId, c.account, selector);
            }
        }
        emit BatchCompleted(attempted, successful, amount);
    }

    /// @dev Isolation boundary so failed token transfers roll back before the outer batch continues.
    function batchClaim(Claim calldata c) external returns (uint256) {
        if (msg.sender != address(this) || entered != 1) revert Unauthorized();
        return _claim(c.epochId, c.account, c.weight, c.proof, c.account);
    }

    function withdrawCash(address receiver) external nonReentrant returns (uint256) { return _withdrawCash(msg.sender, receiver); }
    function withdrawCashFor(address account) external nonReentrant returns (uint256) { return _withdrawCash(account, account); }

    function setPolicy(Policy calldata nextPolicy) external onlyOwner nonReentrant {
        _validatePolicy(nextPolicy);
        policy = nextPolicy;
        policyVersion++;
        _emitPolicy();
    }

    function setOperator(address nextOperator) external onlyOwner nonReentrant {
        if (nextOperator == address(0)) revert InvalidConfiguration();
        operator = nextOperator;
        emit OperatorUpdated(nextOperator);
    }

    function setGuardian(address nextGuardian) external onlyOwner nonReentrant {
        if (nextGuardian == address(0)) revert InvalidConfiguration();
        guardian = nextGuardian;
        emit GuardianUpdated(nextGuardian);
    }

    function setPaused(bool nextPaused) external nonReentrant {
        if (msg.sender != owner && (msg.sender != guardian || !nextPaused)) revert Unauthorized();
        paused = nextPaused;
        emit PauseUpdated(nextPaused);
    }

    function transferOwnership(address nextOwner) external onlyOwner nonReentrant {
        if (nextOwner == address(0) || nextOwner == address(this)) revert InvalidConfiguration();
        pendingOwner = nextOwner;
        emit OwnershipProposed(nextOwner);
    }

    function acceptOwnership() external nonReentrant {
        if (msg.sender != pendingOwner) revert Unauthorized();
        owner = pendingOwner;
        pendingOwner = address(0);
        emit OwnershipTransferred(owner);
    }

    function _claim(uint256 epochId, address account, uint256 weight, bytes32[] calldata proof, address receiver)
        private returns (uint256 amount) {
        Epoch storage e = epochData[epochId];
        if (e.state != EpochState.Active) revert InvalidEpoch();
        if (!_validReceiver(account) || !_validReceiver(receiver)) revert InvalidReceiver();
        if (hasClaimed[epochId][account]) revert AlreadyClaimed();
        if (weight == 0 || weight > e.totalEligibleWeight || !_verify(e.root, leafHash(epochId, account, weight), proof)) revert InvalidProof();
        amount = e.holderBudget * weight / e.totalEligibleWeight;
        if (amount == 0) revert InvalidAmount();
        if (amount > e.holderBudget - e.holderPaid) revert EpochBudgetExceeded();
        _pay(receiver, amount);
        hasClaimed[epochId][account] = true;
        e.holderPaid += amount;
        totalReserved -= amount;
        totalHolderPaid += amount;
        totalSuccessfulClaims++;
        emit HolderPaid(epochId, account, receiver, amount);
    }

    function _withdrawCash(address account, address receiver) private returns (uint256 amount) {
        if (!_validReceiver(account) || !_validReceiver(receiver)) revert InvalidReceiver();
        uint256 devAmount = pendingDev[account];
        uint256 treasuryAmount = pendingTreasury[account];
        amount = devAmount + treasuryAmount;
        if (amount == 0) revert InvalidAmount();
        _pay(receiver, amount);
        pendingDev[account] = 0;
        pendingTreasury[account] = 0;
        totalReserved -= amount;
        totalDevPaid += devAmount;
        totalTreasuryPaid += treasuryAmount;
        emit CashPaid(account, receiver, devAmount, treasuryAmount);
    }

    function _pay(address receiver, uint256 amount) private {
        if (rewardAsset == address(0)) {
            // Do not copy arbitrary recipient return data into memory.
            bool success;
            assembly ("memory-safe") { success := call(PAYOUT_GAS, receiver, amount, 0, 0, 0, 0) }
            if (!success) revert TransferFailed();
        } else {
            uint256 cashBefore = rewardBalance();
            uint256 receivedBefore = IFeeRewardToken(rewardAsset).balanceOf(receiver);
            _callToken(abi.encodeCall(IFeeRewardToken.transfer, (receiver, amount)));
            if (rewardBalance() + amount != cashBefore || IFeeRewardToken(rewardAsset).balanceOf(receiver) != receivedBefore + amount)
                revert UnsupportedRewardToken();
        }
    }

    function _callToken(bytes memory data) private {
        address token = rewardAsset;
        bool valid;
        assembly ("memory-safe") {
            let success := call(gas(), token, 0, add(data, 32), mload(data), 0, 0)
            switch returndatasize()
            case 0 { valid := success }
            case 32 {
                returndatacopy(0, 0, 32)
                valid := and(success, eq(mload(0), 1))
            }
        }
        if (!valid) revert TransferFailed();
    }

    function _verify(bytes32 root, bytes32 leaf, bytes32[] calldata proof) private pure returns (bool) {
        if (proof.length > MAX_PROOF) return false;
        for (uint256 i; i < proof.length; ++i) {
            bytes32 sibling = proof[i];
            leaf = leaf < sibling ? keccak256(abi.encodePacked(leaf, sibling)) : keccak256(abi.encodePacked(sibling, leaf));
        }
        return root == leaf;
    }

    function _bindHolderToken(address token) private {
        if (token.code.length == 0 || token == rewardAsset || token == address(this)) revert InvalidConfiguration();
        _readPonsLaunch(token);
        holderToken = token;
        emit HolderTokenBound(token);
    }

    function _readPonsLaunch(address token) private view returns (IPonsFeeFactory.Launch memory launch) {
        if (token == address(0)) revert TokenNotBound();
        _validatePonsStack();
        launch = IPonsFeeFactory(ponsFactory).getLaunchedToken(token);
        if (!launch.exists || launch.token != token || launch.creatorFeeRecipient != address(this)
            || launch.pairToken != rewardAsset) revert InvalidPonsLaunch();
    }

    function _validatePonsStack() private view {
        if (IPonsFeeFactory(ponsFactory).feeEscrow() != ponsEscrow || IPonsFeeFactory(ponsFactory).memeHook() != ponsHook
            || IPonsFeeHook(ponsHook).factory() != ponsFactory
            || IPonsFeeHook(ponsHook).poolManager() != IPonsFeeFactory(ponsFactory).poolManager()) revert InvalidConfiguration();
    }

    function _validatePolicy(Policy memory p) private view {
        if (uint256(p.holderBps) + p.devBps + p.treasuryBps != BPS || p.holderBps == 0
            || p.intervalSeconds < MIN_INTERVAL || p.intervalSeconds > MAX_INTERVAL
            || p.rootDelaySeconds < MIN_ROOT_DELAY || p.rootDelaySeconds > MAX_ROOT_DELAY
            || p.minimumIncome == 0 || p.minimumIncome > MAX_ACCOUNTING
            || !_validReceiver(p.devWallet) || !_validReceiver(p.treasuryWallet)) revert InvalidConfiguration();
    }

    function _validReceiver(address receiver) private view returns (bool) {
        return receiver != address(0) && receiver != address(this);
    }

    function _emitPolicy() private {
        Policy memory p = policy;
        emit PolicyUpdated(policyVersion, p.holderBps, p.devBps, p.treasuryBps,
            p.intervalSeconds, p.rootDelaySeconds, p.minimumIncome, p.devWallet, p.treasuryWallet);
    }
}
