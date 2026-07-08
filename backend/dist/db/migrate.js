const PG_SCHEMA = `
CREATE TABLE IF NOT EXISTS guests (
  id              VARCHAR(36) PRIMARY KEY,
  name            VARCHAR(255) NOT NULL,
  email           VARCHAR(255),
  phone           VARCHAR(50),
  company         VARCHAR(255) DEFAULT 'Ospite Individuale',
  host            VARCHAR(255) NOT NULL,
  username        VARCHAR(100) NOT NULL UNIQUE,
  password        VARCHAR(100),
  duration_minutes INTEGER NOT NULL DEFAULT 240,
  elapsed_seconds INTEGER NOT NULL DEFAULT 0,
  status          VARCHAR(20) NOT NULL DEFAULT 'pending',
  created_at      TIMESTAMP NOT NULL DEFAULT NOW(),
  enabled_at      TIMESTAMP,
  remarks         TEXT,
  sede_id         INTEGER,
  CHECK (status IN ('pending','active','expired','deactivated'))
);
CREATE INDEX IF NOT EXISTS idx_guests_status ON guests(status);
CREATE INDEX IF NOT EXISTS idx_guests_created_at ON guests(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_guests_sede_id ON guests(sede_id);

CREATE TABLE IF NOT EXISTS sedi (
  id              SERIAL PRIMARY KEY,
  code            VARCHAR(20) UNIQUE NOT NULL,
  name            VARCHAR(100) NOT NULL,
  city            VARCHAR(100) NOT NULL,
  address         VARCHAR(255),
  wlc_config_id   INTEGER,
  created_at      TIMESTAMP NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_sedi_code ON sedi(code);

CREATE TABLE IF NOT EXISTS wlc_config (
  id              SERIAL PRIMARY KEY,
  host            VARCHAR(255) NOT NULL DEFAULT '172.18.106.100',
  port            INTEGER NOT NULL DEFAULT 443,
  ssh_port        INTEGER NOT NULL DEFAULT 22,
  username        VARCHAR(100) NOT NULL DEFAULT 'admin_guest',
  password        VARCHAR(255) NOT NULL DEFAULT '',
  wlan_ssid       VARCHAR(100) NOT NULL DEFAULT 'Dompe Guest',
  authenticated   BOOLEAN NOT NULL DEFAULT FALSE,
  sede_id         INTEGER
);

CREATE TABLE IF NOT EXISTS email_config (
  id              INTEGER PRIMARY KEY DEFAULT 1,
  smtp_host       VARCHAR(255),
  smtp_port       INTEGER DEFAULT 587,
  sender          VARCHAR(255),
  encryption      VARCHAR(20) DEFAULT 'tls',
  require_auth    BOOLEAN DEFAULT TRUE,
  username        VARCHAR(255),
  password        VARCHAR(255)
);

CREATE TABLE IF NOT EXISTS sms_config (
  id              INTEGER PRIMARY KEY DEFAULT 1,
  gateway_type    VARCHAR(50) DEFAULT 'textbelt',
  api_key         VARCHAR(255),
  sender_id       VARCHAR(11) DEFAULT 'DompeGuest',
  webhook_url     VARCHAR(500)
);

CREATE TABLE IF NOT EXISTS sync_logs (
  id              SERIAL PRIMARY KEY,
  timestamp       TIMESTAMP NOT NULL DEFAULT NOW(),
  action          TEXT NOT NULL,
  method          VARCHAR(10) NOT NULL,
  url             TEXT,
  payload         TEXT,
  status_code     INTEGER
);
`;
export async function runMigrations(client) {
    // Schema bootstrap (CREATE TABLE / CREATE INDEX)
    const statements = PG_SCHEMA
        .split(/;\s*(?:\n|$)/)
        .map((s) => s.trim())
        .filter((s) => s.length > 0);
    for (const stmt of statements) {
        try {
            await client.exec(stmt);
        }
        catch (err) {
            throw new Error(`Migration statement failed: ${stmt.slice(0, 120)}...\n  ${err.message}`);
        }
    }
    // Partial unique index on wlc_config.sede_id (works on PostgreSQL 12+)
    // `NULLS NOT DISTINCT` (PG15+) would be ideal, but this approach is
    // compatible with all supported PostgreSQL versions.
    try {
        await client.exec(`CREATE UNIQUE INDEX IF NOT EXISTS uq_wlc_config_sede_id ON wlc_config(sede_id) WHERE sede_id IS NOT NULL`);
    }
    catch {
        // Best-effort; duplicate bindings prevented by application logic
    }
}
//# sourceMappingURL=migrate.js.map