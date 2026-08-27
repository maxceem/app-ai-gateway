ALTER TABLE `app_usage_event` ADD `api_key_id` text;--> statement-breakpoint
UPDATE `app`
   SET `config_json` = json_remove(
     `config_json`,
     '$.authentication.development_access',
     '$.authentication.app_attest.environments'
   )
 WHERE json_valid(`config_json`);
