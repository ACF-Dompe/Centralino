import { useEffect, useState } from 'react';
import { api, type SamlUser } from '../api/client';
import { useLocale } from '../i18n';
import { Key, AlertTriangle, Building, MapPin, ArrowRight, Loader2, User } from './icons';
import type { Sede, WlcConfig } from '../types';

interface LoginProps {
  ssoUser?: SamlUser;
  onAuthenticated: (cfg: WlcConfig, sede: Sede) => void;
}

export default function Login({ ssoUser, onAuthenticated }: LoginProps) {
  const [, , t] = useLocale();
  const [sedi, setSedi] = useState<Sede[]>([]);
  const [selectedSede, setSelectedSede] = useState<Sede | null>(null);
  const [loadingSedi, setLoadingSedi] = useState(true);

  useEffect(() => {
    api.listSedi()
      .then((r) => setSedi(r.data))
      .catch(() => setSedi([]))
      .finally(() => setLoadingSedi(false));
  }, []);

  return (
    <div className="grid min-h-screen lg:grid-cols-2">
      {/* Brand panel */}
      <div className="relative hidden flex-col justify-between overflow-hidden bg-navy p-12 text-white lg:flex">
        <div className="absolute -right-32 -top-32 h-96 w-96 rounded-full bg-white/5 blur-2xl" />
        <div className="absolute -bottom-32 -left-16 h-80 w-80 rounded-full bg-brand-red/20 blur-2xl" />
        <div className="flex items-center gap-3">
          <img src="/logo.png" alt="Dompe" className="h-8" />
        </div>

        <div className="relative z-10 max-w-md">
          <div className="mb-4 inline-flex items-center gap-2 rounded-full bg-white/10 px-3 py-1 text-xs font-medium ring-1 ring-white/20">
            <Building className="h-3.5 w-3.5" /> {t('login.corporateConsole')}
          </div>
          <h1 className="text-4xl font-bold leading-tight">
            {t('app.title')}
          </h1>
          <p className="mt-4 text-base text-white/70">
            {t('app.subtitle')}
          </p>
          <ul className="mt-8 space-y-3 text-sm text-white/80">
            <li className="flex items-center gap-3"><span className="h-1.5 w-1.5 rounded-full bg-brand-red" />{t('login.bullet.locations')}</li>
            <li className="flex items-center gap-3"><span className="h-1.5 w-1.5 rounded-full bg-emerald-400" />{t('login.bullet.credentials')}</li>
            <li className="flex items-center gap-3"><span className="h-1.5 w-1.5 rounded-full bg-amber-300" />{t('login.bullet.sync')}</li>
          </ul>
        </div>

        <div className="relative z-10 text-xs text-white/50">
          v1.1.0 · {new Date().getFullYear()} · CISCO CATALYST 9800
        </div>
      </div>

      {/* Right panel: SSO user tag + sede selector or WLC form */}
      <div className="flex items-center justify-center bg-slate-50 p-6">
        {ssoUser && (
          <div className="absolute right-3 top-3 hidden items-center gap-2 rounded-lg border border-slate-200 bg-white px-2.5 py-1.5 text-xs text-slate-600 shadow-sm md:flex">
            <User className="h-3.5 w-3.5" />
            <span className="font-medium text-slate-700">{ssoUser.displayName}</span>
            <span className="text-slate-400">{ssoUser.email}</span>
          </div>
        )}
        {selectedSede === null ? (
          <SedeSelector
            sedi={sedi}
            loading={loadingSedi}
            onSelect={setSelectedSede}
          />
        ) : (
          <SedeWlcForm
            sede={selectedSede}
            onBack={() => setSelectedSede(null)}
            onAuthenticated={onAuthenticated}
          />
        )}
      </div>
    </div>
  );
}

