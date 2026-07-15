/// <reference types="vite/client" />
import { useEffect, useState } from 'react';
import { api } from '../api/client';
import { useLocale } from '../i18n';
import { X, Mail, Wifi, Save, Check, Eye, EyeOff, Key, Lock } from './icons';
import type { EmailConfig, WlcConfig } from '../types';

interface Props {
  wlcConfig: WlcConfig;
  onClose: () => void;
  onWlcConfigUpdate: (c: WlcConfig) => void;
}

type Section = 'email' | 'wlc';

const ADMIN_PIN = (import.meta.env.VITE_ADMIN_PIN as string | undefined) ?? '';
const ADMIN_MODE_KEY = 'cgd:adminMode';

export default function ConfigPanel({ wlcConfig, onClose, onWlcConfigUpdate }: Props) {
  const [, , t] = useLocale();
  const [section, setSection] = useState<Section>('email');
  const [email, setEmail] = useState<EmailConfig | null>(null);
  const [wlc, setWlc] = useState<WlcConfig>(wlcConfig);
  const [saved, setSaved] = useState(false);
  const [adminMode, setAdminMode] = useState<boolean>(() => {
    try { return localStorage.getItem(ADMIN_MODE_KEY) === '1'; } catch { return false; }
  });
  const [showAdminPrompt, setShowAdminPrompt] = useState(false);
  const [adminPin, setAdminPin] = useState('');
  const [adminError, setAdminError] = useState<string | null>(null);

  useEffect(() => {
    api.getEmailConfig().then((r) => setEmail(r.data));
  }, []);

  async function saveAll() {
    try {
      if (email) await api.updateEmailConfig(email);
      const updated = await api.updateWlcConfig(wlc);
      onWlcConfigUpdate(updated.data);
      setSaved(true);
      setTimeout(() => setSaved(false), 2200);
    } catch {
      // API error — silently ignored; user sees no saved confirmation
    }
  }

  function toggleAdmin() {
    if (adminMode) {
      setAdminMode(false);
      try { localStorage.removeItem(ADMIN_MODE_KEY); } catch { /* ignore */ }
      return;
    }
    // No PIN configured → grant admin mode without prompt (dev convenience).
    if (!ADMIN_PIN) {
      setAdminMode(true);
      try { localStorage.setItem(ADMIN_MODE_KEY, '1'); } catch { /* ignore */ }
      return;
    }
    setShowAdminPrompt(true);
    setAdminError(null);
  }

  function submitAdminPin(e: React.FormEvent) {
    e.preventDefault();
    if (adminPin === ADMIN_PIN) {
      setAdminMode(true);
      setShowAdminPrompt(false);
      setAdminPin('');
      try { localStorage.setItem(ADMIN_MODE_KEY, '1'); } catch { /* ignore */ }
    } else {
      setAdminError(t('config.adminWrongPin'));
    }
  }

  return (
    <div data-testid="config-panel" className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/60 p-4 backdrop-blur-sm">
      <div className="card flex h-[90vh] w-full max-w-4xl flex-col overflow-hidden shadow-elev">
        <div className="flex items-start justify-between border-b border-slate-200 px-6 py-4">
          <div>
            <h2 className="text-lg font-bold text-navy">{t('config.title')}</h2>
            <p className="text-xs text-slate-500">SMTP · WLC</p>
          </div>
          <div className="flex items-center gap-2">
            <button
              className={`btn-ghost ${adminMode ? 'text-emerald-700' : ''}`}
              onClick={toggleAdmin}
              title={t('config.adminPinEnvHint')}
            >
              {adminMode ? <Eye className="h-4 w-4" /> : <Lock className="h-4 w-4" />}
              <span className="hidden sm:inline">
                {adminMode ? t('config.adminDisable') : t('config.adminEnable')}
              </span>
            </button>
            <button data-testid="config-panel-close" onClick={onClose} className="btn-ghost p-1">
              <X className="h-5 w-5" />
            </button>
          </div>
        </div>

        <div className="flex flex-1 overflow-hidden">
          <nav data-testid="config-panel-nav" className="w-52 border-r border-slate-200 bg-slate-50 p-3">
            {([
              { id: 'email', label: t('config.smtp.title'), icon: <Mail className="h-4 w-4" /> },
              { id: 'wlc', label: t('config.wlc.title'), icon: <Wifi className="h-4 w-4" /> },
            ] as const).map((s) => (
              <button
                key={s.id}
                onClick={() => setSection(s.id)}
                className={`flex w-full items-center gap-2 rounded-lg px-3 py-2 text-sm font-medium transition ${
                  section === s.id ? 'bg-navy text-white shadow' : 'text-slate-600 hover:bg-white'
                }`}
              >
                {s.icon} {s.label}
              </button>
            ))}
          </nav>

          <div className="flex-1 overflow-y-auto p-6">
            {!adminMode && (
              <div className="mb-4 flex items-start gap-2 rounded-lg border border-sky-200 bg-sky-50 p-3 text-sm text-sky-800">
                <EyeOff className="mt-0.5 h-4 w-4 flex-shrink-0" />
                <span>{t('config.sensitiveHidden')}</span>
              </div>
            )}

            {section === 'email' && email && (
              <div className="space-y-4">
                <h3 className="flex items-center gap-2 text-base font-bold text-navy">
                  <Mail className="h-4 w-4" /> {t('config.smtp.title')}
                </h3>
                <div className="grid gap-4 sm:grid-cols-2">
                  <div>
                    <label className="label">{t('config.smtp.host')}</label>
                    <input className="input" value={email.smtpHost ?? ''} onChange={(e) => setEmail({ ...email, smtpHost: e.target.value })} />
                  </div>
                  <div>
                    <label className="label">{t('config.smtp.port')}</label>
                    <input className="input" type="number" value={email.smtpPort} onChange={(e) => setEmail({ ...email, smtpPort: Number(e.target.value) })} />
                  </div>
                  <div>
                    <label className="label">{t('config.smtp.sender')}</label>
                    <input className="input" value={email.sender ?? ''} onChange={(e) => setEmail({ ...email, sender: e.target.value })} />
                  </div>
                  <div>
                    <label className="label">{t('config.smtp.encryption')}</label>
                    <select className="input" value={email.encryption ?? 'tls'} onChange={(e) => setEmail({ ...email, encryption: e.target.value })}>
                      <option value="none">{t('config.enc.none')}</option>
                      <option value="starttls">{t('config.enc.starttls')}</option>
                      <option value="ssl">{t('config.enc.ssl')}</option>
                    </select>
                  </div>
                  <div className="sm:col-span-2 flex items-center gap-2">
                    <input type="checkbox" checked={email.requireAuth} onChange={(e) => setEmail({ ...email, requireAuth: e.target.checked })} id="reqAuth" />
                    <label htmlFor="reqAuth" className="text-sm text-slate-700">{t('config.smtp.requireAuth')}</label>
                  </div>
                  <div>
                    <label className="label">{t('config.smtp.username')}</label>
                    <input className="input" value={email.username ?? ''} onChange={(e) => setEmail({ ...email, username: e.target.value })} />
                  </div>
                  <div>
                    <label className="label flex items-center gap-1.5">
                      <Key className="h-3 w-3" /> {t('config.smtp.password')}
                      {!adminMode && <EyeOff className="h-3 w-3 text-slate-400" />}
                    </label>
                    {adminMode ? (
                      <input className="input" type="password" value={email.password ?? ''} onChange={(e) => setEmail({ ...email, password: e.target.value })} />
                    ) : (
                      <div className="input flex items-center text-slate-400">••••••••</div>
                    )}
                  </div>
                </div>
              </div>
            )}

            {section === 'wlc' && (
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
                        const r = await api.wlcLogin({ host: wlc.host, port: wlc.port, username: wlc.username, password: wlc.password });
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
                    <input className="input" value={wlc.username} onChange={(e) => setWlc({ ...wlc, username: e.target.value })} />
                  </div>
                  <div>
                    <label className="label">{t('config.wlc.ssid')}</label>
                    <input className="input" value={wlc.wlanSsid} onChange={(e) => setWlc({ ...wlc, wlanSsid: e.target.value })} />
                  </div>
                  <div>
                    <label className="label">{t('config.wlc.host')}</label>
                    <input className="input" value={wlc.host} onChange={(e) => setWlc({ ...wlc, host: e.target.value })} />
                  </div>
                  <div>
                    <label className="label">{t('config.wlc.port')}</label>
                    <input className="input" type="number" value={wlc.port} onChange={(e) => setWlc({ ...wlc, port: Number(e.target.value) })} />
                  </div>
                  <div className="sm:col-span-2">
                    <label className="label flex items-center gap-1.5">
                      <Key className="h-3 w-3" /> {t('config.wlc.password')}
                      {!adminMode && <EyeOff className="h-3 w-3 text-slate-400" />}
                    </label>
                    {adminMode ? (
                      <input className="input" type="password" value={wlc.password} onChange={(e) => setWlc({ ...wlc, password: e.target.value })} />
                    ) : (
                      <div className="input flex items-center text-slate-400">••••••••</div>
                    )}
                  </div>
                </div>
              </div>
            )}
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

      {showAdminPrompt && (
        <div className="fixed inset-0 z-[60] flex items-center justify-center bg-slate-900/60 p-4 backdrop-blur-sm">
          <form onSubmit={submitAdminPin} className="card w-full max-w-sm p-6 shadow-elev">
            <div className="flex items-center gap-3">
              <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-navy text-white">
                <Key className="h-5 w-5" />
              </div>
              <div>
                <h3 className="text-base font-bold text-slate-800">{t('config.adminEnable')}</h3>
                <p className="text-xs text-slate-500">{t('config.adminPrompt')}</p>
              </div>
            </div>
            <input
              className="input mt-4"
              type="password"
              autoFocus
              value={adminPin}
              onChange={(e) => setAdminPin(e.target.value)}
            />
            {adminError && <div className="mt-2 text-sm text-rose-600">{adminError}</div>}
            <div className="mt-4 flex justify-end gap-2">
              <button type="button" className="btn-ghost" onClick={() => setShowAdminPrompt(false)}>
                {t('create.cancel')}
              </button>
              <button type="submit" className="btn-primary">{t('config.save')}</button>
            </div>
          </form>
        </div>
      )}
    </div>
  );
}
