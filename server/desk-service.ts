import { createPublicClient, getAddress, isAddress, keccak256, parseAbi, zeroAddress, type Address } from "viem";
import { CHAIN_ID, SWAP_ROUTER, TRACKED_SYMBOLS, USDG, type Catalog, type PoolBook, type PriceBook } from "../src/lib/market-types";
import { deskVaultAbi } from "../src/lib/desk-contract";
import type { DeskEvent, DeskHistory, DeskPoolBoard, DeskSnapshot } from "../src/lib/desk-types";
import { requestTransport } from "./rpc";

const tokenAbi = parseAbi([
  "function decimals() view returns (uint8)",
  "function balanceOf(address) view returns (uint256)",
  "function allowance(address,address) view returns (uint256)",
]);
const eventAbi = parseAbi([
  "event Deposited(address indexed caller,address indexed receiver,uint256 assets,uint256 shares)",
  "event Withdrawn(address indexed caller,address indexed receiver,uint256 assets,uint256 shares)",
  "event RewardsClaimed(address indexed account,address indexed receiver,uint256 assets)",
  "event ArbitrageExecuted(address indexed operator,address indexed stock,uint24 buyFee,uint24 sellFee,uint256 assetsIn,uint256 profit,uint256 rewards,uint256 retained)",
]);
const policy = { rewardShareBps: 7500, retainedShareBps: 2500, strategy: "atomic-arbitrage" } as const;
const EVENT_RANGE = 5000n;
const EVENT_CHUNK = 1000n;
const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
type DeskConfig = { [Key in keyof Pick<Env, "DESK_VAULT_ADDRESS" | "DESK_VAULT_CODE_HASH" | "DESK_VAULT_DEPLOY_BLOCK">]: string };
type MarketReads = {
  catalog(): Promise<Catalog>;
  prices(symbols: string[]): Promise<PriceBook>;
  pools(symbol: string): Promise<PoolBook>;
};

/** A spot spread is a market observation, never a forecast of executable profit. */
export function makeDeskPoolBoard(catalog: Catalog, book: PoolBook, prices: PriceBook | null, now = Date.now()): DeskPoolBoard {
  const asset = catalog.assets.find((item) => item.symbol === book.symbol && item.active);
  if (!asset) throw new Error("The pool asset is not active in the official registry.");
  const raw = prices?.quotes.find((item) => item.symbol === book.symbol);
  const multiplier = Number(asset.multiplier);
  const bid = raw ? Number(raw.bid) * multiplier : NaN;
  const ask = raw ? Number(raw.ask) * multiplier : NaN;
  const reference = raw && Number.isFinite(bid) && bid > 0 && Number.isFinite(ask) && ask >= bid
    ? { bid, ask, generatedAt: raw.generatedAt, halted: raw.halted, cached: Boolean(prices?.cachedSymbols?.includes(book.symbol) || prices?.dataStatus) } : null;
  const referenceAge = reference ? now - Date.parse(reference.generatedAt) : Infinity;
  const comparable = reference && !reference.halted && referenceAge >= -10000 && referenceAge <= 120000 && !prices?.cachedSymbols?.includes(book.symbol) && !prices?.dataStatus && !catalog.dataStatus && !book.dataStatus;
  const midpoint = reference ? (reference.bid + reference.ask) / 2 : 0;
  const dataStatus = book.dataStatus || catalog.dataStatus || prices?.dataStatus;
  return {
    symbol: book.symbol, tokenAddress: asset.address,
    fetchedAt: book.fetchedAt, blockNumber: book.blockNumber, blockTimestamp: book.blockTimestamp,
    reference,
    pools: book.pools.map((pool) => {
      const spread = comparable && pool.active && pool.priceUSDG !== null ? (pool.priceUSDG / midpoint - 1) * 10000 : NaN;
      return { ...pool, spreadBps: Number.isFinite(spread) ? spread : null };
    }),
    failedReads: book.failedReads,
    ...(dataStatus ? { dataStatus } : {}),
  };
}

