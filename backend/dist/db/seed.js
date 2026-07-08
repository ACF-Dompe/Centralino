/**
 * Sede (location) data with WLC connection defaults.
 * The WLC PASSWORD is intentionally empty — the operator must set it
 * via the UI login flow. These are infrastructure defaults (host/IPs)
 * that are NOT secrets and are safe to keep in source.
 */
const SEDI = [
    {
        code: 'MIL',
        name: 'Dompe Milano HQ',
        city: 'Milano',
        address: 'Via Santa Lucia 6, 20122 Milano (MI)',
        wlc: { host: '172.18.106.100', sshPort: 22, username: 'admin_guest', password: '', wlanSsid: 'Dompe Guest' },
    },
    {
        code: 'AQ',
        name: "Dompe L'Aquila",
        city: "L'Aquila",
        address: 'Via Campo di Pile s.n.c., 67100 L\'Aquila (AQ)',
        wlc: { host: '172.18.106.101', sshPort: 22, username: 'admin_guest', password: '', wlanSsid: 'Dompe Guest AQ' },
    },
    {
        code: 'NA',
        name: 'Dompe Napoli',
        city: 'Napoli',
        address: 'Via Tommaso De Amicis 95, 80131 Napoli (NA)',
        wlc: { host: '172.18.106.102', sshPort: 22, username: 'admin_guest', password: '', wlanSsid: 'Dompe Guest NA' },
    },
    {
        code: 'TIR',
        name: 'Dompe Tirana',
        city: 'Tirana',
        address: 'Arena Center, Hyrja D, Kati 6, Sheshi Italia, Tirana, Albania',
        wlc: { host: '172.18.106.103', sshPort: 22, username: 'admin_guest', password: '', wlanSsid: 'Dompe Guest TIR' },
    },
    {
        code: 'SM',
        name: 'Dompe San Mateo',
        city: 'San Mateo',
        address: '400 S El Camino Real, Suite 400, San Mateo, CA 94402, USA',
        wlc: { host: '172.18.106.104', sshPort: 22, username: 'admin_guest', password: '', wlanSsid: 'Dompe Guest SM' },
    },
];
export async function runSeed(client) {
    // --- Sedi + per-sede WLC configs ---
    const orphan = await client.query(`SELECT id FROM wlc_config WHERE sede_id IS NULL ORDER BY id ASC LIMIT 1`);
    const legacyWlcId = orphan.rows.length > 0 ? Number(orphan.rows[0].id) : null;
    for (let i = 0; i < SEDI.length; i++) {
        const s = SEDI[i];
        const existing = await client.query(`SELECT id FROM sedi WHERE code = ?`, [s.code]);
        if (existing.rows.length > 0) {
            // Update existing sede with corrected data.
            await client.query(`UPDATE sedi SET name = ?, city = ?, address = ? WHERE code = ?`, [s.name, s.city, s.address, s.code]);
            continue;
        }
        // --- Insert new sede ---
        let wlcId;
        if (i === 0 && legacyWlcId != null) {
            await client.query(`UPDATE wlc_config SET host = ?, port = 443, ssh_port = ?, username = ?, password = ?, wlan_ssid = ?, authenticated = ?, sede_id = NULL WHERE id = ?`, [s.wlc.host, s.wlc.sshPort, s.wlc.username, s.wlc.password, s.wlc.wlanSsid, false, legacyWlcId]);
            wlcId = legacyWlcId;
        }
        else {
            const wlcRes = await client.query(`INSERT INTO wlc_config (host, port, ssh_port, username, password, wlan_ssid, authenticated)
         VALUES (?, 443, ?, ?, ?, ?, ?) RETURNING id`, [s.wlc.host, s.wlc.sshPort, s.wlc.username, s.wlc.password, s.wlc.wlanSsid, false]);
            wlcId = Number(wlcRes.rows[0].id);
        }
        const sedeRes = await client.query(`INSERT INTO sedi (code, name, city, address, wlc_config_id) VALUES (?, ?, ?, ?, ?) RETURNING id`, [s.code, s.name, s.city, s.address, wlcId]);
        const sedeId = Number(sedeRes.rows[0].id);
        await client.query(`UPDATE wlc_config SET sede_id = ? WHERE id = ?`, [sedeId, wlcId]);
    }
    // --- Backward-compat: bind orphaned wlc_config rows ---
    const stillOrphan = await client.query(`SELECT id FROM wlc_config WHERE sede_id IS NULL ORDER BY id ASC LIMIT 1`);
    if (stillOrphan.rows.length > 0) {
        const wlcId = Number(stillOrphan.rows[0].id);
        const firstSede = await client.query(`SELECT id FROM sedi ORDER BY id ASC LIMIT 1`);
        if (firstSede.rows.length > 0) {
            const firstSedeId = Number(firstSede.rows[0].id);
            await client.query(`UPDATE wlc_config SET sede_id = ? WHERE id = ?`, [firstSedeId, wlcId]);
        }
    }
    // --- Global email config ---
    const emailCount = await client.query(`SELECT COUNT(*) as c FROM email_config`);
    if (Number(emailCount.rows[0].c) === 0) {
        await client.query(`INSERT INTO email_config (id, smtp_host, smtp_port, sender, encryption, require_auth, username, password)
       VALUES (1, 'smtp.dompe.com', 587, 'it.security@dompe.com', 'tls', true, 'it.security@dompe.com', '')`);
    }
    // --- Global SMS config ---
    const smsCount = await client.query(`SELECT COUNT(*) as c FROM sms_config`);
    if (Number(smsCount.rows[0].c) === 0) {
        await client.query(`INSERT INTO sms_config (id, gateway_type, api_key, sender_id, webhook_url)
       VALUES (1, 'textbelt', '', 'DompeGuest', 'https://api.textbelt.com/text')`);
    }
}
//# sourceMappingURL=seed.js.map