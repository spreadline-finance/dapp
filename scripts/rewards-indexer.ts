import { erc20Abi, getAddress, zeroAddress, type Address, type Hex, type PublicClient } from "viem";
import { open, readFile, rename } from "node:fs/promises";
import { dirname } from "node:path";

export type HolderCheckpoint = { version: 1; chainId: number; token: Address; deploymentBlock: string; block: string; hash: Hex; balances: [string, string][] };
export type HolderTransfer = { from: Address; to: Address; value: bigint };
export function applyHolderTransfers(balances: Map<string, bigint>, transfers: readonly HolderTransfer[]) {
  for (const transfer of transfers) {
    if (transfer.value < 0n) throw new Error("Negative transfer amount.");
    const from = transfer.from.toLowerCase(), to = transfer.to.toLowerCase();
    if (from !== zeroAddress) {
      const next = (balances.get(from) || 0n) - transfer.value;
      if (next < 0n) throw new Error("Incomplete token history: transfer exceeds indexed balance.");
      if (next) balances.set(from, next); else balances.delete(from);
    }
    if (to !== zeroAddress && transfer.value) balances.set(to, (balances.get(to) || 0n) + transfer.value);
  }
}
export async function atomicJSON(path: string, value: unknown) {
  const temporary = `${path}.${process.pid}.tmp`;
  const file = await open(temporary, "w", 0o600);
  try {
    await file.chmod(0o600);
    await file.writeFile(JSON.stringify(value));
    await file.sync();
  } finally { await file.close(); }
  await rename(temporary, path);
  const directory = await open(dirname(path), "r");
  try { await directory.sync(); } finally { await directory.close(); }
}

/** Index confirmed Transfer history; commit only after every holder matches historical token storage. */
export async function indexHolders(client: PublicClient, options: { chainId: number; token: Address; deploymentBlock: bigint; snapshotBlock: bigint; checkpointPath: string; onProgress?: (block: bigint) => void }) {
  const { token, deploymentBlock, snapshotBlock, checkpointPath } = options;
  if (deploymentBlock <= 0n || deploymentBlock > snapshotBlock) throw new Error("A confirmed token deployment block is required.");
  let checkpoint: HolderCheckpoint | undefined;
  try { checkpoint = JSON.parse(await readFile(checkpointPath, "utf8")) as HolderCheckpoint; } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  const balances = new Map<string, bigint>();
  const snapshotAnchor = await client.getBlock({ blockNumber: snapshotBlock });
  if (snapshotAnchor.number !== snapshotBlock || !snapshotAnchor.hash) throw new Error("A canonical mined snapshot block is required.");
  let fromBlock = deploymentBlock;
  if (checkpoint) {
    if (checkpoint.version !== 1 || checkpoint.chainId !== options.chainId || getAddress(checkpoint.token) !== getAddress(token) || checkpoint.deploymentBlock !== String(deploymentBlock) || BigInt(checkpoint.block) > snapshotBlock) throw new Error("Holder checkpoint does not match this token, deployment or snapshot.");
    const anchor = await client.getBlock({ blockNumber: BigInt(checkpoint.block) });
    if (anchor.hash !== checkpoint.hash) throw new Error("Holder checkpoint was reorganized. Preserve it for review and restart indexing from the deployment block in a new state directory.");
    for (const [account, amount] of checkpoint.balances) {
      if (balances.has(account.toLowerCase()) || account.toLowerCase() === zeroAddress || !/^\d+$/.test(amount) || BigInt(amount) <= 0n) throw new Error("Invalid holder checkpoint.");
      balances.set(getAddress(account).toLowerCase(), BigInt(amount));
    }
    fromBlock = BigInt(checkpoint.block) + 1n;
  }
  let chunk = 1000n;
  while (fromBlock <= snapshotBlock) {
    const toBlock = fromBlock + chunk - 1n < snapshotBlock ? fromBlock + chunk - 1n : snapshotBlock;
    let logs;
    try { logs = await client.getContractEvents({ address: token, abi: erc20Abi, eventName: "Transfer", fromBlock, toBlock, strict: true }); }
    catch (error) { if (chunk <= 1n) throw error; chunk = chunk / 2n || 1n; continue; }
    if (logs.some(log => log.removed)) throw new Error("Removed transfer found while indexing; retry a confirmed snapshot.");
    const [anchor, supply] = await Promise.all([client.getBlock({ blockNumber: toBlock }), client.readContract({ address: token, abi: erc20Abi, functionName: "totalSupply", blockNumber: toBlock })]);
    if (anchor.number !== toBlock || !anchor.hash) throw new Error("A canonical mined history block is required.");
    const seen = new Set<string>();
    for (const log of logs) {
      if (log.blockNumber === null || log.blockNumber < fromBlock || log.blockNumber > toBlock || !log.blockHash
        || log.logIndex === null || !Number.isSafeInteger(log.logIndex) || log.logIndex < 0) throw new Error("Transfer log is outside the requested canonical block range.");
      const key = `${log.blockNumber}:${log.logIndex}`;
      if (seen.has(key)) throw new Error("Duplicate transfer log received while indexing.");
      seen.add(key);
      if (log.blockNumber === toBlock && log.blockHash !== anchor.hash) throw new Error("Token logs and snapshot block disagree.");
    }
    applyHolderTransfers(balances, logs.sort((a, b) => a.blockNumber === b.blockNumber ? a.logIndex - b.logIndex : a.blockNumber < b.blockNumber ? -1 : 1).map(log => log.args));
    if ([...balances.values()].reduce((sum, value) => sum + value, 0n) !== supply) throw new Error("Indexed balances do not equal token totalSupply; refusing an incomplete snapshot.");
    options.onProgress?.(toBlock);
    fromBlock = toBlock + 1n;
  }
  const supply = await client.readContract({ address: token, abi: erc20Abi, functionName: "totalSupply", blockNumber: snapshotBlock });
  if ([...balances.values()].reduce((sum, value) => sum + value, 0n) !== supply) throw new Error("Snapshot balances do not match total supply.");
  // Missing ordinary transfers do not change totalSupply. Reconcile every positive
  // balance against token storage before paying anyone. Together with the supply
  // check this also detects an omitted holder receiving an unindexed transfer.
  const holders = [...balances];
  for (let start = 0; start < holders.length; start += 8) {
    const batch = holders.slice(start, start + 8);
    const stored = await Promise.all(batch.map(([account]) => client.readContract({
      address: token, abi: erc20Abi, functionName: "balanceOf", args: [account as Address], blockNumber: snapshotBlock,
    })));
    for (let i = 0; i < batch.length; i++) if (stored[i] !== batch[i][1]) throw new Error(`Indexed holder balance differs from historical token storage for ${batch[i][0]}; refusing an incomplete or reorganized snapshot.`);
  }
  const block = await client.getBlock({ blockNumber: snapshotBlock });
  if (block.hash !== snapshotAnchor.hash) throw new Error("Snapshot was reorganized during holder verification; no checkpoint was committed.");
  // A failed verification never overwrites the previous known-good checkpoint.
  await atomicJSON(checkpointPath, { version: 1, chainId: options.chainId, token, deploymentBlock: String(deploymentBlock), block: String(snapshotBlock), hash: block.hash,
    balances: holders.map(([account, amount]) => [account, String(amount)]) } satisfies HolderCheckpoint);
  return { balances, block, totalSupply: supply };
}
