import { useEffect, useState } from 'react';
import Login from './components/Login';
import Dashboard from './components/Dashboard';
import SsoLogin from './components/SsoLogin';
import type { Sede, WlcConfig } from './types';
import { api, type SamlUser } from './api/client';
import { getLocale, setLocale as setGlobalLocale, type Locale, SUPPORTED_LOCALES } from './i18n';
import { Globe } from './components/icons';

type AuthState =
  | { phase: 'loading' }
  | { phase: 'sso-unavailable' }   // SAML not configured → skip SSO
  | { phase: 'sso-required' }      // SAML configured, not authenticated
  | { phase: 'sso-authenticated'; user: SamlUser; wlc: WlcConfig | null; sede: Sede | null };

export default function App() {
  const [state, setState] = useState<AuthState>({ phase: 'loading' });
  const [locale, setLocale] = useState<Locale>(getLocale());

  useEffect(() => {
    let cancelled = false;

    async function bootstrap() {
      try {
        // 1. Check SSO status
        let ssoUser: SamlUser | null = null;
        try {
          const me = await api.getMe();
          ssoUser = me.data;
        } catch (err) {
          const status = (err as { status?: number }).status;
          if (status === 404) {
            // SAML not configured — skip SSO, go straight to WLC login
            if (!cancelled) setState({ phase: 'sso-unavailable' });
            return;
          }
          // 401 or other error — SSO required, stay on sso-required
        }

        if (!ssoUser) {
          if (!cancelled) setState({ phase: 'sso-required' });
          return;
        }

        // 2. SSO authenticated — check WLC config
        try {
          const wlcRes = await api.getWlcConfig();
          if (wlcRes.data.authenticated) {
            let sede: Sede | null = null;
            if (wlcRes.data.sedeId != null) {
              try {
                const sedeRes = await api.getSede(wlcRes.data.sedeId);
                sede = sedeRes.data;
              } catch { /* ignore */ }
            }
            if (!cancelled) {
              setState({ phase: 'sso-authenticated', user: ssoUser, wlc: wlcRes.data, sede });
            }
            return;
          }
        } catch { /* no WLC config yet — show WLC login */ }

        if (!cancelled) {
          setState({ phase: 'sso-authenticated', user: ssoUser, wlc: null, sede: null });
        }
      } catch {
        if (!cancelled) setState({ phase: 'sso-unavailable' });
      }
    }

    bootstrap();
    return () => { cancelled = true; };
  }, []);

  function handleWlcAuth(cfg: WlcConfig, sede: Sede | null) {
    const user = state.phase === 'sso-authenticated' ? state.user : null;
    setState({ phase: 'sso-authenticated', user: user!, wlc: cfg, sede });
  }

  function handleWlcDisconnect() {
    if (state.phase !== 'sso-authenticated') return;
    setState({ ...state, wlc: null, sede: null });
  }

  function handleSsoLogout() {
    api.logout().then(() => {
      setState({ phase: 'sso-required' });
    }).catch(() => {
      // Force logout even if the API call fails
      setState({ phase: 'sso-required' });
    });
  }

  const showWlcLogin =
    (state.phase === 'sso-unavailable') ||
    (state.phase === 'sso-authenticated' && !state.wlc);

  return (
    <div className="min-h-full">
      <div className="fixed right-3 top-3 z-50">
        <div className="flex items-center gap-1 rounded-lg border border-slate-200 bg-white px-2 py-1 shadow-card">
          <Globe className="h-4 w-4 text-slate-400" />
          <select
            className="bg-transparent text-xs font-medium text-slate-700 focus:outline-none"
            value={locale}
            onChange={(e) => {
              const l = e.target.value as Locale;
              setGlobalLocale(l);
              setLocale(l);
            }}
            aria-label="Language"
          >
            {SUPPORTED_LOCALES.map((l) => (
              <option key={l} value={l}>
                {l.toUpperCase()}
              </option>
            ))}
          </select>
        </div>
      </div>

      {state.phase === 'loading' && (
        <div className="flex h-full items-center justify-center text-slate-500">
          <span className="animate-pulse-soft">Loading…</span>
        </div>
      )}

      {state.phase === 'sso-required' && <SsoLogin />}

      {showWlcLogin && (
        <Login
          ssoUser={state.phase === 'sso-authenticated' ? state.user : undefined}
          onAuthenticated={(cfg, s) => handleWlcAuth(cfg, s)}
        />
      )}

      {state.phase === 'sso-authenticated' && state.wlc && (
        <Dashboard
          config={state.wlc}
          sede={state.sede}
          ssoUser={state.user}
          onDisconnect={handleWlcDisconnect}
          onConfigUpdate={(c) => setState({ ...state, wlc: c })}
          onSsoLogout={handleSsoLogout}
        />
      )}
    </div>
  );
}
