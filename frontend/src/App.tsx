import { useEffect, useState } from 'react';
import Login from './components/Login';
import Dashboard from './components/Dashboard';
import SsoLogin from './components/SsoLogin';
import PendingApproval from './components/PendingApproval';
import type { Sede, WlcConfig } from './types';
import { api, type SamlUser } from './api/client';
import { getLocale, setLocale as setGlobalLocale, type Locale, SUPPORTED_LOCALES } from './i18n';
import { Globe } from './components/icons';

type AuthState =
  | { phase: 'loading' }
  | { phase: 'sso-unavailable' }   // SAML not configured → skip SSO
  | { phase: 'sso-required' }      // SAML configured, not authenticated
  | { phase: 'sso-blocked'; user: SamlUser }  // signed in, not profiled yet
  | { phase: 'sso-authenticated'; user: SamlUser; wlc: WlcConfig | null; sede: Sede | null };

export default function App() {
  const [state, setState] = useState<AuthState>({ phase: 'loading' });
  const [locale, setLocale] = useState<Locale>(getLocale());
  /**
   * Bumped to re-run the bootstrap without a full page reload — used after a
   * break-glass login, which establishes the session over XHR rather than
   * through the SAML redirect round-trip.
   */
  const [bootstrapKey, setBootstrapKey] = useState(0);

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

        // 2. Authenticated, but is this user allowed to do anything yet?
        //
        // Only blocks on a status the backend actually sent. An older backend
        // and the test mocks send nothing, and those sessions must keep working
        // — the real gate is the API, which refuses every call from an
        // unprofiled user regardless of what the UI decides to render.
        if (ssoUser.status && ssoUser.status !== 'active') {
          if (!cancelled) setState({ phase: 'sso-blocked', user: ssoUser });
          return;
        }

        // 3. Which site is this session on? Read, never inferred: the previous
        //    bootstrap derived it from the WLC config table and could restore a
        //    site the operator had never picked.
        try {
          const ctx = await api.getSessionContext();
          if (!cancelled) {
            setState({
              phase: 'sso-authenticated',
              user: { ...ssoUser, role: ctx.data.user.role, status: ctx.data.user.status },
              wlc: ctx.data.wlc,
              sede: ctx.data.sede as Sede | null,
            });
          }
          return;
        } catch { /* fall through to the site selector */ }

        if (!cancelled) {
          setState({ phase: 'sso-authenticated', user: ssoUser, wlc: null, sede: null });
        }
      } catch {
        if (!cancelled) setState({ phase: 'sso-unavailable' });
      }
    }

    bootstrap();
    return () => { cancelled = true; };
  }, [bootstrapKey]);

  function handleWlcAuth(cfg: WlcConfig, sede: Sede | null) {
    const user = state.phase === 'sso-authenticated' ? state.user : null;
    setState({ phase: 'sso-authenticated', user: user!, wlc: cfg, sede });
  }

  /** "Cambia sede": forget the site, keep the session. */
  function handleChangeSede() {
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

      {state.phase === 'sso-required' && (
        <SsoLogin
          onBreakGlassAuthenticated={() => {
            setState({ phase: 'loading' });
            setBootstrapKey((k) => k + 1);
          }}
        />
      )}

      {state.phase === 'sso-blocked' && (
        <PendingApproval user={state.user} onLogout={handleSsoLogout} />
      )}

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
          onChangeSede={handleChangeSede}
          onSsoLogout={handleSsoLogout}
        />
      )}
    </div>
  );
}
