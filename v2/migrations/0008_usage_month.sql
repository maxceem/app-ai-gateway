CREATE TABLE `usage_month` (
	`account_id` text NOT NULL,
	`app_id` text NOT NULL,
	`month` text NOT NULL,
	`provider_type` text NOT NULL,
	`provider_connection_id` text NOT NULL,
	`model` text NOT NULL,
	`outcome` text NOT NULL,
	`unit` text NOT NULL,
	`charges` integer DEFAULT 0 NOT NULL,
	`unpriced_charges` integer DEFAULT 0 NOT NULL,
	`cost_nano` integer DEFAULT 0 NOT NULL,
	`input_tokens` integer DEFAULT 0 NOT NULL,
	`cached_input_tokens` integer DEFAULT 0 NOT NULL,
	`cache_write_tokens` integer DEFAULT 0 NOT NULL,
	`output_tokens` integer DEFAULT 0 NOT NULL,
	`units` integer DEFAULT 0 NOT NULL,
	`session_ms` integer DEFAULT 0 NOT NULL,
	PRIMARY KEY(`account_id`, `app_id`, `month`, `provider_type`, `provider_connection_id`, `model`, `outcome`, `unit`),
	CONSTRAINT "usage_month_outcome" CHECK("usage_month"."outcome" IN ('ok', 'failed')),
	CONSTRAINT "usage_month_month" CHECK(length("usage_month"."month") = 7),
	CONSTRAINT "usage_month_cost_integer" CHECK(typeof("usage_month"."cost_nano") = 'integer')
);
--> statement-breakpoint
CREATE INDEX `usage_month_account` ON `usage_month` (`account_id`,`month`);--> statement-breakpoint
CREATE INDEX `budget_day_day` ON `budget_day` (`day`);--> statement-breakpoint
CREATE INDEX `charge_usage_day` ON `charge` (`usage_day`);--> statement-breakpoint
CREATE INDEX `open_work_gave_up` ON `open_work` (`gave_up_at`) WHERE gave_up_at IS NOT NULL;--> statement-breakpoint
CREATE INDEX `session_started` ON `session` (`started_at`);--> statement-breakpoint
CREATE INDEX `usage_day_day` ON `usage_day` (`day`);--> statement-breakpoint
CREATE INDEX `charge_correction_day` ON `charge` (`usage_day`) WHERE kind = 'correction';