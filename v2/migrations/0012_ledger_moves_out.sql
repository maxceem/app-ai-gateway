-- Step 8f (D21): the ledger's eight tables move to one ledger object per
-- account (src/do/AccountLedger.ts, src/ledger/schema.ts). No real account has
-- used v2 yet, so nothing is copied. Dropping `charge` drops its rollup trigger.
DROP TABLE `app_auth_event`;--> statement-breakpoint
DROP TABLE `app_rejection_event`;--> statement-breakpoint
DROP TABLE `budget_day`;--> statement-breakpoint
DROP TABLE `charge`;--> statement-breakpoint
DROP TABLE `open_work`;--> statement-breakpoint
DROP TABLE `session`;--> statement-breakpoint
DROP TABLE `usage_day`;--> statement-breakpoint
DROP TABLE `usage_month`;