function SedeSelector({
  sedi,
  loading,
  onSelect,
}: {
  sedi: Sede[];
  loading: boolean;
  onSelect: (s: Sede) => void;
}) {
  const [, , t] = useLocale();
  return (
    <div className="w-full max-w-2xl">
      <div className="mb-6 flex items-center gap-3 lg:hidden">
        <img src="/logo.png" alt="Dompe" className="h-6" />
      </div>

      <h2 className="text-xl font-bold text-navy">{t('login.sede.heading')}</h2>
      <p className="mt-1 text-sm text-slate-500">{t('login.sede.subtitle')}</p>

      {loading ? (
        <div className="mt-8 flex items-center justify-center gap-2 text-slate-500">
          <Loader2 className="h-4 w-4 animate-spin" /> {t('toast.loading')}
        </div>
      ) : sedi.length === 0 ? (
        <div className="mt-8 rounded-lg border border-rose-200 bg-rose-50 p-4 text-sm text-rose-700">
          {t('login.sede.empty')}
        </div>
      ) : (
        <div className="mt-6 grid gap-3 sm:grid-cols-2">
          {sedi.map((s) => (
            <button
              key={s.id}
              onClick={() => onSelect(s)}
              className="group card flex items-start gap-3 p-4 text-left transition hover:shadow-elev hover:ring-2 hover:ring-navy/30"
            >
              <div className="flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-lg bg-navy text-white">
                <Building className="h-5 w-5" />
              </div>
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="rounded bg-navy/5 px-1.5 py-0.5 font-mono text-[10px] font-bold text-navy">
                    {s.code}
                  </span>
                  <div className="truncate text-sm font-bold text-slate-800">{s.name}</div>
                </div>
                <div className="mt-1 flex items-center gap-1 text-xs text-slate-500">
                  <MapPin className="h-3 w-3" />
                  <span className="truncate">{s.city}</span>
                </div>
                {s.address && <div className="mt-1 truncate text-[11px] text-slate-400">{s.address}</div>}
                {s.wlcHost && (
                  <div className="mt-1.5 truncate font-mono text-[10px] text-slate-400">WLC: {s.wlcHost}</div>
                )}
              </div>
              <ArrowRight className="h-4 w-4 flex-shrink-0 text-slate-300 transition group-hover:translate-x-0.5 group-hover:text-navy" />
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function SedeWlcForm({
  sede,
  onBack,
  onAuthenticated,
}: {
  sede: Sede;
  onBack: () => void;
  onAuthenticated: (cfg: WlcConfig, sede: Sede) => void;
}) {
  const [, , t] = useLocale();
  const [host, setHost] = useState(sede.wlcHost ?? '172.18.106.100');
  const [port, setPort] = useState(sede.wlcPort ?? 443);
  const [sshPort, setSshPort] = useState(sede.wlcSshPort ?? 22);
  const [username, setUsername] = useState('admin_guest');
  const [ssid, setSsid] = useState(sede.wlcSsid ?? 'Dompe Guest');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [unreachable, setUnreachable] = useState(false);
  const [showDemo, setShowDemo] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    setError(null);
    setUnreachable(false);
    try {
      const r = await api.wlcLogin({ host, port, username, sedeId: sede.id });
      if (r.success) {
        onAuthenticated({ id: 0, host, port, sshPort, username, wlanSsid: ssid, authenticated: true, sedeId: sede.id }, sede);
        return;
      }
      if (r.isUnreachable) {
        setUnreachable(true);
        setShowDemo(true);
        setError(r.error ?? t('login.error.unreachable'));
      } else {
        setError(r.error ?? t('login.error.creds'));
      }
    } catch (err) {
      setError((err as Error).message);
      setUnreachable(true);
      setShowDemo(true);
    } finally {
      setSubmitting(false);
    }
  }

  function enableDemo() {
    onAuthenticated({ id: 0, host, port, sshPort, username, wlanSsid: ssid, authenticated: false, sedeId: sede.id }, sede);
  }

  return (
    <>
      <form onSubmit={submit} className="card w-full max-w-md p-8">
        <button
          type="button"
          onClick={onBack}
          className="mb-3 text-xs font-medium text-slate-500 transition hover:text-navy"
        >
          ← {t('login.sede.changeSede')}
        </button>

        <div className="mb-4 flex items-center gap-3 rounded-lg border border-navy/10 bg-navy/5 p-3">
          <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-navy text-white">
            <Building className="h-4 w-4" />
          </div>
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <span className="rounded bg-navy/10 px-1.5 py-0.5 font-mono text-[10px] font-bold text-navy">{sede.code}</span>
              <div className="truncate text-sm font-bold text-slate-800">{sede.name}</div>
            </div>
            <div className="truncate text-[11px] text-slate-500">{sede.city} · WLC {host}</div>
          </div>
        </div>

        <h2 className="text-xl font-bold text-navy">{t('login.heading')}</h2>
        <p className="mt-1 text-sm text-slate-500">{t('login.subtitle')}</p>

        {error && (
          <div className="mt-4 flex items-start gap-2 rounded-lg border border-rose-200 bg-rose-50 p-3 text-sm text-rose-700">
            <AlertTriangle className="mt-0.5 h-4 w-4 flex-shrink-0" />
            <span>{error}</span>
          </div>
        )}

        <div className="mt-6 grid grid-cols-2 gap-4">
          <div className="col-span-2">
            <label className="label" htmlFor="wlc-host">{t('login.host')}</label>
            <input id="wlc-host" className="input" value={host} onChange={(e) => setHost(e.target.value)} required />
          </div>
          <div>
            <label className="label" htmlFor="wlc-port">{t('login.port')}</label>
            <input id="wlc-port" className="input" type="number" value={port} onChange={(e) => setPort(Number(e.target.value))} />
          </div>
          <div>
            <label className="label" htmlFor="wlc-ssh-port">{t('login.sshPort')}</label>
            <input id="wlc-ssh-port" className="input" type="number" value={sshPort} onChange={(e) => setSshPort(Number(e.target.value))} />
          </div>
          <div className="col-span-2">
            <label className="label" htmlFor="wlc-username">{t('login.username')}</label>
            <div className="relative">
              <input id="wlc-username" className="input pl-9" value={username} onChange={(e) => setUsername(e.target.value)} required />
              <Key className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
            </div>
          </div>
          <div className="col-span-2">
            <label className="label" htmlFor="wlc-ssid">{t('login.ssid')}</label>
            <input id="wlc-ssid" className="input" value={ssid} onChange={(e) => setSsid(e.target.value)} />
          </div>
        </div>

        <button data-testid="wlc-connect-btn" type="submit" className="btn-primary mt-6 w-full" disabled={submitting}>
          {submitting ? t('toast.loading') : t('login.submit')}
        </button>

        {import.meta.env.DEV && (
          <>
            <div className="mt-4 flex items-center gap-3">
              <div className="h-px flex-1 bg-slate-200" />
              <span className="text-[10px] font-medium uppercase tracking-widest text-slate-400">{t('login.or')}</span>
              <div className="h-px flex-1 bg-slate-200" />
            </div>

            <button
              type="button"
              onClick={enableDemo}
              className="btn-ghost mt-3 w-full"
            >
              <span aria-hidden>🧪</span> {t('login.demo.enter')}
            </button>
            <p className="mt-1.5 text-center text-[11px] text-slate-400">
              {t('login.demo.description')}
            </p>
          </>
        )}
      </form>

      {showDemo && unreachable && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/50 p-4 backdrop-blur-sm">
          <div className="card w-full max-w-md p-6 shadow-elev">
            <div className="flex items-center gap-3">
              <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-amber-100 text-amber-700">
                <AlertTriangle className="h-5 w-5" />
              </div>
              <div>
                <h3 className="text-base font-bold text-slate-800">{t('login.demo.title')}</h3>
                <p className="text-xs text-slate-500">{t('login.error.unreachable')}</p>
              </div>
            </div>
            <p className="mt-4 text-sm text-slate-600">{t('login.demo.detail')}</p>
            {error && <p className="mt-2 text-xs italic text-slate-500">{error}</p>}
            <div className="mt-6 flex flex-col gap-2 sm:flex-row sm:justify-end">
              <button className="btn-ghost" onClick={() => setShowDemo(false)}>
                {t('login.demo.edit')}
              </button>
              <button className="btn-primary" onClick={enableDemo}>
                {t('login.demo.enable')}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
