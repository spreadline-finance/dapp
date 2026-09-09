// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {SpreadlineFeeDistributor, IFeeRewardToken, IPonsFeeFactory, IPonsFeeHook} from "../src/SpreadlineFeeDistributor.sol";

interface FeeVm {
    function deal(address account, uint256 balance) external;
    function warp(uint256 timestamp) external;
    function roll(uint256 blockNumber) external;
    function setBlockhash(uint256 blockNumber, bytes32 blockHash) external;
    function chainId(uint256 chainId_) external;
    function prank(address account) external;
    function expectRevert(bytes4 selector) external;
}

contract FeeTestToken is IFeeRewardToken {
    uint256 public totalSupply;
    uint8 public constant decimals = 18;
    event Transfer(address indexed from, address indexed to, uint256 value);
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;
    address public rejectedReceiver;
    bool public feeOnTransfer;
    bool public falseReturn;
    address public callbackTarget;
    bytes public callbackData;
    bool public callbackSucceeded;

    function mint(address account, uint256 amount) external { balanceOf[account] += amount; totalSupply += amount; emit Transfer(address(0), account, amount); }
    function approve(address spender, uint256 amount) external { allowance[msg.sender][spender] = amount; }
    function configure(address rejected, bool fee, bool false_) external { rejectedReceiver = rejected; feeOnTransfer = fee; falseReturn = false_; }
    function setCallback(address target, bytes calldata data) external { callbackTarget = target; callbackData = data; }
    function transfer(address receiver, uint256 amount) external returns (bool) {
        if (receiver == rejectedReceiver) return false;
        _transfer(msg.sender, receiver, amount);
        if (callbackTarget != address(0)) (callbackSucceeded,) = callbackTarget.call(callbackData);
        return !falseReturn;
    }
    function transferFrom(address sender, address receiver, uint256 amount) external returns (bool) {
        allowance[sender][msg.sender] -= amount;
        _transfer(sender, receiver, amount);
        return !falseReturn;
    }
    function _transfer(address sender, address receiver, uint256 amount) private {
        balanceOf[sender] -= amount;
        uint256 received = feeOnTransfer && amount > 0 ? amount - 1 : amount;
        balanceOf[receiver] += received;
        emit Transfer(sender, receiver, received);
        if (received < amount) { totalSupply -= amount - received; emit Transfer(sender, address(0), amount - received); }
    }
}

contract FeeTestEscrow {
    mapping(address => uint256) public nativeCredits;
    mapping(address => mapping(address => uint256)) public tokenCredits;
    uint256 public nativeClaims;
    uint256 public tokenClaims;
    address public lastToken;
    function creditNative(address account, uint256 amount) external { nativeCredits[account] += amount; }
    function creditToken(address account, address token, uint256 amount) external { tokenCredits[account][token] += amount; }
    function claim() external {
        nativeClaims++;
        uint256 amount = nativeCredits[msg.sender];
        nativeCredits[msg.sender] = 0;
        (bool sent,) = msg.sender.call{value: amount}("");
        require(sent, "escrow transfer");
    }
    function claimToken(address token) external {
        tokenClaims++;
        lastToken = token;
        uint256 amount = tokenCredits[msg.sender][token];
        tokenCredits[msg.sender][token] = 0;
        require(IFeeRewardToken(token).transfer(msg.sender, amount), "escrow token transfer");
    }
}

contract FeeTestFactory is IPonsFeeFactory {
    address public feeEscrow;
    address public memeHook;
    address public poolManager = address(0x9001);
    mapping(address => Launch) private records;
    constructor(address escrow) { feeEscrow = escrow; }
    function setHook(address hook) external { memeHook = hook; }
    function setEscrow(address escrow) external { feeEscrow = escrow; }
    function getLaunchedToken(address token) external view returns (Launch memory) { return records[token]; }
    function setLaunch(address token, address curve, address recipient, address pair, uint8 phase, bool exists) external {
        Launch storage launch = records[token];
        launch.token = token;
        launch.curve = curve;
        launch.creatorFeeRecipient = recipient;
        launch.pairToken = pair;
        launch.poolFee = 3_000;
        launch.tickSpacing = 60;
        launch.phase = phase;
        launch.exists = exists;
    }
}

contract FeeTestCurve {
    address public token;
    address public pairToken;
    address public recipient;
    FeeTestEscrow public escrow;
    bool public needsUpstreamOperator;
    uint256 public pending = 1 ether;
    uint256 public sweeps;
    error InternalSwapRequiresOperator();
    constructor(address token_, address pair_, address recipient_, FeeTestEscrow escrow_) {
        token = token_; pairToken = pair_; recipient = recipient_; escrow = escrow_;
    }
    function setNeedsOperator(bool next) external { needsUpstreamOperator = next; }
    function sweepFees(uint256 minimum) external {
        require(msg.sender == recipient, "only fee recipient");
        require(minimum == 0, "no conversion minima");
        if (needsUpstreamOperator) revert InternalSwapRequiresOperator();
        sweeps++;
        if (pairToken == address(0)) escrow.creditNative(msg.sender, pending);
        else escrow.creditToken(msg.sender, pairToken, pending);
        pending = 0;
    }
}