export function createDeskService(rpcUrl: string, config: DeskConfig, markets: MarketReads) {
  async function snapshot(account?: Address): Promise<DeskSnapshot> {
    const base: DeskSnapshot = {
      chainId: CHAIN_ID, fetchedAt: new Date().toISOString(), blockNumber: null, blockTimestamp: null,
      status: "unconfigured", message: "The shared desk vault has not been activated. Pool observations are live; no deposits or earnings are recorded here yet.",
      policy, vault: null, wallet: null, events: [], eventsFromBlock: null, eventsError: null,
    };
    const configured = config.DESK_VAULT_ADDRESS?.trim();
    if (!configured) return base;
    if (!isAddress(configured, { strict: false }) || same(configured, zeroAddress))
      return { ...base, status: "unavailable", message: "The desk vault address is not valid. Deposits remain unavailable." };
    if (!/^0x[\da-f]{64}$/i.test(config.DESK_VAULT_CODE_HASH ?? ""))
      return { ...base, status: "unavailable", message: "The desk vault is awaiting verification of its deployed contract code. Deposits remain unavailable." };
    if (!/^\d{1,16}$/.test(config.DESK_VAULT_DEPLOY_BLOCK ?? ""))
      return { ...base, status: "unavailable", message: "The desk vault deployment block is not configured correctly." };
    const address = getAddress(configured);
    const client = createPublicClient({ transport: requestTransport(rpcUrl) });
    try {
      const [chainId, block] = await Promise.all([client.getChainId(), client.getBlock({ blockTag: "latest" })]);
      if (chainId !== CHAIN_ID) throw new Error("wrong_chain");
      const age = Date.now() - Number(block.timestamp) * 1000;
      if (age > 120000 || age < -10000) throw new Error("stale_block");
      const at = { blockNumber: block.number };
      const code = await client.getCode({ address, ...at });
      if (!code || code === "0x" || !same(keccak256(code), config.DESK_VAULT_CODE_HASH)) throw new Error("unverified_code");
      const [settlement, router, operator, decimals, managedAssets, totalShares, totalRewardsReserved, totalRealizedProfit, totalClaimed, maxTradeAssets, paused, rewardBps] = await Promise.all([
        client.readContract({ address, abi: deskVaultAbi, functionName: "settlement", ...at }),
        client.readContract({ address, abi: deskVaultAbi, functionName: "router", ...at }),
        client.readContract({ address, abi: deskVaultAbi, functionName: "operator", ...at }),
        client.readContract({ address: USDG, abi: tokenAbi, functionName: "decimals", ...at }),
        client.readContract({ address, abi: deskVaultAbi, functionName: "managedAssets", ...at }),
        client.readContract({ address, abi: deskVaultAbi, functionName: "totalShares", ...at }),
        client.readContract({ address, abi: deskVaultAbi, functionName: "totalRewardsReserved", ...at }),
        client.readContract({ address, abi: deskVaultAbi, functionName: "totalRealizedProfit", ...at }),
        client.readContract({ address, abi: deskVaultAbi, functionName: "totalClaimed", ...at }),
        client.readContract({ address, abi: deskVaultAbi, functionName: "maxTradeAssets", ...at }),
        client.readContract({ address, abi: deskVaultAbi, functionName: "paused", ...at }),
        client.readContract({ address, abi: deskVaultAbi, functionName: "REWARD_BPS", ...at }),
      ]);
      if (!same(settlement, USDG) || !same(router, SWAP_ROUTER) || decimals !== 6 || rewardBps !== 7500n || same(operator, zeroAddress)) throw new Error("vault_configuration_mismatch");
      const result: DeskSnapshot = {
        ...base, status: "ready", fetchedAt: new Date().toISOString(), blockNumber: String(block.number),
        blockTimestamp: new Date(Number(block.timestamp) * 1000).toISOString(),
        message: paused ? "Strategy execution is paused. Confirmed balances and earned rewards remain visible." : "Vault balances and rewards are read from the verified desk contract on Robinhood Chain.",
        vault: { address, operator, settlement, router, managedAssets: String(managedAssets), totalShares: String(totalShares), totalRewardsReserved: String(totalRewardsReserved), totalRealizedProfit: String(totalRealizedProfit), totalClaimed: String(totalClaimed), maxTradeAssets: String(maxTradeAssets), paused },
      };
      if (account) {
        const [shares, earned, balance, allowance] = await Promise.all([
          client.readContract({ address, abi: deskVaultAbi, functionName: "sharesOf", args: [account], ...at }),
          client.readContract({ address, abi: deskVaultAbi, functionName: "earned", args: [account], ...at }),
          client.readContract({ address: USDG, abi: tokenAbi, functionName: "balanceOf", args: [account], ...at }),
          client.readContract({ address: USDG, abi: tokenAbi, functionName: "allowance", args: [account, address], ...at }),
        ]);
        const assets = await client.readContract({ address, abi: deskVaultAbi, functionName: "previewRedeem", args: [shares], ...at });
        result.wallet = { address: account, shares: String(shares), redeemableAssets: String(assets), claimableAssets: String(earned), assetBalance: String(balance), allowance: String(allowance) };
      }
      const floor = BigInt(config.DESK_VAULT_DEPLOY_BLOCK);
      if (floor > block.number) throw new Error("future_deployment_block");
      const recentFloor = block.number > EVENT_RANGE - 1n ? block.number - EVENT_RANGE + 1n : 0n;
      const fromBlock = floor > recentFloor ? floor : recentFloor;
      result.eventsFromBlock = String(fromBlock);
      try {
        const ranges: { fromBlock: bigint; toBlock: bigint }[] = [];
        for (let start = fromBlock; start <= block.number; start += EVENT_CHUNK)
          ranges.push({ fromBlock: start, toBlock: start + EVENT_CHUNK - 1n < block.number ? start + EVENT_CHUNK - 1n : block.number });
        // Each bounded range is independent. A failed range makes the history
        // explicitly unavailable rather than presenting an incomplete payout total.
        const batches = await Promise.all(ranges.map((range) => client.getLogs({ address, events: eventAbi, ...range, strict: true })));
        const logs = batches.flat().filter((log) => !log.removed).sort((a, b) => a.blockNumber === b.blockNumber ? a.logIndex - b.logIndex : a.blockNumber < b.blockNumber ? -1 : 1).slice(-80).reverse();
        result.events = logs.map((log): DeskEvent => {
          const common = { id: `${log.transactionHash}:${log.logIndex}`, transactionHash: log.transactionHash, blockNumber: String(log.blockNumber), rewards: null, retained: null };
          if (log.eventName === "Deposited") return { ...common, kind: "deposit", account: log.args.receiver, assets: String(log.args.assets) };
          if (log.eventName === "Withdrawn") return { ...common, kind: "withdrawal", account: log.args.caller, assets: String(log.args.assets) };
          if (log.eventName === "RewardsClaimed") return { ...common, kind: "claim", account: log.args.account, assets: String(log.args.assets) };
          return { ...common, kind: "profit", account: log.args.operator, assets: String(log.args.profit), rewards: String(log.args.rewards), retained: String(log.args.retained) };
        });
      } catch {
        result.eventsError = "Recent contract events could not be loaded. Vault lifetime totals above are still read directly from the contract.";
      }
      return result;
    } catch (error) {
      console.error(JSON.stringify({ event: "desk_snapshot_unavailable", errorType: error instanceof Error ? error.name : "Unknown" }));
      return { ...base, status: "unavailable", message: "The desk contract could not be verified at a fresh chain block. Balances and deposit actions are temporarily unavailable." };
    }
  }

  async function pools(symbol: string): Promise<DeskPoolBoard> {
    // Populate the shared registry cache before pools() needs the same source.
    const catalog = await markets.catalog();
    const [book, reference] = await Promise.allSettled([markets.pools(symbol), markets.prices([symbol])]);
    if (book.status === "rejected") throw book.reason;
    return makeDeskPoolBoard(catalog, book.value, reference.status === "fulfilled" ? reference.value : null);
  }
  return { snapshot, pools };
}

