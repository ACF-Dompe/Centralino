import { useEffect } from 'react';
import { useLocale } from '../i18n';
import { Check, X, AlertTriangle, Loader2, Mail } from './icons';
import type { ResendResult } from '../types';

export type ResendState =
  | { phase: 'sending'; name: string; email: string }
  | { phase: 'done'; name: string; email: string; result: ResendResult }
  | { phase: 'error'; name: string; email: string; message: string };

interface Props {
  state: ResendState;
  onClose: () => void;
}

/**
 * Outcome of "Re-invia credenziali", as a dialog rather than the corner toast:
 * the operator waits on it — the WLC round-trip takes several seconds — and
 * has to act when it fails, which a toast fading out after four seconds made
 * easy to miss.
 */
export default function ResendDialog({ state, onClose }: Props) {
  const [, , t] = useLocale();
  const busy = state.phase === 'sending';

  useEffect(() => {
    if (busy) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [busy, onClose]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/60 p-4 backdrop-blur-sm"
      onClick={busy ? undefined : onClose}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="resend-dialog-title"
        aria-busy={busy}
        data-testid="resend-dialog"
        className="card w-full max-w-md p-6 shadow-elev"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between">
          <div>
            <h2 id="resend-dialog-title" className="flex items-center gap-2 text-lg font-bold text-navy">
              <Mail className="h-5 w-5" /> {t('resend.title')}
            </h2>
            <p className="mt-1 text-sm text-slate-500">{state.name}</p>
          </div>
          {!busy && (
            <button type="button" onClick={onClose} className="btn-ghost p-1" aria-label={t('modal.close')}>
              <X className="h-5 w-5" />
            </button>
          )}
        </div>

        <div className="mt-4 space-y-3 text-sm">
          {state.phase === 'sending' && (
            <div data-testid="resend-sending" className="flex items-center gap-2 text-slate-600">
              <Loader2 className="h-4 w-4 flex-shrink-0 animate-spin" />
              <span>{t('resend.sending', { email: state.email })}</span>
            </div>
          )}

          {state.phase === 'error' && <Notice tone="error">{state.message}</Notice>}

          {state.phase === 'done' && (
            <>
              {state.result.emailSent ? (
                <Notice tone="success">
                  {t('table.resendSuccess', { email: state.email })}
                  {state.result.wlcUpdated && (
                    <span className="mt-1 block text-xs opacity-80">{t('resend.lifetimeRestarted')}</span>
                  )}
                </Notice>
              ) : (
                <Notice tone="error">{t('table.resendFailed')}</Notice>
              )}
              {!state.result.wlcUpdated && <Notice tone="warning">{t('resend.wlcNotUpdated')}</Notice>}
              {state.result.wlcIssues && state.result.wlcIssues.length > 0 && (
                <Notice tone="warning">
                  {t('resend.wlcIssues')}
                  <ul className="mt-1 list-disc pl-5 text-xs">
                    {state.result.wlcIssues.map((issue) => <li key={issue}>{issue}</li>)}
                  </ul>
                </Notice>
              )}
            </>
          )}
        </div>

        <div className="mt-6 flex justify-end">
          <button type="button" className="btn-primary" onClick={onClose} disabled={busy} data-testid="resend-dialog-close">
            {t('modal.close')}
          </button>
        </div>
      </div>
    </div>
  );
}

function Notice({ tone, children }: { tone: 'success' | 'error' | 'warning'; children: React.ReactNode }) {
  const palette = {
    success: 'border-emerald-200 bg-emerald-50 text-emerald-800',
    error: 'border-rose-200 bg-rose-50 text-rose-700',
    warning: 'border-amber-200 bg-amber-50 text-amber-800',
  }[tone];
  const Icon = tone === 'success' ? Check : AlertTriangle;
  return (
    <div role={tone === 'success' ? 'status' : 'alert'} className={`flex items-start gap-2 rounded-lg border p-3 ${palette}`}>
      <Icon className="mt-0.5 h-4 w-4 flex-shrink-0" />
      <div className="min-w-0">{children}</div>
    </div>
  );
}