contract FeeTestHook is IPonsFeeHook {
    address public factory;
    address public poolManager;
    mapping(bytes32 => Launch) private records;
    bytes32 public lastPool;
    uint256 public sweeps;
    bool public needsUpstreamOperator;
    error InternalSwapRequiresOperator();
    constructor(address factory_, address manager_) { factory = factory_; poolManager = manager_; }
    function launches(bytes32 poolId) external view returns (Launch memory) { return records[poolId]; }
    function setLaunch(bytes32 poolId, address token, address pair, address recipient, bool registered) external {
        Launch storage launch = records[poolId];
        launch.registered = registered;
        launch.memecoin = token;
        launch.quoteToken = pair;
        launch.creator = recipient;
    }
    function setNeedsOperator(bool next) external { needsUpstreamOperator = next; }
    function sweepPoolFees(bytes32 poolId, uint256 conversion, uint256 buyback) external {
        require(records[poolId].registered && msg.sender == records[poolId].creator, "only registered recipient");
        require(conversion == 0 && buyback == 0, "no conversion minima");
        if (needsUpstreamOperator) revert InternalSwapRequiresOperator();
        lastPool = poolId;
        sweeps++;
    }
}

contract FeeTestRecipient {
    bool public rejects;
    bool public consumesGas;
    address public callbackTarget;
    bytes public callbackData;
    bool public callbackSucceeded;
    function configure(bool rejects_, bool gas_) external { rejects = rejects_; consumesGas = gas_; }
    function setCallback(address target, bytes calldata data) external { callbackTarget = target; callbackData = data; }
    receive() external payable {
        require(!rejects, "reject native coin");
        if (consumesGas) assembly { invalid() }
        if (callbackTarget != address(0)) (callbackSucceeded,) = callbackTarget.call(callbackData);
    }
    function claimTo(SpreadlineFeeDistributor distributor, uint256 id, uint256 weight, bytes32[] calldata proof, address receiver) external {
        distributor.claimTo(id, weight, proof, receiver);
    }
}