type PoolObservationRow = { observed_at: number; block_number: string; pool_address: Address; price_usdg: number | null; spread_bps: number | null; active: number; reference_generated_at: string | null };
export async function readDeskHistory(db: D1Database, symbol: string): Promise<DeskHistory> {
  const result: DeskHistory = { symbol, fetchedAt: new Date().toISOString(), status: "empty", message: "No recorded observations for this symbol yet. The scheduled desk recorder collects pool measurements independently of visitors.", points: [] };
  try {
    const rows = await db.prepare("SELECT observed_at, block_number, pool_address, price_usdg, spread_bps, active, reference_generated_at FROM desk_pool_observations WHERE symbol = ? ORDER BY observed_at DESC, pool_address LIMIT 120").bind(symbol).all<PoolObservationRow>();
    result.points = rows.results.reverse().map((row) => ({ observedAt: new Date(row.observed_at).toISOString(), blockNumber: row.block_number, poolAddress: row.pool_address, priceUSDG: row.price_usdg, spreadBps: row.spread_bps, active: row.active === 1, referenceGeneratedAt: row.reference_generated_at }));
    if (result.points.length) { result.status = "ready"; result.message = "Recorded pool observations. Spot spread does not include trade impact, gas or an executable return."; }
  } catch {
    result.status = "unavailable"; result.message = "Recorded history is unavailable. The desk database migration and scheduled recorder must be active.";
  }
  return result;
}

