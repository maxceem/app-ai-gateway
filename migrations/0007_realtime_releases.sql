-- Additive release routing and advisory deployment lease. No customer data changes.
CREATE TABLE realtime_release (
  id TEXT PRIMARY KEY,
  worker_name TEXT NOT NULL UNIQUE,
  url TEXT NOT NULL,
  backend_contract INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  retired_at INTEGER,
  delete_after INTEGER
);
CREATE TABLE IF NOT EXISTS gateway_release_state (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  active_realtime_id TEXT REFERENCES realtime_release(id),
  deployment_owner TEXT,
  deployment_expires_at INTEGER,
  promotion_at INTEGER,
  current_deployment_id TEXT
);
INSERT OR IGNORE INTO gateway_release_state(singleton) VALUES (1);
CREATE TABLE gateway_deployment (
  id TEXT PRIMARY KEY,
  main_version_id TEXT NOT NULL,
  release_version TEXT NOT NULL,
  realtime_id TEXT NOT NULL REFERENCES realtime_release(id),
  backend_contract INTEGER NOT NULL,
  schema_generation INTEGER NOT NULL,
  class_generation INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);

-- A pointer update and its retirement changes are one SQLite transaction.
CREATE TRIGGER realtime_release_promotion AFTER UPDATE OF active_realtime_id ON gateway_release_state
WHEN NEW.active_realtime_id IS NOT OLD.active_realtime_id
BEGIN
  UPDATE realtime_release SET retired_at=NEW.promotion_at, delete_after=NEW.promotion_at + 610260000
    WHERE id=OLD.active_realtime_id;
  UPDATE realtime_release SET retired_at=NULL, delete_after=NULL WHERE id=NEW.active_realtime_id;
END;