contract SpreadlineFeeDistributorTest {
    FeeVm private constant vm = FeeVm(address(uint160(uint256(keccak256("hevm cheat code")))));
    bytes32 private constant SNAPSHOT = keccak256("canonical snapshot block");
    bytes32 private constant MANIFEST = keccak256("public immutable manifest bytes");
    address private constant ALICE = address(0xA11CE);
    address private constant BOB = address(0xB0B);
    address private constant DEV = address(0xDE7);
    address private constant TREASURY = address(0x777);
    address private constant GUARDIAN = address(0x600D);
    FeeTestToken private holder;
    FeeTestToken private reward;
    FeeTestEscrow private escrow;
    FeeTestFactory private factory;
    FeeTestHook private hook;
    SpreadlineFeeDistributor private distributor;

    function setUp() public {
        vm.roll(1_000);
        vm.warp(1_800_000_000);
        vm.setBlockhash(999, SNAPSHOT);
        holder = new FeeTestToken();
        reward = new FeeTestToken();
        escrow = new FeeTestEscrow();
        factory = new FeeTestFactory(address(escrow));
        hook = new FeeTestHook(address(factory), factory.poolManager());
        factory.setHook(address(hook));
        distributor = _new(address(0));
        vm.deal(address(distributor), 100 ether);
        vm.deal(address(escrow), 100 ether);
    }

    function testNativeFundedEpochAndActualCashAccounting() public {
        uint256 id = _single(distributor, ALICE, 100, 10 ether);
        _eq(distributor.availableIncome(), 90 ether);
        _eq(distributor.totalReserved(), 10 ether);
        _eq(distributor.totalHolderAllocated(), 0);
        _eq(distributor.totalHolderPaid(), 0);
        vm.expectRevert(SpreadlineFeeDistributor.RootNotReady.selector);
        distributor.activateEpoch(id);
        _activate(distributor, id);
        _eq(distributor.totalHolderAllocated(), 7.5 ether);
        _eq(distributor.pendingDev(DEV), 1 ether);
        _eq(distributor.pendingTreasury(TREASURY), 1.5 ether);
        vm.prank(BOB);
        _eq(distributor.claim(id, ALICE, 100, _empty()), 7.5 ether);
        _eq(ALICE.balance, 7.5 ether);
        _eq(BOB.balance, 0);
        require(distributor.hasClaimed(id, ALICE), "successful claim marked");
        _eq(distributor.totalSuccessfulClaims(), 1);
        _eq(distributor.totalHolderPaid(), 7.5 ether);
        distributor.withdrawCashFor(DEV);
        distributor.withdrawCashFor(TREASURY);
        _eq(DEV.balance, 1 ether);
        _eq(TREASURY.balance, 1.5 ether);
        _eq(distributor.totalDevPaid(), 1 ether);
        _eq(distributor.totalTreasuryPaid(), 1.5 ether);
        _eq(distributor.totalReserved(), 0);
        _eq(distributor.rewardBalance(), 90 ether);
        _eq(distributor.availableIncome(), 90 ether);
        _reconciles(distributor, 100 ether);
    }

    function testNativeCreditsPulledForDistributorOnly() public {
        escrow.creditNative(address(distributor), 3 ether);
        escrow.creditNative(ALICE, 7 ether);
        vm.prank(BOB);
        _eq(distributor.collectPonsFees(), 3 ether);
        _eq(distributor.totalPonsCollected(), 3 ether);
        _eq(distributor.availableIncome(), 103 ether);
        _eq(escrow.nativeCredits(ALICE), 7 ether);
        _eq(escrow.nativeClaims(), 1);
        _eq(escrow.tokenClaims(), 0);
        _eq(distributor.collectPonsFees(), 0);
        _eq(distributor.totalPonsCollected(), 3 ether);
        vm.deal(ALICE, 1 ether);
        vm.prank(ALICE);
        (bool sent,) = address(distributor).call{value: 1 ether}("");
        require(sent, "direct funding");
        _eq(distributor.availableIncome(), 104 ether);
        _eq(distributor.totalPonsCollected(), 3 ether);
    }

    function testTokenCreditsPullOnlyImmutableRewardAsset() public {
        SpreadlineFeeDistributor d = _new(address(reward));
        reward.mint(address(escrow), 500);
        holder.mint(address(escrow), 999);
        escrow.creditToken(address(d), address(reward), 500);
        escrow.creditToken(address(d), address(holder), 999);
        _eq(d.collectPonsFees(), 500);
        _eq(d.totalPonsCollected(), 500);
        _eq(d.availableIncome(), 500);
        _eq(escrow.tokenClaims(), 1);
        require(escrow.lastToken() == address(reward), "only immutable asset");
        _eq(escrow.tokenCredits(address(d), address(holder)), 999);
        _eq(escrow.nativeClaims(), 0);
    }

    function testCurveSweepToEscrowToDistributorPipelineAndCallerBoundaries() public {
        IPonsFeeFactory.Launch memory launch = factory.getLaunchedToken(address(holder));
        FeeTestCurve curve = FeeTestCurve(launch.curve);
        vm.prank(ALICE);
        vm.expectRevert(SpreadlineFeeDistributor.Unauthorized.selector);
        distributor.sweepCurveFees();
        distributor.setPaused(true);
        distributor.sweepCurveFees();
        _eq(curve.sweeps(), 1);
        _eq(escrow.nativeCredits(address(distributor)), 1 ether);
        _eq(distributor.totalPonsCollected(), 0);
        _eq(distributor.collectPonsFees(), 1 ether);
        _eq(distributor.totalPonsCollected(), 1 ether);
        _eq(distributor.rewardBalance(), 101 ether);
        factory.setLaunch(address(holder), address(curve), ALICE, address(0), 0, true);
        vm.expectRevert(SpreadlineFeeDistributor.InvalidPonsLaunch.selector);
        distributor.sweepCurveFees();
        factory.setLaunch(address(holder), address(curve), address(distributor), address(reward), 0, true);
        vm.expectRevert(SpreadlineFeeDistributor.InvalidPonsLaunch.selector);
        distributor.sweepCurveFees();
        factory.setLaunch(address(holder), address(curve), address(distributor), address(0), 2, true);
        vm.expectRevert(SpreadlineFeeDistributor.InvalidPonsPhase.selector);
        distributor.sweepCurveFees();
    }

    function testCurveSweepDoesNotBypassPonsInternalSwapOperatorRequirement() public {
        FeeTestCurve curve = FeeTestCurve(factory.getLaunchedToken(address(holder)).curve);
        curve.setNeedsOperator(true);
        vm.expectRevert(FeeTestCurve.InternalSwapRequiresOperator.selector);
        distributor.sweepCurveFees();
        _eq(curve.sweeps(), 0);
        _eq(distributor.totalPonsCollected(), 0);
        _eq(escrow.nativeCredits(address(distributor)), 0);
    }

    function testPoolSweepUsesOnlyFactoryRecordedTokenPairAndVerifiedHook() public {
        address curve = factory.getLaunchedToken(address(holder)).curve;
        bytes32 poolId = keccak256(abi.encode(address(0), address(holder), uint24(3_000), int24(60), address(hook)));
        factory.setLaunch(address(holder), curve, address(distributor), address(0), 2, true);
        hook.setLaunch(poolId, address(holder), address(0), address(distributor), true);
        distributor.sweepPoolFees();
        require(hook.lastPool() == poolId, "exact V4 pool identifier");
        _eq(hook.sweeps(), 1);
        hook.setNeedsOperator(true);
        vm.expectRevert(FeeTestHook.InternalSwapRequiresOperator.selector);
        distributor.sweepPoolFees();
        hook.setNeedsOperator(false);
        hook.setLaunch(poolId, address(holder), address(reward), address(distributor), true);
        vm.expectRevert(SpreadlineFeeDistributor.InvalidPonsLaunch.selector);
        distributor.sweepPoolFees();
        hook.setLaunch(poolId, address(holder), address(0), address(distributor), false);
        vm.expectRevert(SpreadlineFeeDistributor.InvalidPonsLaunch.selector);
        distributor.sweepPoolFees();
        factory.setLaunch(address(holder), curve, address(distributor), address(0), 1, true);
        vm.expectRevert(SpreadlineFeeDistributor.InvalidPonsPhase.selector);
        distributor.sweepPoolFees();
    }

    function testBindingAndSweepsRejectUnregisteredLaunchOrChangedStack() public {
        SpreadlineFeeDistributor d = new SpreadlineFeeDistributor(address(0), address(0), address(escrow), address(factory),
            address(hook), address(this), address(this), _policy());
        vm.expectRevert(SpreadlineFeeDistributor.InvalidPonsLaunch.selector);
        d.bindHolderToken(address(reward));
        factory.setLaunch(address(reward), address(0), ALICE, address(0), 0, true);
        vm.expectRevert(SpreadlineFeeDistributor.InvalidPonsLaunch.selector);
        d.bindHolderToken(address(reward));
        factory.setEscrow(address(reward));
        vm.expectRevert(SpreadlineFeeDistributor.InvalidConfiguration.selector);
        distributor.sweepCurveFees();
        vm.expectRevert(SpreadlineFeeDistributor.InvalidConfiguration.selector);
        new SpreadlineFeeDistributor(address(0), address(0), address(escrow), address(factory), address(hook), address(this), address(this), _policy());
        _eq(distributor.totalPonsCollected(), 0);
    }

    function testTokenFundAndClaimRequireExactPlainTokenTransfers() public {
        SpreadlineFeeDistributor d = _new(address(reward));
        reward.mint(address(this), 1_000);
        reward.approve(address(d), 1_000);
        reward.configure(address(0), true, false);
        vm.expectRevert(SpreadlineFeeDistributor.UnsupportedRewardToken.selector);
        d.fund(1_000);
        _eq(d.rewardBalance(), 0);
        _eq(reward.balanceOf(address(this)), 1_000);
        reward.configure(address(0), false, false);
        d.fund(1_000);
        uint256 id = _single(d, ALICE, 1, 1_000);
        _activate(d, id);
        reward.configure(address(0), true, false);
        vm.expectRevert(SpreadlineFeeDistributor.UnsupportedRewardToken.selector);
        d.claim(id, ALICE, 1, _empty());
        _eq(reward.balanceOf(ALICE), 0);
        require(!d.hasClaimed(id, ALICE), "fee token not claimed");
        _eq(d.totalReserved(), 1_000);
        reward.configure(address(0), false, true);
        vm.expectRevert(SpreadlineFeeDistributor.TransferFailed.selector);
        d.claim(id, ALICE, 1, _empty());
        _eq(reward.balanceOf(ALICE), 0);
        reward.configure(address(0), false, false);
        _eq(d.claim(id, ALICE, 1, _empty()), 750);
        _eq(reward.balanceOf(ALICE), 750);
        _reconciles(d, 1_000);
    }

    function testRejectedNativeRecipientNeverCountsAndCanRedirectOwnClaim() public {
        FeeTestRecipient receiver = new FeeTestRecipient();
        receiver.configure(true, false);
        uint256 id = _single(distributor, address(receiver), 7, 10 ether);
        _activate(distributor, id);
        vm.expectRevert(SpreadlineFeeDistributor.TransferFailed.selector);
        distributor.claim(id, address(receiver), 7, _empty());
        require(!distributor.hasClaimed(id, address(receiver)), "not marked");
        _eq(distributor.totalSuccessfulClaims(), 0);
        _eq(distributor.totalHolderPaid(), 0);
        _eq(distributor.totalReserved(), 10 ether);
        vm.prank(ALICE);
        vm.expectRevert(SpreadlineFeeDistributor.InvalidProof.selector);
        distributor.claimTo(id, 7, _empty(), ALICE);
        receiver.claimTo(distributor, id, 7, _empty(), ALICE);
        _eq(ALICE.balance, 7.5 ether);
        require(distributor.hasClaimed(id, address(receiver)), "redirected original account marked");
    }

    function testNativeBatchRecipientFailureAndDuplicateDoNotBlockOthers() public {
        FeeTestRecipient receiver = new FeeTestRecipient();
        receiver.configure(false, true);
        uint256 id = distributor.nextEpochId();
        bytes32 rejectedLeaf = distributor.leafHash(id, address(receiver), 1);
        bytes32 aliceLeaf = distributor.leafHash(id, ALICE, 1);
        _propose(distributor, _pair(rejectedLeaf, aliceLeaf), 2, 10 ether);
        _activate(distributor, id);
        SpreadlineFeeDistributor.Claim[] memory claims = new SpreadlineFeeDistributor.Claim[](3);
        claims[0] = _claim(id, address(receiver), 1, _proof(aliceLeaf));
        claims[1] = _claim(id, ALICE, 1, _proof(rejectedLeaf));
        claims[2] = claims[1];
        (uint256 count, uint256 amount) = distributor.distributeClaims(claims);
        _eq(count, 1);
        _eq(amount, 3.75 ether);
        _eq(ALICE.balance, 3.75 ether);
        _eq(distributor.totalSuccessfulClaims(), 1);
        _eq(distributor.totalHolderPaid(), 3.75 ether);
        require(!distributor.hasClaimed(id, address(receiver)), "failed can retry");
        receiver.configure(false, false);
        _eq(distributor.claim(id, address(receiver), 1, _proof(aliceLeaf)), 3.75 ether);
        _eq(address(receiver).balance, 3.75 ether);
        _reconciles(distributor, 100 ether);
    }

    function testTokenBatchRollsBackFailedTransferThenPaysNextRecipient() public {
        SpreadlineFeeDistributor d = _new(address(reward));
        reward.mint(address(d), 1_000);
        uint256 id = d.nextEpochId();
        bytes32 a = d.leafHash(id, ALICE, 1);
        bytes32 b = d.leafHash(id, BOB, 1);
        _propose(d, _pair(a, b), 2, 1_000);
        _activate(d, id);
        reward.configure(ALICE, false, false);
        SpreadlineFeeDistributor.Claim[] memory claims = new SpreadlineFeeDistributor.Claim[](2);
        claims[0] = _claim(id, ALICE, 1, _proof(b));
        claims[1] = _claim(id, BOB, 1, _proof(a));
        (uint256 count, uint256 amount) = d.distributeClaims(claims);
        _eq(count, 1);
        _eq(amount, 375);
        _eq(reward.balanceOf(ALICE), 0);
        _eq(reward.balanceOf(BOB), 375);
        require(!d.hasClaimed(id, ALICE), "failed token recipient can retry");
        _reconciles(d, 1_000);
    }

    function testReentrantNativeRecipientCannotClaimTwice() public {
        FeeTestRecipient receiver = new FeeTestRecipient();
        uint256 id = _single(distributor, address(receiver), 1, 10 ether);
        _activate(distributor, id);
        receiver.setCallback(address(distributor), abi.encodeCall(distributor.claim, (id, address(receiver), 1, _empty())));
        distributor.claim(id, address(receiver), 1, _empty());
        require(!receiver.callbackSucceeded(), "callback blocked");
        _eq(address(receiver).balance, 7.5 ether);
        _eq(distributor.totalHolderPaid(), 7.5 ether);
        _eq(distributor.totalSuccessfulClaims(), 1);
    }

    function testReentrantRewardTokenCannotEnterClaimOrAdmin() public {
        SpreadlineFeeDistributor d = _new(address(reward));
        reward.mint(address(d), 1_000);
        uint256 id = _single(d, ALICE, 1, 1_000);
        _activate(d, id);
        reward.setCallback(address(d), abi.encodeCall(d.claim, (id, ALICE, 1, _empty())));
        d.claim(id, ALICE, 1, _empty());
        require(!reward.callbackSucceeded(), "token callback blocked");
        _eq(reward.balanceOf(ALICE), 750);
        _eq(d.totalSuccessfulClaims(), 1);
    }

    function testPolicyAndWalletChangesNeverRewritePendingOrActiveEpochs() public {
        uint256 old = _single(distributor, ALICE, 1, 10 ether);
        SpreadlineFeeDistributor.Policy memory p = _policy();
        p.holderBps = 8_000;
        p.devBps = 500;
        p.treasuryBps = 1_500;
        p.devWallet = BOB;
        p.treasuryWallet = ALICE;
        p.intervalSeconds = 60;
        p.rootDelaySeconds = 1_800;
        distributor.setPolicy(p);
        SpreadlineFeeDistributor.Epoch memory oldEpoch = distributor.epochs(old);
        _eq(oldEpoch.policyVersion, 1);
        _eq(oldEpoch.holderBudget, 7.5 ether);
        _eq(oldEpoch.readyAt - oldEpoch.proposedAt, 900);
        require(oldEpoch.devWallet == DEV && oldEpoch.treasuryWallet == TREASURY, "old recipients retained");
        _activate(distributor, old);
        _eq(distributor.pendingDev(DEV), 1 ether);
        _eq(distributor.pendingDev(BOB), 0);
        uint256 next = _single(distributor, BOB, 1, 10 ether);
        SpreadlineFeeDistributor.Epoch memory nextEpoch = distributor.epochs(next);
        _eq(nextEpoch.policyVersion, 2);
        _eq(nextEpoch.holderBudget, 8 ether);
        _eq(nextEpoch.readyAt - nextEpoch.proposedAt, 1_800);
        _activate(distributor, next);
        _eq(distributor.pendingDev(BOB), 0.5 ether);
        _eq(distributor.pendingTreasury(ALICE), 1.5 ether);
        distributor.claim(old, ALICE, 1, _empty());
        distributor.claim(next, BOB, 1, _empty());
        _eq(ALICE.balance, 7.5 ether);
        _eq(BOB.balance, 8 ether);
        _reconciles(distributor, 100 ether);
    }

    function testSharedDevAndTreasuryWalletAccountingStaysSeparate() public {
        SpreadlineFeeDistributor.Policy memory p = _policy();
        p.treasuryWallet = DEV;
        distributor.setPolicy(p);
        uint256 id = _single(distributor, ALICE, 1, 10 ether);
        _activate(distributor, id);
        _eq(distributor.withdrawCashFor(DEV), 2.5 ether);
        _eq(distributor.totalDevPaid(), 1 ether);
        _eq(distributor.totalTreasuryPaid(), 1.5 ether);
        _eq(distributor.pendingDev(DEV), 0);
        _eq(distributor.pendingTreasury(DEV), 0);
        _reconciles(distributor, 100 ether);
    }

    function testPausePreventsNewDistributionsButNeverBlocksActiveClaims() public {
        uint256 id = _single(distributor, ALICE, 1, 10 ether);
        _activate(distributor, id);
        uint256 pending = _single(distributor, BOB, 1, 10 ether);
        distributor.setGuardian(GUARDIAN);
        vm.prank(GUARDIAN);
        distributor.setPaused(true);
        vm.expectRevert(SpreadlineFeeDistributor.DistributionPaused.selector);
        distributor.activateEpoch(pending);
        vm.expectRevert(SpreadlineFeeDistributor.DistributionPaused.selector);
        _propose(distributor, bytes32(uint256(1)), 1, 10 ether);
        vm.prank(GUARDIAN);
        vm.expectRevert(SpreadlineFeeDistributor.Unauthorized.selector);
        distributor.setPaused(false);
        distributor.claim(id, ALICE, 1, _empty());
        distributor.withdrawCashFor(DEV);
        distributor.withdrawCashFor(TREASURY);
        _eq(ALICE.balance, 7.5 ether);
        _reconciles(distributor, 100 ether);
    }

    function testOnlyPendingEpochCanBeCancelledAndBudgetReleased() public {
        uint256 id = _single(distributor, ALICE, 1, 10 ether);
        distributor.setGuardian(GUARDIAN);
        vm.prank(GUARDIAN);
        distributor.cancelEpoch(id);
        _eq(distributor.availableIncome(), 100 ether);
        _eq(distributor.totalReserved(), 0);
        vm.expectRevert(SpreadlineFeeDistributor.InvalidEpoch.selector);
        distributor.activateEpoch(id);
        vm.expectRevert(SpreadlineFeeDistributor.InvalidEpoch.selector);
        distributor.claim(id, ALICE, 1, _empty());
        vm.warp(block.timestamp + 900);
        uint256 active = _single(distributor, ALICE, 1, 10 ether);
        _activate(distributor, active);
        vm.expectRevert(SpreadlineFeeDistributor.InvalidEpoch.selector);
        distributor.cancelEpoch(active);
        distributor.claim(active, ALICE, 1, _empty());
    }

    function testReservedFundsCannotBeAllocatedAgainAndNoSweepExists() public {
        uint256 id = _single(distributor, ALICE, 1, 100 ether);
        vm.warp(block.timestamp + 900);
        vm.expectRevert(SpreadlineFeeDistributor.InsufficientIncome.selector);
        _propose(distributor, bytes32(uint256(1)), 1, 1 ether);
        (bool sweep,) = address(distributor).call(abi.encodeWithSignature("withdrawAll(address)", address(this)));
        require(!sweep, "no owner sweep");
        (bool arbitrary,) = address(distributor).call(abi.encodeWithSignature("execute(address,bytes)", address(escrow), hex"12345678"));
        require(!arbitrary, "no arbitrary calls");
        _activate(distributor, id);
        _eq(distributor.availableIncome(), 0);
        vm.expectRevert(SpreadlineFeeDistributor.InvalidAmount.selector);
        distributor.withdrawCash(address(this));
        _eq(distributor.totalReserved(), 100 ether);
    }

    function testIntervalMinimumAndSnapshotValidation() public {
        uint256 id = _single(distributor, ALICE, 1, 10 ether);
        vm.expectRevert(SpreadlineFeeDistributor.IntervalNotElapsed.selector);
        _propose(distributor, bytes32(uint256(1)), 1, 10 ether);
        vm.warp(block.timestamp + 900);
        vm.expectRevert(SpreadlineFeeDistributor.InvalidSnapshot.selector);
        distributor.proposeEpoch(bytes32(uint256(1)), 999, bytes32(uint256(2)), MANIFEST, 1, 1);
        vm.expectRevert(SpreadlineFeeDistributor.InvalidSnapshot.selector);
        distributor.proposeEpoch(bytes32(uint256(1)), block.number, SNAPSHOT, MANIFEST, 1, 1);
        vm.expectRevert(SpreadlineFeeDistributor.InvalidSnapshot.selector);
        distributor.proposeEpoch(bytes32(uint256(1)), 999, SNAPSHOT, bytes32(0), 1, 1);
        SpreadlineFeeDistributor.Policy memory p = _policy();
        p.minimumIncome = 1 ether;
        distributor.setPolicy(p);
        vm.expectRevert(SpreadlineFeeDistributor.InvalidAmount.selector);
        _propose(distributor, bytes32(uint256(1)), 1, 0.5 ether);
        _activate(distributor, id);
    }

    function testBoundsRejectOverflowAndInvalidConfiguration() public {
        SpreadlineFeeDistributor.Policy memory p = _policy();
        p.holderBps = 9_000;
        vm.expectRevert(SpreadlineFeeDistributor.InvalidConfiguration.selector);
        distributor.setPolicy(p);
        p = _policy(); p.intervalSeconds = 59;
        vm.expectRevert(SpreadlineFeeDistributor.InvalidConfiguration.selector);
        distributor.setPolicy(p);
        p = _policy(); p.rootDelaySeconds = 899;
        vm.expectRevert(SpreadlineFeeDistributor.InvalidConfiguration.selector);
        distributor.setPolicy(p);
        p = _policy(); p.minimumIncome = type(uint128).max + uint256(1);
        vm.expectRevert(SpreadlineFeeDistributor.InvalidConfiguration.selector);
        distributor.setPolicy(p);
        p = _policy(); p.devWallet = address(distributor);
        vm.expectRevert(SpreadlineFeeDistributor.InvalidConfiguration.selector);
        distributor.setPolicy(p);
        vm.expectRevert(SpreadlineFeeDistributor.InvalidAmount.selector);
        _propose(distributor, bytes32(uint256(1)), type(uint128).max + uint256(1), 1);
        vm.expectRevert(SpreadlineFeeDistributor.InvalidAmount.selector);
        _propose(distributor, bytes32(uint256(1)), 1, type(uint128).max + uint256(1));
    }

    function testLaunchTokenCanBeBoundExactlyOnceAndNotByOperator() public {
        SpreadlineFeeDistributor d = new SpreadlineFeeDistributor(address(0), address(0), address(escrow), address(factory), address(hook), address(this), ALICE, _policy());
        require(d.paused(), "starts paused");
        d.setPaused(false);
        vm.deal(address(d), 1 ether);
        vm.expectRevert(SpreadlineFeeDistributor.TokenNotBound.selector);
        _propose(d, bytes32(uint256(1)), 1, 1 ether);
        vm.prank(ALICE);
        vm.expectRevert(SpreadlineFeeDistributor.Unauthorized.selector);
        d.bindHolderToken(address(holder));
        vm.expectRevert(SpreadlineFeeDistributor.InvalidConfiguration.selector);
        d.bindHolderToken(ALICE);
        _register(d, address(0));
        d.bindHolderToken(address(holder));
        require(d.holderToken() == address(holder), "bound launch token");
        vm.expectRevert(SpreadlineFeeDistributor.InvalidConfiguration.selector);
        d.bindHolderToken(address(reward));
        _single(d, ALICE, 1, 1 ether);
    }

    function testOwnershipRequiresAcceptanceAndOperatorCannotChangePolicy() public {
        vm.prank(ALICE);
        vm.expectRevert(SpreadlineFeeDistributor.Unauthorized.selector);
        distributor.setPolicy(_policy());
        distributor.setOperator(ALICE);
        vm.prank(ALICE);
        vm.expectRevert(SpreadlineFeeDistributor.Unauthorized.selector);
        distributor.setGuardian(ALICE);
        distributor.transferOwnership(BOB);
        require(distributor.owner() == address(this), "ownership not immediate");
        vm.prank(ALICE);
        vm.expectRevert(SpreadlineFeeDistributor.Unauthorized.selector);
        distributor.acceptOwnership();
        vm.prank(BOB);
        distributor.acceptOwnership();
        require(distributor.owner() == BOB && distributor.pendingOwner() == address(0), "accepted owner");
        vm.expectRevert(SpreadlineFeeDistributor.Unauthorized.selector);
        distributor.setPolicy(_policy());
    }

    function testInvalidProofReplayAndDomainSeparation() public {
        uint256 id = _single(distributor, ALICE, 10, 10 ether);
        _activate(distributor, id);
        vm.expectRevert(SpreadlineFeeDistributor.InvalidProof.selector);
        distributor.claim(id, ALICE, 9, _empty());
        vm.expectRevert(SpreadlineFeeDistributor.InvalidProof.selector);
        distributor.claim(id, BOB, 10, _empty());
        bytes32 beforeChain = distributor.leafHash(id, ALICE, 10);
        uint256 originalChain = block.chainid;
        vm.chainId(originalChain + 1);
        require(beforeChain != distributor.leafHash(id, ALICE, 10), "chain in domain");
        vm.expectRevert(SpreadlineFeeDistributor.InvalidProof.selector);
        distributor.claim(id, ALICE, 10, _empty());
        vm.chainId(originalChain);
        SpreadlineFeeDistributor other = _new(address(0));
        require(beforeChain != other.leafHash(id, ALICE, 10), "contract in domain");
        require(beforeChain != distributor.leafHash(id + 1, ALICE, 10), "epoch in domain");
        distributor.claim(id, ALICE, 10, _empty());
        vm.expectRevert(SpreadlineFeeDistributor.AlreadyClaimed.selector);
        distributor.claim(id, ALICE, 10, _empty());
        _eq(distributor.claimable(id, ALICE, 10, _empty()), 0);
    }

    function testMaliciousRootCannotExceedItsReservedHolderBudget() public {
        // Contract cannot prove honest balances/root, but even a dishonest sum cannot raid other epochs.
        uint256 id = distributor.nextEpochId();
        bytes32 a = distributor.leafHash(id, ALICE, 10);
        bytes32 b = distributor.leafHash(id, BOB, 10);
        _propose(distributor, _pair(a, b), 10, 10 ether);
        _activate(distributor, id);
        distributor.claim(id, ALICE, 10, _proof(b));
        vm.expectRevert(SpreadlineFeeDistributor.EpochBudgetExceeded.selector);
        distributor.claim(id, BOB, 10, _proof(a));
        _eq(distributor.claimable(id, BOB, 10, _proof(a)), 0);
        _eq(distributor.totalHolderPaid(), 7.5 ether);
        _eq(distributor.totalReserved(), 2.5 ether);
        _eq(distributor.availableIncome(), 90 ether);
    }

    function testRoundingStaysReservedAndNeverBecomesNewIncome() public {
        uint256 id = distributor.nextEpochId();
        bytes32 a = distributor.leafHash(id, ALICE, 1);
        bytes32 b = distributor.leafHash(id, BOB, 1);
        _propose(distributor, _pair(a, b), 2, 13);
        _activate(distributor, id);
        SpreadlineFeeDistributor.Epoch memory e = distributor.epochs(id);
        _eq(e.holderBudget, 9);
        _eq(e.devBudget, 1);
        _eq(e.treasuryBudget, 3);
        distributor.claim(id, ALICE, 1, _proof(b));
        distributor.claim(id, BOB, 1, _proof(a));
        distributor.withdrawCashFor(DEV);
        distributor.withdrawCashFor(TREASURY);
        _eq(distributor.totalReserved(), 1);
        _eq(distributor.totalHolderAllocated() - distributor.totalHolderPaid(), 1);
        _eq(distributor.availableIncome(), 100 ether - 13);
        _reconciles(distributor, 100 ether);
    }

    function testCashFailureCannotEraseLiabilityAndOnlyOwnerCanRedirectIt() public {
        FeeTestRecipient receiver = new FeeTestRecipient();
        receiver.configure(true, false);
        SpreadlineFeeDistributor.Policy memory p = _policy();
        p.devWallet = address(receiver);
        distributor.setPolicy(p);
        uint256 id = _single(distributor, ALICE, 1, 10 ether);
        _activate(distributor, id);
        vm.expectRevert(SpreadlineFeeDistributor.TransferFailed.selector);
        distributor.withdrawCashFor(address(receiver));
        _eq(distributor.pendingDev(address(receiver)), 1 ether);
        _eq(distributor.totalDevPaid(), 0);
        vm.prank(ALICE);
        vm.expectRevert(SpreadlineFeeDistributor.InvalidAmount.selector);
        distributor.withdrawCash(ALICE);
        vm.prank(address(receiver));
        distributor.withdrawCash(BOB);
        _eq(BOB.balance, 1 ether);
        _eq(distributor.pendingDev(address(receiver)), 0);
    }

    function testBatchAndProofBoundsAndInternalIsolationAuthorization() public {
        SpreadlineFeeDistributor.Claim[] memory claims = new SpreadlineFeeDistributor.Claim[](65);
        vm.expectRevert(SpreadlineFeeDistributor.InvalidBatch.selector);
        distributor.distributeClaims(claims);
        claims = new SpreadlineFeeDistributor.Claim[](0);
        vm.expectRevert(SpreadlineFeeDistributor.InvalidBatch.selector);
        distributor.distributeClaims(claims);
        SpreadlineFeeDistributor.Claim memory c = _claim(1, ALICE, 1, _empty());
        vm.expectRevert(SpreadlineFeeDistributor.Unauthorized.selector);
        distributor.batchClaim(c);
        vm.prank(ALICE);
        vm.expectRevert(SpreadlineFeeDistributor.Unauthorized.selector);
        distributor.distributeClaims(claims);
        uint256 id = _single(distributor, ALICE, 1, 1 ether);
        _activate(distributor, id);
        bytes32[] memory longProof = new bytes32[](65);
        vm.expectRevert(SpreadlineFeeDistributor.InvalidProof.selector);
        distributor.claim(id, ALICE, 1, longProof);
        claims = new SpreadlineFeeDistributor.Claim[](1);
        claims[0] = _claim(id, ALICE, 1, _empty());
        vm.expectRevert(SpreadlineFeeDistributor.InsufficientBatchGas.selector);
        distributor.distributeClaims{gas: 150_000}(claims);
        require(!distributor.hasClaimed(id, ALICE), "low gas must never succeed without payment");
    }

    function testFuzzCashReconciliationForArbitrarySplitsAndWeights(uint128 grossSeed, uint64 aSeed, uint64 bSeed,
        uint16 holderSeed, uint16 devSeed) public {
        uint256 gross = uint256(grossSeed) % (90 ether) + 10_000;
        uint256 aWeight = uint256(aSeed) + 1;
        uint256 bWeight = uint256(bSeed) + 1;
        SpreadlineFeeDistributor.Policy memory p = _policy();
        p.holderBps = uint16(uint256(holderSeed) % 10_000 + 1);
        p.devBps = uint16(uint256(devSeed) % (10_001 - p.holderBps));
        p.treasuryBps = uint16(10_000 - p.holderBps - p.devBps);
        distributor.setPolicy(p);
        uint256 id = distributor.nextEpochId();
        bytes32 a = distributor.leafHash(id, ALICE, aWeight);
        bytes32 b = distributor.leafHash(id, BOB, bWeight);
        _propose(distributor, _pair(a, b), aWeight + bWeight, gross);
        _activate(distributor, id);
        SpreadlineFeeDistributor.Epoch memory e = distributor.epochs(id);
        _eq(e.holderBudget + e.devBudget + e.treasuryBudget, gross);
        uint256 aAmount = e.holderBudget * aWeight / (aWeight + bWeight);
        uint256 bAmount = e.holderBudget * bWeight / (aWeight + bWeight);
        if (aAmount > 0) _eq(distributor.claim(id, ALICE, aWeight, _proof(b)), aAmount);
        if (bAmount > 0) _eq(distributor.claim(id, BOB, bWeight, _proof(a)), bAmount);
        if (e.devBudget > 0) distributor.withdrawCashFor(DEV);
        if (e.treasuryBudget > 0) distributor.withdrawCashFor(TREASURY);
        _eq(distributor.totalHolderPaid(), aAmount + bAmount);
        _eq(distributor.totalReserved(), e.holderBudget - aAmount - bAmount);
        require(distributor.totalReserved() <= 1, "two-holder rounding at most one unit");
        _eq(distributor.availableIncome(), 100 ether - gross);
        _reconciles(distributor, 100 ether);
    }

    function testMaximumBoundedProductDoesNotOverflow() public {
        uint256 max = type(uint128).max;
        vm.deal(address(distributor), max);
        uint256 id = _single(distributor, ALICE, max, max);
        _activate(distributor, id);
        uint256 expected = max * 7_500 / 10_000;
        _eq(distributor.claim(id, ALICE, max, _empty()), expected);
        _eq(distributor.totalHolderPaid(), expected);
        _reconciles(distributor, max);
    }

    function _new(address asset) private returns (SpreadlineFeeDistributor d) {
        d = new SpreadlineFeeDistributor(address(0), asset, address(escrow), address(factory), address(hook), address(this), address(this), _policy());
        _register(d, asset);
        d.bindHolderToken(address(holder));
        d.setPaused(false);
    }

    function _register(SpreadlineFeeDistributor d, address asset) private {
        FeeTestCurve curve = new FeeTestCurve(address(holder), asset, address(d), escrow);
        factory.setLaunch(address(holder), address(curve), address(d), asset, 0, true);
    }

    function _policy() private pure returns (SpreadlineFeeDistributor.Policy memory) {
        return SpreadlineFeeDistributor.Policy({holderBps: 7_500, devBps: 1_000, treasuryBps: 1_500,
            intervalSeconds: 900, rootDelaySeconds: 900, minimumIncome: 1, devWallet: DEV, treasuryWallet: TREASURY});
    }

    function _single(SpreadlineFeeDistributor d, address account, uint256 weight, uint256 gross) private returns (uint256) {
        return _propose(d, d.leafHash(d.nextEpochId(), account, weight), weight, gross);
    }

    function _propose(SpreadlineFeeDistributor d, bytes32 root, uint256 weight, uint256 gross) private returns (uint256) {
        return d.proposeEpoch(root, 999, SNAPSHOT, MANIFEST, weight, gross);
    }

    function _activate(SpreadlineFeeDistributor d, uint256 id) private {
        vm.warp(d.epochs(id).readyAt);
        d.activateEpoch(id);
    }

    function _pair(bytes32 a, bytes32 b) private pure returns (bytes32) {
        return a < b ? keccak256(abi.encodePacked(a, b)) : keccak256(abi.encodePacked(b, a));
    }

    function _proof(bytes32 sibling) private pure returns (bytes32[] memory p) { p = new bytes32[](1); p[0] = sibling; }
    function _empty() private pure returns (bytes32[] memory) { return new bytes32[](0); }
    function _claim(uint256 id, address account, uint256 weight, bytes32[] memory proof) private pure returns (SpreadlineFeeDistributor.Claim memory) {
        return SpreadlineFeeDistributor.Claim(id, account, weight, proof);
    }
    function _eq(uint256 a, uint256 b) private pure { require(a == b, "values differ"); }
    function _reconciles(SpreadlineFeeDistributor d, uint256 cashReceived) private view {
        _eq(d.rewardBalance() + d.totalHolderPaid() + d.totalDevPaid() + d.totalTreasuryPaid(), cashReceived);
        _eq(d.availableIncome() + d.totalReserved(), d.rewardBalance());
        require(d.totalHolderPaid() <= d.totalHolderAllocated(), "holder paid exceeds allocation");
        require(d.totalDevPaid() <= d.totalDevAllocated(), "dev paid exceeds allocation");
        require(d.totalTreasuryPaid() <= d.totalTreasuryAllocated(), "treasury paid exceeds allocation");
    }
}
