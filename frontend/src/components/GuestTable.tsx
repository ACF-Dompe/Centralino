import { useEffect, useState } from 'react';
import { useLocale } from '../i18n';
import { formatRemaining, progressPercent, progressBarClass, statusBadgeClass } from '../utils/time';
import { Copy, Trash, Send, Check, Wifi, Building, Phone, Mail, RefreshCw } from './icons';
import type { Guest } from '../types';

interface Props {
  guests: Guest[];
  loading: boolean;
  onActivate: (g: Guest) => void;
  onDelete: (g: Guest) => void;
  onBadge: (g: Guest) => void;
  onResend?: (g: Guest) => void;
}

export default function GuestTable({ guests, loading, onActivate, onDelete, onBadge, onResend }: Props) {
  const [, , t] = useLocale();
  const [tick, setTick] = useState(0);

  // Local 1s tick to drive the progress bars smoothly between server polls.
  useEffect(() => {
    const id = window.setInterval(() => setTick((v) => v + 1), 1000);
    return () => window.clearInterval(id);
  }, []);

  if (loading && guests.length === 0) {
    return (
      <div className="card p-12 text-center text-slate-500">
        <div className="animate-pulse-soft">{t('toast.loading')}</div>
      </div>
    );
  }

  if (guests.length === 0) {
    return (
      <div className="card p-12 text-center">
        <Wifi className="mx-auto h-10 w-10 text-slate-300" />
        <p className="mt-3 text-sm text-slate-500">{t('table.empty')}</p>
      </div>
    );
  }

  return (
    <div className="card overflow-hidden">
      <div className="overflow-x-auto">
        <table className="w-full text-left text-sm">
          <thead className="bg-slate-50 text-xs font-semibold uppercase tracking-wider text-slate-500">
            <tr>
              <th className="px-4 py-3">{t('table.guest')}</th>
              <th className="px-4 py-3">{t('table.company')}</th>
              <th className="px-4 py-3">{t('table.creds')}</th>
              <th className="px-4 py-3">{t('table.time')}</th>
              <th className="px-4 py-3">{t('table.status')}</th>
              <th className="px-4 py-3 text-right">{t('table.actions')}</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {guests.map((g) => {
              const totalSecs = g.durationMinutes * 60;
              const elapsed =
                g.status === 'active' && g.enabledAt
                  ? Math.floor((Date.now() - new Date(g.enabledAt).getTime()) / 1000)
                  : g.elapsedSeconds;
              const pct = progressPercent(totalSecs, elapsed);
              const expired = elapsed >= totalSecs;
              return (
                <tr key={g.id} className="hover:bg-slate-50/60">
                  <td className="px-4 py-3 align-top">
                    <div className="font-semibold text-slate-800">{g.name}</div>
                    <div className="mt-1 flex flex-col gap-0.5 text-xs text-slate-500">
                      {g.email && (
                        <span className="inline-flex items-center gap-1">
                          <Mail className="h-3 w-3" /> {g.email}
                        </span>
                      )}
                      {g.phone && (
                        <span className="inline-flex items-center gap-1">
                          <Phone className="h-3 w-3" /> {g.phone}
                        </span>
                      )}
                    </div>
                  </td>
                  <td className="px-4 py-3 align-top">
                    <div className="font-medium text-slate-700">{g.company}</div>
                    <div className="mt-0.5 text-xs text-slate-500">
                      <Building className="mr-1 inline h-3 w-3" />
                      {g.host}
                    </div>
                    {g.remarks && <div className="mt-1 text-xs italic text-slate-400">{g.remarks}</div>}
                  </td>
                  <td className="px-4 py-3 align-top">
                    <div className="flex items-center gap-2 font-mono text-xs">
                      <code className="rounded bg-slate-100 px-2 py-1">{g.username}</code>
                      <CopyButton value={g.username} />
                    </div>
                    <div className="mt-1 flex items-center gap-2 font-mono text-xs">
                      <code className="rounded bg-slate-100 px-2 py-1 text-navy">{g.password ?? '—'}</code>
                      {g.password ? <CopyButton value={g.password} /> : null}
                    </div>
                  </td>
                  <td className="px-4 py-3 align-top">
                    {expired ? (
                      <div className="text-xs text-slate-400">—</div>
                    ) : (
                      <>
                        <div className="font-mono text-sm font-semibold text-slate-700">
                          {formatRemaining(totalSecs, elapsed, t('time.expired'))}
                        </div>
                        <div className="mt-1 h-1.5 w-32 overflow-hidden rounded-full bg-slate-200">
                          <div
                            className={`h-full ${progressBarClass(pct)} transition-all duration-700`}
                            style={{ width: `${pct}%` }}
                          />
                        </div>
                      </>
                    )}
                  </td>
                  <td className="px-4 py-3 align-top">
                    <span className={`badge ${statusBadgeClass(g.status)}`}>
                      {g.status === 'active' && <span className="h-1.5 w-1.5 rounded-full bg-emerald-500 animate-pulse-soft" />}
                      {t(`status.${g.status}`)}
                    </span>
                  </td>
                  <td className="px-4 py-3 align-top">
                    <div className="flex items-center justify-end gap-1">
                      {g.status === 'pending' && (
                        <button className="btn-ghost text-emerald-700 hover:bg-emerald-50" onClick={() => onActivate(g)} title={t('table.activate')}>
                          <Check className="h-4 w-4" />
                        </button>
                      )}
                      <button className="btn-ghost text-navy hover:bg-navy/5" onClick={() => onBadge(g)} title={t('table.badge')}>
                        <Send className="h-4 w-4" />
                      </button>
                      {onResend && g.email && (
                        <button className="btn-ghost text-indigo-700 hover:bg-indigo-50" onClick={() => onResend(g)} title={t('table.resend')}>
                          <RefreshCw className="h-4 w-4" />
                        </button>
                      )}
                      <button className="btn-ghost text-rose-600 hover:bg-rose-50" onClick={() => onDelete(g)} title={t('table.delete')}>
                        <Trash className="h-4 w-4" />
                      </button>
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {/* invisible re-render trigger for tick */}
      <div className="hidden">{tick}</div>
    </div>
  );
}

function CopyButton({ value }: { value: string }) {
  const [copied, setCopied] = useState(false);
  const [, , t] = useLocale();
  return (
    <button
      type="button"
      className="rounded p-1 text-slate-400 transition hover:bg-slate-100 hover:text-navy"
      title={t('table.copy')}
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(value);
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        } catch { /* ignore */ }
      }}
    >
      {copied ? <Check className="h-3.5 w-3.5 text-emerald-600" /> : <Copy className="h-3.5 w-3.5" />}
    </button>
  );
}
