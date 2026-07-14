import { useEffect, useMemo, useState } from 'react';
import { useLocale } from '../i18n';
import { X, Mail, Building, User, Clock } from './icons';
import { api } from '../api/client';
import type { EmailConfig, Guest } from '../types';

interface Props {
  guest: Guest;
  ssid: string;
  onClose: () => void;
}

export default function BadgeModal({ guest, ssid, onClose }: Props) {
  const [, , t] = useLocale();
  const [emailCfg, setEmailCfg] = useState<EmailConfig | null>(null);
  const [sending, setSending] = useState(false);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api.getEmailConfig()
      .then((e) => setEmailCfg(e.data))
      .catch(() => { /* keep null */ });
  }, []);

  async function sendEmail() {
    if (!guest.email) return;
    setSending(true);
    setError(null);
    setSent(false);
    // Call the backend to send the email via SMTP
    try {
      const r = await api.resendCredentials(guest.id);
      if (r.emailSent) {
        setSent(true);
        setTimeout(() => setSent(false), 2500);
      } else {
        setError(t('modal.email.failed'));
      }
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSending(false);
    }
  }

  const subject = t('modal.email.defaultSubject');
  const body = useMemo(() => {
    return `${t('modal.email.defaultBody', { ssid })}\n\nSSID: ${ssid}\nUsername: ${guest.username}\nPassword: ${guest.password}\n\n${t('modal.badge.durationLabel')}: ${formatDuration(guest.durationMinutes, t)}\n${t('modal.badge.hostLabel')}: ${guest.host}`;
  }, [ssid, guest, t]);

  return (
    <div data-testid="badge-modal" className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/60 p-4 backdrop-blur-sm">
      <div className="card w-full max-w-xl shadow-elev">
        <div className="flex items-start justify-between border-b border-slate-200 px-6 py-4">
          <div>
            <div className="text-[10px] font-semibold uppercase tracking-widest text-slate-500">{t('modal.guest')}</div>
            <h2 className="text-lg font-bold text-navy">{guest.name}</h2>
            <div className="flex items-center gap-2 text-xs text-slate-500">
              <Building className="h-3 w-3" />{guest.company} · {guest.host}
            </div>
          </div>
          <button data-testid="badge-modal-close" onClick={onClose} className="btn-ghost p-1">
            <X className="h-5 w-5" />
          </button>
        </div>

        <div className="p-6 space-y-4">
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="rounded-lg border border-slate-200 bg-slate-50 p-3">
              <div className="text-[10px] font-semibold uppercase tracking-widest text-slate-500">{t('modal.email.from')}</div>
              <div className="mt-1 flex items-center gap-2 text-sm">
                <Mail className="h-4 w-4 text-slate-400" />
                <span className="font-mono text-slate-800">{emailCfg?.sender ?? 'noreply@dompe.com'}</span>
              </div>
            </div>
            <div className="rounded-lg border border-slate-200 bg-slate-50 p-3">
              <div className="text-[10px] font-semibold uppercase tracking-widest text-slate-500">{t('modal.email.to')}</div>
              <div className="mt-1 flex items-center gap-2 text-sm">
                <Mail className="h-4 w-4 text-slate-400" />
                {guest.email ? (
                  <span className="font-mono text-slate-800">{guest.email}</span>
                ) : (
                  <span className="italic text-amber-700">{t('modal.email.noEmail')}</span>
                )}
              </div>
            </div>
          </div>

          <div>
            <div className="text-[10px] font-semibold uppercase tracking-widest text-slate-500">{t('modal.email.subject')}</div>
            <div className="mt-1 rounded-lg border border-slate-200 bg-white p-3 text-sm font-medium">{subject}</div>
          </div>

          <div>
            <div className="text-[10px] font-semibold uppercase tracking-widest text-slate-500">{t('modal.email.body')}</div>
            <pre className="mt-1 whitespace-pre-wrap rounded-lg border border-slate-200 bg-white p-3 text-sm text-slate-700">{body}</pre>
          </div>

          {error && <div className="text-sm text-rose-600">{error}</div>}
          {sent && <div className="text-sm font-medium text-emerald-600">{t('modal.email.sent')}</div>}

          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3 text-xs text-slate-500">
              <span className="inline-flex items-center gap-1"><User className="h-3 w-3" />{guest.username}</span>
              {guest.password && <span className="inline-flex items-center gap-1"><Clock className="h-3 w-3" />{formatDuration(guest.durationMinutes, t)}</span>}
            </div>
            <button
              className="btn-primary"
              disabled={!guest.email || sending}
              onClick={sendEmail}
            >
              <Mail className="h-4 w-4" /> {sending ? t('modal.email.sending') : t('modal.email.send')}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

function formatDuration(minutes: number, t: (key: string, params?: Record<string, string | number>) => string): string {
  if (minutes < 60) return t('time.formatMinutes', { n: minutes });
  if (minutes < 1440) {
    const h = minutes / 60;
    const key = Number.isInteger(h) && h === 1 ? 'time.formatHour' : 'time.formatHours';
    return t(key, { n: Number.isInteger(h) ? h : h.toFixed(1) });
  }
  const d = minutes / 1440;
  if (d < 30) {
    const key = Number.isInteger(d) && d === 1 ? 'time.formatDay' : 'time.formatDays';
    return t(key, { n: Number.isInteger(d) ? d : d.toFixed(1) });
  }
  if (d < 365) {
    return t('time.formatMonths', { n: (d / 30).toFixed(1) });
  }
  return t('time.formatYears', { n: (d / 365).toFixed(1) });
}