export async function recordDeskObservation(db: D1Database, board: DeskPoolBoard | null, snapshot: DeskSnapshot | null) {
  const statements = board ? board.pools.map((pool) => db.prepare("INSERT OR IGNORE INTO desk_pool_observations (symbol,pool_address,block_number,observed_at,price_usdg,spread_bps,active,reference_generated_at) VALUES (?,?,?,?,?,?,?,?)").bind(board.symbol, pool.address.toLowerCase(), board.blockNumber, Date.parse(board.fetchedAt), pool.priceUSDG, pool.spreadBps, Number(pool.active), board.reference?.generatedAt ?? null)) : [];
  if (snapshot?.status === "ready" && snapshot.vault && snapshot.blockNumber) {
    const vault = snapshot.vault;
    statements.push(db.prepare("INSERT OR IGNORE INTO desk_vault_observations (vault_address,block_number,observed_at,managed_assets,total_shares,rewards_reserved,realized_profit,total_claimed) VALUES (?,?,?,?,?,?,?,?)").bind(vault.address.toLowerCase(), snapshot.blockNumber, Date.parse(snapshot.fetchedAt), vault.managedAssets, vault.totalShares, vault.totalRewardsReserved, vault.totalRealizedProfit, vault.totalClaimed));
  }
  if (statements.length) await db.batch(statements);
  const before = Date.now() - 30 * 86400000;
  await db.batch([
    db.prepare("DELETE FROM desk_pool_observations WHERE rowid IN (SELECT rowid FROM desk_pool_observations WHERE observed_at < ? LIMIT 1000)").bind(before),
    db.prepare("DELETE FROM desk_vault_observations WHERE rowid IN (SELECT rowid FROM desk_vault_observations WHERE observed_at < ? LIMIT 1000)").bind(before),
  ]);
}

/** One asset per tick keeps the public RPC budget bounded. */
export function deskScheduledSymbol(scheduledTime: number) {
  return TRACKED_SYMBOLS[Math.floor(scheduledTime / 300000) % TRACKED_SYMBOLS.length];
}
