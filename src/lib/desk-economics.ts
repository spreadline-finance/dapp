/** USDG amounts use six decimals; gas uses wei. Round costs upward. */
export function deskProfitFloor(gasLimit: bigint, maxFeePerGas: bigint, ethPriceUSDG: bigint, minimumNetUSDG: bigint): bigint {
  if (gasLimit <= BigInt(0) || maxFeePerGas <= BigInt(0) || ethPriceUSDG <= BigInt(0) || minimumNetUSDG <= BigInt(0))
    throw new Error("Positive gas, ETH/USDG price and minimum surplus inputs are required.");
  const scale = BigInt("1000000000000000000");
  return (gasLimit * maxFeePerGas * ethPriceUSDG + scale - BigInt(1)) / scale + minimumNetUSDG;
}

export function deskPriceIsFresh(timestamp: number, now = Date.now()): boolean {
  return Number.isFinite(timestamp) && timestamp <= now + 5000 && now - timestamp <= 300000;
}
