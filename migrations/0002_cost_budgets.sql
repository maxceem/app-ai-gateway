ALTER TABLE `apps` ADD `monthly_user_budget_microusd` integer
	CONSTRAINT "apps_monthly_user_budget_microusd_check"
	CHECK(`monthly_user_budget_microusd` IS NULL OR `monthly_user_budget_microusd` >= 0);
--> statement-breakpoint
ALTER TABLE `apps` ADD `monthly_app_budget_microusd` integer
	CONSTRAINT "apps_monthly_app_budget_microusd_check"
	CHECK(`monthly_app_budget_microusd` IS NULL OR `monthly_app_budget_microusd` >= 0);
