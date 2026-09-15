import { useState } from 'react';
import { api } from '../api/client';
import { useLocale } from '../i18n';
import { AlertTriangle, ArrowRight, Key, Lock, User } from './icons';

interface BreakGlassLoginProps {
  /** Called once the emergency session has been established. */
  onAuthenticated: () => void;
  /** Return to the normal SSO screen. */
  onCancel: () => void;
}

/**
 * Emergency local login, used only when Entra ID / SAML SSO is unavailable.
 *
 * The backend returns a single generic error for every failure reason, so this
 * form deliberately does not try to explain *why* a login failed — showing
 * "unknown user" versus "wrong password" would hand an attacker an account
 * enumeration oracle. The warning banner is not decoration either: every
 * attempt against this endpoint is logged and alerted on.
 */
export default function BreakGlassLogin({ onAuthenticated, onCancel }: BreakGlassLoginProps) {
  const [, , t] = useLocale();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      await api.breakGlassLogin({ username, password });
      onAuthenticated();
    } catch {
      // Never surface the transport error verbatim: a 429 and a 401 must look
      // the same to the operator, and the message may carry server detail.
      setError(t('breakglass.error'));
      setPassword('');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form onSubmit={submit} className="card w-full max-w-md p-8" data-testid="breakglass-form">
      <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-2xl bg-amber-100 text-amber-700">
        <Lock className="h-7 w-7" />
      </div>

      <h2 className="mt-5 text-center text-xl font-bold text-navy">{t('breakglass.heading')}</h2>
      <p className="mt-1.5 text-center text-sm text-slate-500">{t('breakglass.subtitle')}</p>

      <div className="mt-5 flex items-start gap-2 rounded-lg border border-amber-200 bg-amber-50 p-3 text-xs text-amber-800">
        <AlertTriangle className="mt-0.5 h-4 w-4 flex-shrink-0" />
        <span>{t('breakglass.warning')}</span>
      </div>

      {error && (
        <div
          data-testid="breakglass-error"
          role="alert"
          className="mt-4 flex items-start gap-2 rounded-lg border border-rose-200 bg-rose-50 p-3 text-sm text-rose-700"
        >
          <AlertTriangle className="mt-0.5 h-4 w-4 flex-shrink-0" />
          <span>{error}</span>
        </div>
      )}

      <div className="mt-6 space-y-4">
        <div>
          <label className="label" htmlFor="breakglass-username">{t('breakglass.username')}</label>
          <div className="relative">
            <input
              id="breakglass-username"
              data-testid="breakglass-username"
              className="input pl-9"
              autoComplete="username"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              required
            />
            <User className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
          </div>
        </div>

        <div>
          <label className="label" htmlFor="breakglass-password">{t('breakglass.password')}</label>
          <div className="relative">
            <input
              id="breakglass-password"
              data-testid="breakglass-password"
              className="input pl-9"
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
            />
            <Key className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
          </div>
        </div>
      </div>

      <button
        data-testid="breakglass-submit"
        type="submit"
        className="btn-primary mt-6 inline-flex w-full items-center justify-center gap-2"
        disabled={submitting}
      >
        {submitting ? t('toast.loading') : t('breakglass.submit')}
        {!submitting && <ArrowRight className="h-4 w-4" />}
      </button>

      <button
        data-testid="breakglass-cancel"
        type="button"
        onClick={onCancel}
        className="mt-3 w-full text-xs font-medium text-slate-500 transition hover:text-navy"
      >
        ← {t('breakglass.backToSso')}
      </button>
    </form>
  );
}
