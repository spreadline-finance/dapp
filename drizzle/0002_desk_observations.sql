CREATE TABLE `desk_pool_observations` (
	`symbol` text NOT NULL,
	`pool_address` text NOT NULL,
	`block_number` text NOT NULL,
	`observed_at` integer NOT NULL,
	`price_usdg` real,
	`spread_bps` real,
	`active` integer NOT NULL,
	`reference_generated_at` text,
	PRIMARY KEY(`symbol`, `pool_address`, `block_number`)
);
--> statement-breakpoint
CREATE INDEX `desk_pool_observations_time_idx` ON `desk_pool_observations` (`symbol`,`observed_at`);--> statement-breakpoint
CREATE TABLE `desk_vault_observations` (
	`vault_address` text NOT NULL,
	`block_number` text NOT NULL,
	`observed_at` integer NOT NULL,
	`managed_assets` text NOT NULL,
	`total_shares` text NOT NULL,
	`rewards_reserved` text NOT NULL,
	`realized_profit` text NOT NULL,
	`total_claimed` text NOT NULL,
	PRIMARY KEY(`vault_address`, `block_number`)
);
--> statement-breakpoint
CREATE INDEX `desk_vault_observations_time_idx` ON `desk_vault_observations` (`observed_at`);