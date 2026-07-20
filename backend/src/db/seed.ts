/**
 * Seed data: populates the database with default config rows,
 * 5 sedi (locations), and email/sms default configs on first run.
 *
 * CREDENTIAL NOTICE:
 *   REAL credentials (WLC admin passwords, SMTP passwords) were previously
 *   hardcoded here and have been REMOVED for security. These credentials
 *   must be set by the operator through the WLC login flow in the UI.
 *   See: https://github.com/{owner}/centralino/security/advisories
 */
import type { DbClient } from './index.js';

interface SedeSeed {
  code: string;
  name: string;
  city: string;
  address: string;
  wlc: { host: string; sshPort: number; username: string; wlanSsid: string };
}

/**
 * Sede (location) data with WLC connection defaults.
 * The WLC PASSWORD is NOT part of the DB/seed (§2): it lives in Key Vault
 * and is injected as WLC_PASSWORD_<CODE>. These are infrastructure defaults
 * (host/IPs/SSID) that are NOT secrets and are safe to keep in source.
 */
const SEDI: SedeSeed[] = [
  {
    code: 'MIL',
    name: 'Dompe Milano HQ',
    city: 'Milano',
    address: 'Via Santa Lucia 6, 20122 Milano (MI)',
    wlc: { host: '172.18.106.100', sshPort: 22, username: 'admin_guest', wlanSsid: 'Dompe Guest' },
  },
  {
    code: 'AQ',
    name: "Dompe L'Aquila",
    city: "L'Aquila",
    address: 'Via Campo di Pile s.n.c., 67100 L\'Aquila (AQ)',
    wlc: { host: '172.18.106.101', sshPort: 22, username: 'admin_guest', wlanSsid: 'Dompe Guest AQ' },
  },
  {
    code: 'NA',
    name: 'Dompe Napoli',
    city: 'Napoli',
    address: 'Via Tommaso De Amicis 95, 80131 Napoli (NA)',
    wlc: { host: '172.18.106.102', sshPort: 22, username: 'admin_guest', wlanSsid: 'Dompe Guest NA' },
  },
  {
    code: 'TIR',
    name: 'Dompe Tirana',
    city: 'Tirana',
    address: 'Arena Center, Hyrja D, Kati 6, Sheshi Italia, Tirana, Albania',
    wlc: { host: '172.18.106.103', sshPort: 22, username: 'admin_guest', wlanSsid: 'Dompe Guest TIR' },
  },
  {
    code: 'SM',
    name: 'Dompe San Mateo',
    city: 'San Mateo',
    address: '400 S El Camino Real, Suite 400, San Mateo, CA 94402, USA',
    wlc: { host: '172.18.106.104', sshPort: 22, username: 'admin_guest', wlanSsid: 'Dompe Guest SM' },
  },
];

export async function runSeed(client: DbClient): Promise<void> {
  // --- Sedi + per-sede WLC configs ---
  const orphan = await client.query(
    `SELECT id FROM wlc_config WHERE sede_id IS NULL ORDER BY id ASC LIMIT 1`,
  );
  const legacyWlcId = orphan.rows.length > 0 ? Number((orphan.rows[0] as { id: number }).id) : null;

  for (let i = 0; i < SEDI.length; i++) {
    const s = SEDI[i];
    const existing = await client.query(`SELECT id FROM sedi WHERE code = ?`, [s.code]);

    if (existing.rows.length > 0) {
      // Update existing sede with corrected data.
      await client.query(
        `UPDATE sedi SET name = ?, city = ?, address = ? WHERE code = ?`,
        [s.name, s.city, s.address, s.code],
      );
      continue;
    }

    // --- Insert new sede ---
    let wlcId: number;
    if (i === 0 && legacyWlcId != null) {
      await client.query(
        `UPDATE wlc_config SET host = ?, port = 443, ssh_port = ?, username = ?, wlan_ssid = ?, authenticated = ?, sede_id = NULL WHERE id = ?`,
        [s.wlc.host, s.wlc.sshPort, s.wlc.username, s.wlc.wlanSsid, false, legacyWlcId],
      );
      wlcId = legacyWlcId;
    } else {
      const wlcRes = await client.query(
        `INSERT INTO wlc_config (host, port, ssh_port, username, wlan_ssid, authenticated)
         VALUES (?, 443, ?, ?, ?, ?) RETURNING id`,
        [s.wlc.host, s.wlc.sshPort, s.wlc.username, s.wlc.wlanSsid, false],
      );
      wlcId = Number((wlcRes.rows[0] as { id: number }).id);
    }

    const sedeRes = await client.query(
      `INSERT INTO sedi (code, name, city, address, wlc_config_id) VALUES (?, ?, ?, ?, ?) RETURNING id`,
      [s.code, s.name, s.city, s.address, wlcId],
    );
    const sedeId = Number((sedeRes.rows[0] as { id: number }).id);

    await client.query(`UPDATE wlc_config SET sede_id = ? WHERE id = ?`, [sedeId, wlcId]);
  }

  // --- Backward-compat: bind orphaned wlc_config rows ---
  const stillOrphan = await client.query(
    `SELECT id FROM wlc_config WHERE sede_id IS NULL ORDER BY id ASC LIMIT 1`,
  );
  if (stillOrphan.rows.length > 0) {
    const wlcId = Number((stillOrphan.rows[0] as { id: number }).id);
    const firstSede = await client.query(`SELECT id FROM sedi ORDER BY id ASC LIMIT 1`);
    if (firstSede.rows.length > 0) {
      const firstSedeId = Number((firstSede.rows[0] as { id: number }).id);
      await client.query(`UPDATE wlc_config SET sede_id = ? WHERE id = ?`, [firstSedeId, wlcId]);
    }
  }

  // Email/SMTP config seed removed (§3): mail is Graph-only, sender is
  // MAIL_GRAPH_FROM_ADDRESS; there is no email_config table.

  // --- Global SMS config ---
  const smsCount = await client.query(`SELECT COUNT(*) as c FROM sms_config`);
  if (Number((smsCount.rows[0] as { c: number }).c) === 0) {
    await client.query(
      `INSERT INTO sms_config (id, gateway_type, api_key, sender_id, webhook_url)
       VALUES (1, 'textbelt', '', 'DompeGuest', '')`,
    );
  }
}
