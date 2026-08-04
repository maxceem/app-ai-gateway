INSERT INTO apps (id, name, config_json, status) VALUES (
  'dev-app',
  'Local Development App',
  '{"authentication":{"type":"apple_app_attest","issuer":{"jwks_url":"https://issuer.example.com/.well-known/jwks.json","user_id_claim":"sub","required_claims":[],"max_token_lifetime_seconds":86400},"app_attest":{"team_id":"AAAAAAAAAA","bundle_id":"com.example.aigateway.dev","environments":["production","development"]},"development_access":true},"routing":{"providers":{"mode":"selected","selected":{"openai":{"allowed_paths":["v1/responses","v1/audio/transcriptions"],"allowed_models":["gpt-5.6-terra","gpt-5.6-sol","gpt-5.6-luna","gpt-4o-mini-transcribe"],"max_output_tokens":8192},"anthropic":{"allowed_paths":["v1/messages"],"allowed_models":["claude-sonnet-5"],"max_output_tokens":8192},"xai":{"allowed_paths":["v1/responses","v1/audio/transcriptions"],"allowed_models":["grok-4.5"],"max_output_tokens":8192},"gemini":{"allowed_paths":["v1beta/models/{model}:generateContent","v1beta/models/{model}:streamGenerateContent"],"allowed_models":["gemini-3.5-flash"],"max_output_tokens":8192}}},"model_rewrites":{}},"limits":{"per_user":{"requests":{"per_minute":10,"per_day":300},"spending":{"monthly_usd":10}},"per_app":{"requests":{"per_minute":null,"per_day":null},"spending":{"monthly_usd":null}}}}',
  'active'
) ON CONFLICT(id) DO UPDATE SET
  name = excluded.name,
  config_json = excluded.config_json,
  status = excluded.status,
  updated_at = datetime('now');

INSERT INTO apps (id, name, config_json, status) VALUES (
  'dev-server',
  'Local Server Tenant',
  '{"authentication":{"type":"api_key","end_user":{"header":"x-end-user-id","required":false,"fallback":"api_key"}},"routing":{"providers":{"mode":"selected","selected":{"openai":{"allowed_paths":["v1/chat/completions"],"allowed_models":["gpt-5.6-terra"],"max_output_tokens":1024},"perplexity":{"allowed_paths":["chat/completions"],"allowed_models":["sonar","sonar-pro"],"max_output_tokens":1024}}},"model_rewrites":{}},"limits":{"per_user":{"requests":{"per_minute":100,"per_day":10000},"spending":{"monthly_usd":10}},"per_app":{"requests":{"per_minute":500,"per_day":50000},"spending":{"monthly_usd":100}}}}',
  'active'
) ON CONFLICT(id) DO UPDATE SET
  name = excluded.name,
  config_json = excluded.config_json,
  status = excluded.status,
  updated_at = datetime('now');

INSERT INTO api_keys (id, app_id, name, key_hash, key_prefix, status) VALUES (
  'key_local_server',
  'dev-server',
  'Known local development key',
  '3eff2abc1015849da225a63a6c55bb8d52be68b17e0c89b87b53b8953a2e9d68',
  'agw_localSer',
  'active'
) ON CONFLICT(id) DO UPDATE SET
  app_id = excluded.app_id,
  name = excluded.name,
  key_hash = excluded.key_hash,
  key_prefix = excluded.key_prefix,
  status = excluded.status;

INSERT INTO development_credentials(app_id, secret_hash, secret_prefix) VALUES (
  'dev-app',
  '1b8321935a775f7889a6dbc1bcc889462529ddfd9c5a7d2556acb56f92349729',
  'dev_localDev'
) ON CONFLICT(app_id) DO UPDATE SET
  secret_hash = excluded.secret_hash,
  secret_prefix = excluded.secret_prefix,
  rotated_at = datetime('now');

INSERT INTO apps (id, name, config_json, status) VALUES (
  'calorie-tracker',
  'Calorie Tracker',
  '{"authentication":{"type":"apple_app_attest","issuer":{"jwks_url":"https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com","user_id_claim":"sub","required_claims":[{"path":"iss","contains":"https://securetoken.google.com/cal-track-9313e"},{"path":"aud","contains":"cal-track-9313e"},{"path":"revenueCatEntitlements","contains":"pro_test"}],"max_token_lifetime_seconds":3600},"app_attest":{"team_id":"7XE4PJV852","bundle_id":"com.maxceem.CalTrack","environments":["production","development"]},"development_access":false},"routing":{"providers":{"mode":"selected","selected":{"openai":{"allowed_paths":["v1/responses","v1/audio/transcriptions"],"allowed_models":["gpt-5.6-terra","gpt-5.6-sol","gpt-5.6-luna","gpt-4o-mini-transcribe","gpt-4o-transcribe","whisper-1"],"max_output_tokens":8192},"xai":{"allowed_paths":["v1/responses",{"path":"v1/stt","fixed_model":"grok-transcribe","clamp":"none"}],"allowed_models":["grok-4.5","grok-4.20-0309-reasoning","grok-4.20-0309-non-reasoning","grok-transcribe"],"max_output_tokens":8192},"gemini":{"allowed_paths":["v1beta/openai/chat/completions"],"allowed_models":["gemini-3.5-flash","gemini-3-flash-preview"],"max_output_tokens":8192}}},"model_rewrites":{}},"limits":{"per_user":{"requests":{"per_minute":10,"per_day":300},"spending":{"monthly_usd":10}},"per_app":{"requests":{"per_minute":null,"per_day":null},"spending":{"monthly_usd":null}}}}',
  'active'
) ON CONFLICT(id) DO UPDATE SET
  name = excluded.name,
  config_json = excluded.config_json,
  status = excluded.status,
  updated_at = datetime('now');
