/// <reference types="vite/client" />
import { useState } from 'react';
import { api } from '../api/client';
import { useLocale } from '../i18n';
import { X, Wifi, Save, Check } from './icons';
import type { WlcConfig } from '../types';

interface Props {
  wlcConfig: WlcConfig;
  onClose: () => void;
  onWlcConfigUpdate: (c: WlcConfig) => void;
}

// NOTE: the SMTP/email section has been removed (§3 — mail is Graph-only) and
// the WLC password field has been removed (§2 — the password lives in Key
// Vault, injected per sede as an env var). No secrets are edited here anymore,
// so the former admin-mode / "sensitive hidden" gating is gone too.
export default function ConfigPanel({ wlcConfig, onClose, onWlcConfigUpdate }: Props) {
  const [, , t] = useLocale();
  const [wlc, setWlc] = useState<WlcConfig>(wlcConfig);
  const [saved, setSaved] = useState(false);

  async function saveAll() {
    try {
      const updated = await api.updateWlcConfig(wlc);
      onWlcConfigUpdate(updated.data);
      setSaved(true);
      setTimeout(() => setSaved(false), 2200);
    } catch {
      // API error — silently ignored; user sees no saved confirmation
    }
  }

  return (
    <div data-testid="config-panel" className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/60 p-4 backdrop-blur-sm">
      <div className="card flex max-h-[90vh] w-full max-w-2xl flex-col overflow-hidden shadow-elev">
        <div className="flex items-start justify-between border-b border-slate-200 px-6 py-4">
          <div>
            <h2 className="text-lg font-bold text-navy">{t('config.title')}</h2>
            <p className="text-xs text-slate-500">WLC</p>
          </div>
          <button data-testid="config-panel-close" onClick={onClose} className="btn-ghost p-1">
            <X className="h-5 w-5" />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto p-6">
          <div className="space-y-4">
            <h3 className="flex items-center gap-2 text-base font-bold text-navy">
              <Wifi className="h-4 w-4" /> {t('config.wlc.title')}
            </h3>
            <div className="rounded-lg border border-slate-200 bg-slate-50 p-4">
              <div className="flex items-center justify-between">
                <div>
                  <div className="text-[10px] font-semibold uppercase tracking-widest text-slate-500">{t('config.wlc.status')}</div>
                  <div className={`mt-1 text-sm font-semibold ${wlc.authenticated ? 'text-emerald-700' : 'text-amber-700'}`}>
                    {wlc.authenticated ? `● ${t('config.wlc.online')}` : `● ${t('config.wlc.offline')}`}
                  </div>
                </div>
                <button
                  className="btn-ghost"
                  onClick={async () => {
                    // The WLC password is resolved server-side from Key Vault by
                    // sede — the client never sends it (§2).
                    const r = await api.wlcLogin({ host: wlc.host, port: wlc.port, username: wlc.username, sedeId: wlc.sedeId ?? undefined });
                    if (r.success) {
                      const updated = await api.updateWlcConfig({ authenticated: true });
                      onWlcConfigUpdate(updated.data);
                    } else {
                      alert(r.error ?? t('config.wlc.connectionError'));
                    }
                  }}
                >
                  {t('config.wlc.test')}
                </button>
              </div>
            </div>

            <div className="grid gap-4 sm:grid-cols-2">
              <div>
                <label className="label">{t('config.wlc.account')}</label>
                <input data-testid="wlc-username" className="input" value={wlc.username} onChange={(e) => setWlc({ ...wlc, username: e.target.value })} />
              </div>
              <div>
                <label className="label">{t('config.wlc.ssid')}</label>
                <input data-testid="wlc-ssid" className="input" value={wlc.wlanSsid} onChange={(e) => setWlc({ ...wlc, wlanSsid: e.target.value })} />
              </div>
              <div>
                <label className="label">{t('config.wlc.host')}</label>
                <input data-testid="wlc-host" className="input" value={wlc.host} onChange={(e) => setWlc({ ...wlc, host: e.target.value })} />
              </div>
              <div>
                <label className="label">{t('config.wlc.port')}</label>
                <input className="input" type="number" value={wlc.port} onChange={(e) => setWlc({ ...wlc, port: Number(e.target.value) })} />
              </div>
            </div>
          </div>
        </div>

        <div className="flex items-center justify-between border-t border-slate-200 bg-slate-50 px-6 py-3">
          <div className="text-xs">
            {saved && (
              <span className="inline-flex items-center gap-1 font-medium text-emerald-600">
                <Check className="h-3.5 w-3.5" /> {t('config.saved')}
              </span>
            )}
          </div>
          <button className="btn-primary" onClick={saveAll}>
            <Save className="h-4 w-4" /> {t('config.save')}
          </button>
        </div>
      </div>
    </div>
  );
}
