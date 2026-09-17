import { useEffect, useState } from 'react';
import { api, ApiError, type SamlUser } from '../api/client';
import { useLocale } from '../i18n';
import { AlertTriangle, Building, MapPin, ArrowRight, Loader2 } from './icons';
import UserTag from './UserTag';
import type { Sede, WlcConfig } from '../types';

interface LoginProps {
  ssoUser?: SamlUser;
  onAuthenticated: (cfg: WlcConfig, sede: Sede) => void;
}

/**
 * Site selection, and nothing else.
 *
 * This screen used to carry a form for the controller's address, ports, admin
 * account and SSID — every operator retyping infrastructure settings at each
 * sign-in, with the values sent back to the server and saved. Those parameters
 * now live on the site record and are edited in the admin panel, which leaves
 * this screen with a single question: which site are you at?
 */
export default function Login({ ssoUser, onAuthenticated }: LoginProps) {
  const [, , t] = useLocale();
  const [sedi, setSedi] = useState<Sede[]>([]);
  const [loadingSedi, setLoadingSedi] = useState(true);
  /** Site currently being connected — drives the spinner and blocks double clicks. */
  const [connectingId, setConnectingId] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [errorSedeId, setErrorSedeId] = useState<number | null>(null);
  /** Set when the controller could not be reached, to offer the dev sandbox. */
  const [unreachableSede, setUnreachableSede] = useState<Sede | null>(null);

  const isAdmin = ssoUser?.role === 'admin';

  useEffect(() => {
    api.listSedi()
      .then((r) => setSedi(r.data))
      .catch(() => setSedi([]))
      .finally(() => setLoadingSedi(false));
  }, []);

  /**
   * Turn a failure into something the operator can act on.
   *
   * Worth the detail: "unreachable" is somebody's job to fix on the network,
   * a wrong password is nobody's job on this screen, and a missing Key Vault
   * secret is an administrator's. Collapsing them into one message would send
   * every case to the same dead end.
   */
  function describeFailure(sede: Sede, code: string | undefined, message: string | undefined, unreachable: boolean): string {
    switch (code) {
      case 'CREDENTIAL_MISSING':
        return t('login.error.credentialMissing', { sede: sede.name });
      case 'SEDE_INACTIVE':
        return t('login.error.sedeInactive', { sede: sede.name });
      case 'WLC_NOT_CONFIGURED':
        return t('login.error.notConfigured', { sede: sede.name });
      case 'sede_forbidden':
        return t('login.error.forbidden', { sede: sede.name });
      default:
        if (unreachable) return t('login.error.unreachableSede', { sede: sede.name });
        return message || t('login.error.creds');
    }
  }

  async function connect(sede: Sede) {
    if (connectingId != null) return; // already connecting
    setConnectingId(sede.id);
    setError(null);
    setErrorSedeId(null);
    setUnreachableSede(null);

    try {
      const r = await api.wlcLogin({ sedeId: sede.id });
      if (r.success) {
        onAuthenticated(
          {
            id: sede.id,
            host: sede.wlcHost ?? '',
            port: sede.wlcPort ?? 443,
            sshPort: sede.wlcSshPort ?? 22,
            username: sede.wlcUsername ?? '',
            wlanSsid: sede.wlcSsid ?? '',
            authenticated: true,
            sedeId: sede.id,
          },
          sede,
        );
        return;
      }
      const unreachable = r.isUnreachable === true;
      setError(describeFailure(sede, r.error, r.message ?? r.error, unreachable));
      setErrorSedeId(sede.id);
      if (unreachable) setUnreachableSede(sede);
    } catch (err) {
      const apiErr = err as ApiError;
      // A network-level failure reaching our own backend is indistinguishable
      // from the controller being down, so offer the same escape hatch.
      const unreachable = apiErr.code === undefined || apiErr.status >= 500;
      setError(describeFailure(sede, apiErr.code, apiErr.message, unreachable));
      setErrorSedeId(sede.id);
      if (unreachable) setUnreachableSede(sede);
    } finally {
      setConnectingId(null);
    }
  }

  /**
   * Enter the local sandbox: a session bound to a site whose controller never
   * answered, so guests are written to the database and never pushed.
   *
   * Development only. In production this would hand an operator a console that
   * looks like it works and silently provisions nobody.
   */
  function enterSandbox(sede: Sede) {
    onAuthenticated(
      {
        id: sede.id,
        host: sede.wlcHost ?? '',
        port: sede.wlcPort ?? 443,
        sshPort: sede.wlcSshPort ?? 22,
        username: sede.wlcUsername ?? '',
        wlanSsid: sede.wlcSsid ?? '',
        authenticated: false,
        sedeId: sede.id,
      },
      sede,
    );
  }

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

      {/* Right panel: user tag + sede selector */}
      <div className="flex items-center justify-center bg-slate-50 p-6">
        {ssoUser && <UserTag user={ssoUser} className="absolute right-3 top-3 hidden bg-white shadow-sm md:flex" />}

        <div className="w-full max-w-2xl">
          <div className="mb-6 flex items-center gap-3 lg:hidden">
            <img src="/logo.png" alt="Dompe" className="h-6" />
          </div>

          <h2 className="text-xl font-bold text-navy">{t('login.sede.heading')}</h2>
          <p className="mt-1 text-sm text-slate-500">{t('login.sede.subtitle')}</p>

          {loadingSedi ? (
            <div className="mt-8 flex items-center justify-center gap-2 text-slate-500">
              <Loader2 className="h-4 w-4 animate-spin" /> {t('toast.loading')}
            </div>
          ) : sedi.length === 0 ? (
            // Distinguished from a configuration problem on purpose: an
            // operator with no grants needs an administrator, not a network
            // engineer. Admins see every site, so for them an empty list really
            // does mean nothing is configured.
            <div
              data-testid="sede-empty"
              className="mt-8 rounded-lg border border-amber-200 bg-amber-50 p-4 text-sm text-amber-800"
            >
              {isAdmin ? t('login.sede.empty') : t('login.sede.noneAssigned')}
            </div>
          ) : (
            <div className="mt-6 grid gap-3 sm:grid-cols-2">
              {sedi.map((s) => (
                <div key={s.id}>
                  <button
                    data-testid={`sede-card-${s.code}`}
                    onClick={() => connect(s)}
                    disabled={connectingId != null}
                    aria-busy={connectingId === s.id}
                    className="group card flex w-full items-start gap-3 p-4 text-left transition hover:shadow-elev hover:ring-2 hover:ring-navy/30 disabled:cursor-not-allowed disabled:opacity-60"
                  >
                    <div className="flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-lg bg-navy text-white">
                      {connectingId === s.id
                        ? <Loader2 className="h-5 w-5 animate-spin" />
                        : <Building className="h-5 w-5" />}
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
                    </div>
                    <ArrowRight className="h-4 w-4 flex-shrink-0 text-slate-300 transition group-hover:translate-x-0.5 group-hover:text-navy" />
                  </button>

                  {errorSedeId === s.id && error && (
                    <div
                      data-testid={`sede-error-${s.code}`}
                      className="mt-1.5 rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-xs text-rose-700"
                    >
                      <AlertTriangle className="mr-1 inline h-3 w-3 align-text-bottom" />
                      {error}
                      <button
                        className="ml-2 font-semibold underline hover:no-underline"
                        onClick={() => connect(s)}
                      >
                        {t('login.retry')}
                      </button>
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* Local sandbox. Development only — see enterSandbox. */}
      {import.meta.env.DEV && unreachableSede && (
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
              <button className="btn-ghost" onClick={() => setUnreachableSede(null)}>
                {t('login.demo.edit')}
              </button>
              <button className="btn-primary" onClick={() => enterSandbox(unreachableSede)}>
                {t('login.demo.enable')}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
