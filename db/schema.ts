import { integer, real, sqliteTable, text, index, primaryKey } from "drizzle-orm/sqlite-core";
export const requestBudgets = sqliteTable(
  "request_budgets",
  {
    key: text("key").primaryKey(),
    windowStart: integer("window_start").notNull(),
    count: integer("count").notNull(),
  },
  (table) => [index("request_budgets_window_idx").on(table.windowStart)],
);
export const deskPoolObservations = sqliteTable("desk_pool_observations", {
  symbol: text("symbol").notNull(),
  poolAddress: text("pool_address").notNull(),
  blockNumber: text("block_number").notNull(),
  observedAt: integer("observed_at").notNull(),
  priceUSDG: real("price_usdg"),
  spreadBps: real("spread_bps"),
  active: integer("active", { mode: "boolean" }).notNull(),
  referenceGeneratedAt: text("reference_generated_at"),
}, (table) => [
  primaryKey({ columns: [table.symbol, table.poolAddress, table.blockNumber] }),
  index("desk_pool_observations_time_idx").on(table.symbol, table.observedAt),
]);
export const deskVaultObservations = sqliteTable("desk_vault_observations", {
  vaultAddress: text("vault_address").notNull(),
  blockNumber: text("block_number").notNull(),
  observedAt: integer("observed_at").notNull(),
  managedAssets: text("managed_assets").notNull(),
  totalShares: text("total_shares").notNull(),
  rewardsReserved: text("rewards_reserved").notNull(),
  realizedProfit: text("realized_profit").notNull(),
  totalClaimed: text("total_claimed").notNull(),
}, (table) => [
  primaryKey({ columns: [table.vaultAddress, table.blockNumber] }),
  index("desk_vault_observations_time_idx").on(table.observedAt),
]);
