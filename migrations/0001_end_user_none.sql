-- An api_key application with no end users now states it as
-- `end_user: {"source":"none"}` instead of omitting the block, so every stored
-- configuration that omits it is given the explicit source it meant.
UPDATE `app`
SET `config_json` = json_set(`config_json`, '$.authentication.end_user', json('{"source":"none"}'))
WHERE `auth_type` = 'api_key'
  AND json_extract(`config_json`, '$.authentication.end_user') IS NULL;
