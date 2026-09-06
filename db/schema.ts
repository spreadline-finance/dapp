import { integer, sqliteTable, text, index } from "drizzle-orm/sqlite-core";
export const requestBudgets = sqliteTable(
  "request_budgets",
  {
    key: text("key").primaryKey(),
    windowStart: integer("window_start").notNull(),
    count: integer("count").notNull(),
  },
  (table) => [index("request_budgets_window_idx").on(table.windowStart)],
);
