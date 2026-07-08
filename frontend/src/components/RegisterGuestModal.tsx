import { useMemo, useState } from 'react';
import { api } from '../api/client';
import { useLocale } from '../i18n';
import { X, Plus, Copy, Check, Key, AlertTriangle, Calendar } from './icons';
import type { Guest, Sede } from '../types';

interface Props {
  sede: Sede;
  onClose: () => void;
  onCreated: () => void;
}

const DURATION_PRESETS: { labelKey: string; value: number }[] = [
  { labelKey: 'create.preset.30min', value: 30 },
  { labelKey: 'create.preset.2h', value: 120 },
  { labelKey: 'create.preset.4h', value: 240 },
  { labelKey: 'create.preset.8h', value: 480 },
  { labelKey: 'create.preset.1d', value: 1440 },
  { labelKey: 'create.preset.1w', value: 7 * 1440 },
];

const MAX_DURATION_MINUTES = 7 * 24 * 60; // 1 week cap
const CUSTOM_VALUE = -1;

/** Convert a Date to the value format expected by <input type="datetime-local">. */
function toDateTimeLocalValue(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export default function RegisterGuestModal({ sede, onClose, onCreated }: Props) {
  const [, , t] = useLocale();
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [phone, setPhone] = useState('');
  const [company, setCompany] = useState(t('create.company.default'));
  const [host, setHost] = useState('');
  const [duration, setDuration] = useState(240);
  const [remarks, setRemarks] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [oneTime, setOneTime] = useState<{ username: string; password: string; guest: Guest } | null>(null);
  const [copied, setCopied] = useState(false);

  // Default end = now + 4 hours, in datetime-local format.
  const defaultEnd = useMemo(() => toDateTimeLocalValue(new Date(Date.now() + 4 * 60 * 60 * 1000)), []);
  const [customEnd, setCustomEnd] = useState<string>(defaultEnd);

  // Compute the duration in minutes from the picked end datetime.
  const customDuration = useMemo(() => {
    const picked = new Date(customEnd);
    if (Number.isNaN(picked.getTime())) return null;
    return Math.floor((picked.getTime() - Date.now()) / 60_000);
  }, [customEnd]);

  function selectDuration(value: number) {
    if (value === CUSTOM_VALUE) {
      setDuration(CUSTOM_VALUE);
      // Re-initialize the picker to a sensible default each time Custom is picked.
      setCustomEnd(toDateTimeLocalValue(new Date(Date.now() + 4 * 60 * 60 * 1000)));
    } else {
      setDuration(value);
    }
  }

  function effectiveDuration(): number | null {
    if (duration === CUSTOM_VALUE) {
      return customDuration != null && customDuration > 0 ? Math.min(customDuration, MAX_DURATION_MINUTES) : null;
    }
    return duration;
  }

  function formatEndAt(): string {
    if (duration !== CUSTOM_VALUE) return '';
    const picked = new Date(customEnd);
    if (Number.isNaN(picked.getTime())) return '';
    return picked.toLocaleString();
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    const minutes = effectiveDuration();
    if (minutes == null || minutes <= 0) {
      setError(t('create.pastDate'));
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      const r = await api.createGuest({
        name,
        email: email || null,
        phone: phone || null,
        company,
        host,
        durationMinutes: minutes,
        remarks: remarks || null,
        sedeId: sede.id,
      });
      const otp = r.data.oneTimePassword ?? null;
      setOneTime({ username: r.data.username, password: otp ?? t('modal.notAvailable'), guest: r.data });
      // Do NOT call onCreated() here — that would close the modal and
      // wipe the oneTimePassword UI before the user sees it.
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSubmitting(false);
    }
  }

  async function copyCreds() {
    if (!oneTime) return;
    const text = `SSID: ${sede.wlcSsid ?? 'Dompe Guest'}\nUsername: ${oneTime.username}\nPassword: ${oneTime.password}`;
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch { /* ignore */ }
  }

  if (oneTime) {
    return (
      <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/60 p-4 backdrop-blur-sm">
        <div className="card w-full max-w-xl p-6 shadow-elev">
          <div className="flex items-start justify-between">
            <div>
              <h2 className="flex items-center gap-2 text-lg font-bold text-navy">
                <Key className="h-5 w-5" /> {t('create.oneTimePassword')}
              </h2>
              <p className="mt-1 text-sm text-slate-500">{oneTime.guest.name} — {oneTime.guest.company}</p>
            </div>
            <button type="button" onClick={onClose} className="btn-ghost p-1">
              <X className="h-5 w-5" />
            </button>
          </div>

          <div className="mt-4 flex items-start gap-2 rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800">
            <AlertTriangle className="mt-0.5 h-4 w-4 flex-shrink-0" />
            <span>{t('create.oneTimePasswordHelp')}</span>
          </div>

          <div className="mt-4 grid grid-cols-2 gap-3 rounded-lg border border-slate-200 bg-slate-50 p-4">
            <div>
              <div className="text-[10px] font-semibold uppercase tracking-widest text-slate-500">SSID</div>
              <div className="font-mono font-semibold text-navy">{sede.wlcSsid ?? 'Dompe Guest'}</div>
            </div>
            <div>
              <div className="text-[10px] font-semibold uppercase tracking-widest text-slate-500">Username</div>
              <div className="font-mono font-semibold text-slate-700">{oneTime.username}</div>
            </div>
            <div className="col-span-2">
              <div className="text-[10px] font-semibold uppercase tracking-widest text-slate-500">Password</div>
              <div className="font-mono text-lg font-bold text-brand-red">{oneTime.password}</div>
            </div>
            {duration === CUSTOM_VALUE && formatEndAt() && (
              <div className="col-span-2" data-testid="end-at">
                <div className="text-[10px] font-semibold uppercase tracking-widest text-slate-500">{t('create.endAt')}</div>
                <div className="font-mono text-sm font-semibold text-slate-700">{formatEndAt()}</div>
              </div>
            )}
          </div>

          {email && (
            <p className="mt-3 text-xs text-slate-500">
              {t('create.emailSent', { email })}
            </p>
          )}

          <div className="mt-6 flex items-center justify-end gap-2">
            <button type="button" className="btn-ghost" onClick={copyCreds}>
              {copied ? <Check className="h-4 w-4 text-emerald-600" /> : <Copy className="h-4 w-4" />}
              {copied ? t('table.copied') : t('table.copy')}
            </button>
            <button type="button" className="btn-primary" onClick={onCreated}>
              {t('modal.close')}
            </button>
          </div>
        </div>
      </div>
    );
  }

  const minutes = effectiveDuration();
  const isCustom = duration === CUSTOM_VALUE;
  const customInvalid = isCustom && (customDuration == null || customDuration <= 0);
  const customTooLong = isCustom && customDuration != null && customDuration > MAX_DURATION_MINUTES;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/60 p-4 backdrop-blur-sm">
      <form onSubmit={submit} className="card w-full max-w-xl p-6 shadow-elev">
        <div className="flex items-start justify-between">
          <div>
            <h2 className="flex items-center gap-2 text-lg font-bold text-navy">
              <Plus className="h-5 w-5" /> {t('create.title')}
            </h2>
            <p className="mt-1 text-xs text-slate-500">
              {t('create.sedeAuto')}: <strong>{sede.name}</strong> ({sede.code})
            </p>
          </div>
          <button type="button" onClick={onClose} className="btn-ghost p-1">
            <X className="h-5 w-5" />
          </button>
        </div>

        {error && (
          <div className="mt-4 rounded-lg border border-rose-200 bg-rose-50 p-3 text-sm text-rose-700">{error}</div>
        )}

        <div className="mt-5 grid gap-4 sm:grid-cols-2">
          <div className="sm:col-span-2">
            <label className="label" htmlFor="rg-name">{t('create.name')}</label>
            <input id="rg-name" className="input" required value={name} onChange={(e) => setName(e.target.value)} placeholder="Dr. Michael Chen" />
          </div>
          <div>
            <label className="label" htmlFor="rg-email">{t('create.email')}</label>
            <input id="rg-email" className="input" type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="name@company.com" />
          </div>
          <div>
            <label className="label" htmlFor="rg-phone">{t('create.phone')}</label>
            <input id="rg-phone" className="input" value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="+39 333 1234567" />
          </div>
          <div>
            <label className="label" htmlFor="rg-company">{t('create.company')}</label>
            <input id="rg-company" className="input" value={company} onChange={(e) => setCompany(e.target.value)} />
          </div>
          <div>
            <label className="label" htmlFor="rg-host">{t('create.host')}</label>
            <input id="rg-host" className="input" required value={host} onChange={(e) => setHost(e.target.value)} placeholder={t('create.host.placeholder')} />
          </div>
          <div className="sm:col-span-2">
            <label className="label">{t('create.duration')}</label>
            <div className="flex flex-wrap gap-1.5">
              {DURATION_PRESETS.map((p) => (
                <button
                  type="button"
                  key={p.value}
                  onClick={() => selectDuration(p.value)}
                  className={`rounded-full px-3 py-1 text-xs font-medium transition ${
                    duration === p.value ? 'bg-navy text-white shadow' : 'bg-slate-100 text-slate-600 hover:bg-slate-200'
                  }`}
                >
                  {t(p.labelKey)}
                </button>
              ))}
              <button
                type="button"
                onClick={() => selectDuration(CUSTOM_VALUE)}
                className={`inline-flex items-center gap-1 rounded-full px-3 py-1 text-xs font-medium transition ${
                  isCustom ? 'bg-navy text-white shadow' : 'bg-slate-100 text-slate-600 hover:bg-slate-200'
                }`}
              >
                <Calendar className="h-3 w-3" /> {t('create.customDuration')}
              </button>
            </div>

            {isCustom ? (
              <div className="mt-2 grid gap-2 sm:grid-cols-2">
                <div>
                  <label className="text-[10px] font-semibold uppercase tracking-widest text-slate-500" htmlFor="rg-custom-end">{t('create.endAt')}</label>
                  <input
                    id="rg-custom-end"
                    type="datetime-local"
                    className="input"
                    data-testid="custom-date-input"
                    value={customEnd}
                    min={toDateTimeLocalValue(new Date())}
                    onChange={(e) => setCustomEnd(e.target.value)}
                  />
                </div>
                <div className="flex items-end">
                  <div className="text-xs text-slate-600">
                    {customInvalid ? (
                      <span className="font-medium text-rose-600" data-testid="custom-past-date-error">{t('create.pastDate')}</span>
                    ) : customTooLong ? (
                      <span className="font-medium text-rose-600">{t('create.tooLong')}</span>
                    ) : (
                      <span>
                        {t('create.durationComputed')}: <strong data-testid="custom-duration-value">{minutes} min</strong>
                      </span>
                    )}
                  </div>
                </div>
              </div>
            ) : (
              <input
                id="rg-duration"
                type="number"
                className="input mt-2"
                data-testid="duration-number-input"
                min={5}
                value={duration}
                onChange={(e) => setDuration(Number(e.target.value))}
              />
            )}
          </div>
          <div className="sm:col-span-2">
            <label className="label" htmlFor="rg-remarks">{t('create.remarks')}</label>
            <textarea
              id="rg-remarks"
              className="input"
              rows={2}
              value={remarks}
              onChange={(e) => setRemarks(e.target.value)}
              placeholder={t('create.remarks.placeholder')}
            />
          </div>
        </div>

        <div className="mt-6 flex items-center justify-end gap-2">
          <button type="button" className="btn-ghost" onClick={onClose}>{t('create.cancel')}</button>
          <button type="submit" className="btn-primary" disabled={submitting || (isCustom && (customInvalid || customTooLong))}>
            {submitting ? t('toast.loading') : t('create.submit')}
          </button>
        </div>
      </form>
    </div>
  );
}
