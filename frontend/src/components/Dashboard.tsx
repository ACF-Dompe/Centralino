import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../api/client';
import { useLocale } from '../i18n';
import { X, Power, Lock, Trash, Clock, Refresh, Search, Settings, Plus, User, Building, AlertTriangle } from './icons';
import { connectWs, type WsClient } from '../api/ws';
import type { Guest, GuestStatus, Sede, WlcConfig } from '../types';
import GuestTable from './GuestTable';
import ConfigPanel from './ConfigPanel';
import RegisterGuestModal from './RegisterGuestModal';
import Toast, { type ToastMsg } from './Toast';
import BadgeModal from './BadgeModal';

import type { SamlUser } from '../api/client';

interface DashboardProps {
  config: WlcConfig;
  sede: Sede | null;
  ssoUser?: SamlUser;
  onDisconnect: () => void;
  onConfigUpdate: (c: WlcConfig) => void;
  onSsoLogout?: () => void;
}

/**
 * Full refresh every 30s as a safety net; WebSocket events trigger
 * immediate refreshes for real-time UX.
 */
const POLL_INTERVAL_MS = 30_000;

export default function Dashboard({ config, sede, ssoUser, onDisconnect, onConfigUpdate, onSsoLogout }: DashboardProps) {
  const [, , t] = useLocale();
  const [guests, setGuests] = useState<Guest[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState<GuestStatus | 'all'>('all');
  const [showConfig, setShowConfig] = useState(false);
  const [showCreate, setShowCreate] = useState(false);
  const [showBadgeFor, setShowBadgeFor] = useState<Guest | null>(null);
  const [toast, setToast] = useState<ToastMsg | null>(null);
  const [lastSync, setLastSync] = useState<Date | null>(null);
  const [locked, setLocked] = useState(false);
  const pollingRef = useRef<number | null>(null);
  const wsRef = useRef<WsClient | null>(null);
  const [recentEvents, setRecentEvents] = useState<RecentEvent[]>([]);
  const [showEventDropdown, setShowEventDropdown] = useState(false);
  const eventClearRef = useRef<number | null>(null);
  const eventDropdownRef = useRef<HTMLDivElement | null>(null);

  const refresh = useCallback(async () => {
    try {
      const r = await api.listGuests({ search, status: statusFilter, sedeId: config.sedeId });
      setGuests(r.data);
    } catch (err) {
      setToast({ kind: 'error', text: (err as Error).message });
    } finally {
      setLoading(false);
    }
  }, [search, statusFilter, config.sedeId]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  // WebSocket connection for real-time events
  useEffect(() => {
    const ws = connectWs({
      onEvent: (event) => {
        if (
          event.type === 'guest:expired' ||
          event.type === 'guest:created' ||
          event.type === 'guest:updated' ||
          event.type === 'guest:deactivated' ||
          event.type === 'guest:deleted' ||
          event.type === 'guest:imported'
        ) {
          refresh();
        }
        if (event.type === 'sync:completed') {
          refresh();
        }

        // Toast notifications for status changes
        if (event.type === 'guest:expired') {
          setToast({ kind: 'info', text: t('ws.guestExpired', { name: event.data.name }) });
          playAlertSound();
        }
        if (event.type === 'guest:deactivated') {
          setToast({ kind: 'info', text: t('ws.guestDeactivated', { name: event.data.name }) });
          playAlertSound();
        }
        if (event.type === 'guest:created') {
          setToast({ kind: 'success', text: t('ws.guestCreated', { name: event.data.name }) });
        }
        if (event.type === 'guest:deleted') {
          setToast({ kind: 'info', text: t('ws.guestDeleted', { name: event.data.name }) });
        }
        if (event.type === 'guest:imported') {
          setToast({ kind: 'info', text: t('ws.guestImported', { name: event.data.name }) });
        }

        // Recent events list — only for guest events that carry a guest name
        if (event.type !== 'hello' && event.type !== 'sync:completed' && 'name' in event.data) {
          setRecentEvents((prev) => {
            const next = [{ type: event.type, name: event.data.name, timestamp: Date.now() }, ...prev];
            return next.length > 20 ? next.slice(0, 20) : next;
          });
        }
        if (eventClearRef.current !== null) {
          window.clearTimeout(eventClearRef.current);
        }
        eventClearRef.current = window.setTimeout(() => {
          setRecentEvents([]);
          setShowEventDropdown(false);
          eventClearRef.current = null;
        }, 10_000);
      },
      onConnect: () => {
        console.debug('[WS] Connected');
      },
      onDisconnect: () => {
        console.debug('[WS] Disconnected');
      },
    });
    wsRef.current = ws;
    return () => {
      ws.disconnect();
      wsRef.current = null;
      if (eventClearRef.current !== null) {
        window.clearTimeout(eventClearRef.current);
        eventClearRef.current = null;
      }
    };
  }, [refresh]);

  // Close event dropdown on outside click
  useEffect(() => {
    if (!showEventDropdown) return;
    const handler = (e: MouseEvent) => {
      if (eventDropdownRef.current && !eventDropdownRef.current.contains(e.target as Node)) {
        setShowEventDropdown(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [refresh]);

  // Background polling fallback (less frequent, covered by WS)
  useEffect(() => {
    pollingRef.current = window.setInterval(refresh, POLL_INTERVAL_MS);
    return () => {
      if (pollingRef.current) window.clearInterval(pollingRef.current);
    };
  }, [refresh]);

  const stats = useMemo(() => {
    const registered = guests.length;
    const online = guests.filter((g) => g.status === 'active').length;
    const pending = guests.filter((g) => g.status === 'pending').length;
    const completed = guests.filter((g) => g.status === 'expired' || g.status === 'deactivated').length;
    return { registered, online, pending, completed };
  }, [guests]);

  async function handleSync() {
    if (!config.authenticated) {
      setToast({ kind: 'info', text: 'Demo Sandbox — operazione simulata localmente.' });
      setLastSync(new Date());
      return;
    }
    try {
      await refresh();
      setLastSync(new Date());
      setToast({ kind: 'success', text: 'Sincronizzazione WLC completata.' });
    } catch (err) {
      setToast({ kind: 'error', text: (err as Error).message });
    }
  }

  async function handleDisconnect() {
    try {
      await api.updateWlcConfig({ authenticated: false });
    } catch { /* ignore */ }
    onDisconnect();
  }

  async function activate(g: Guest) {
    try {
      await api.updateGuest(g.id, { status: 'active', enabledAt: new Date().toISOString() });
      setToast({ kind: 'success', text: `${g.name} attivato.` });
      await refresh();
    } catch (err) {
      setToast({ kind: 'error', text: (err as Error).message });
    }
  }

  async function remove(g: Guest) {
    if (!window.confirm(t('table.confirmDelete', { name: g.name }))) return;
    try {
      await api.deleteGuest(g.id);
      setToast({ kind: 'success', text: `${g.name} eliminato.` });
      await refresh();
    } catch (err) {
      setToast({ kind: 'error', text: (err as Error).message });
    }
  }

  async function resend(g: Guest) {
    try {
      const r = await api.resendCredentials(g.id);
      if (r.emailSent) {
        setToast({ kind: 'success', text: t('table.resendSuccess', { email: g.email ?? '' }) });
      } else {
        setToast({ kind: 'error', text: t('table.resendFailed') });
      }
    } catch (err) {
      setToast({ kind: 'error', text: (err as Error).message });
    }
  }

  return (
    <div className="min-h-screen bg-slate-50">
      <header className="sticky top-0 z-30 border-b border-slate-200 bg-white/95 backdrop-blur">
        <div className="mx-auto flex max-w-7xl items-center justify-between gap-4 px-4 py-3">
          <div className="flex items-center gap-3">
            <img src="/logo.png" alt="Dompe" className="h-7" />
            {sede && (
              <span
                className="ml-3 inline-flex items-center gap-1.5 rounded-full bg-navy/5 px-2.5 py-1 text-xs font-semibold text-navy ring-1 ring-navy/20"
                title={`${sede.city} — ${sede.address ?? ''}`}
              >
                <Building className="h-3 w-3" />
                <span className="font-mono text-[10px]">{sede.code}</span>
                <span>{sede.name}</span>
              </span>
            )}
            <span
              className={`badge ${config.authenticated ? 'bg-emerald-100 text-emerald-700 ring-1 ring-emerald-200' : 'bg-amber-100 text-amber-800 ring-1 ring-amber-200'}`}
            >
              <span className={`h-1.5 w-1.5 rounded-full ${config.authenticated ? 'bg-emerald-500 animate-pulse-soft' : 'bg-amber-500'}`} />
              {config.authenticated ? t('header.connected') : t('header.offline')}
              {config.authenticated && <span className="ml-1 text-[10px] text-emerald-700/70">@ {config.host}</span>}
            </span>
          </div>

          <div className="hidden items-center gap-3 md:flex">
            {/* Recent events dropdown */}
            {recentEvents.length > 0 && (
              <div ref={eventDropdownRef} className="relative">
                <button
                  className={`relative inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-semibold ring-1 transition ${
                    showEventDropdown
                      ? 'bg-amber-200 text-amber-900 ring-amber-300'
                      : 'bg-amber-100 text-amber-800 ring-amber-200 hover:bg-amber-200'
                  }`}
                  onClick={() => setShowEventDropdown((v) => !v)}
                >
                  <AlertTriangle className="h-3.5 w-3.5" />
                  <span>{recentEvents.length}</span>
                </button>

                {showEventDropdown && (
                  <div className="absolute right-0 top-full z-40 mt-2 w-80 overflow-hidden rounded-xl border border-slate-200 bg-white shadow-elev">
                    {/* Header */}
                    <div className="flex items-center justify-between border-b border-slate-100 px-3 py-2">
                      <span className="text-xs font-semibold text-slate-700">
                        {t('app.events', { n: String(recentEvents.length) })}
                      </span>
                      <button
                        className="rounded p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-600"
                        onClick={() => {
                          setRecentEvents([]);
                          setShowEventDropdown(false);
                          if (eventClearRef.current !== null) {
                            window.clearTimeout(eventClearRef.current);
                            eventClearRef.current = null;
                          }
                        }}
                        title={t('app.clear')}
                      >
                        <X className="h-3.5 w-3.5" />
                      </button>
                    </div>
                    {/* Event list */}
                    <div className="max-h-72 divide-y divide-slate-100 overflow-y-auto">
                      {recentEvents.map((ev, i) => {
                        const EventIcon = iconForEvent(ev.type);
                        const color = colorForEvent(ev.type);
                        return (
                          <div key={`${ev.timestamp}-${i}`} className="flex items-center gap-2.5 px-3 py-2 text-xs hover:bg-slate-50">
                            <EventIcon className={`h-4 w-4 ${color} shrink-0`} />
                            <div className="min-w-0 flex-1">
                              <span className="font-medium text-slate-700">{ev.name}</span>
                              <span className="ml-1.5 text-slate-400">{labelForEvent(t, ev.type)}</span>
                            </div>
                            <span className="shrink-0 text-[10px] text-slate-400" title={new Date(ev.timestamp).toLocaleString()}>
                              {formatRelativeTime(ev.timestamp)}
                            </span>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                )}
              </div>
            )}
            {ssoUser && (
              <div className="flex items-center gap-2 rounded-lg border border-slate-200 bg-slate-50 px-2.5 py-1.5 text-xs text-slate-600" title={ssoUser.email}>
                <User className="h-3.5 w-3.5" />
                <span className="font-medium text-slate-700">{ssoUser.displayName}</span>
                <span className="text-slate-500">{ssoUser.email}</span>
              </div>
            )}
            <div className="text-xs text-slate-500">
              {t('header.lastSync')}: <span className="font-medium text-slate-700">{lastSync ? lastSync.toLocaleTimeString() : t('header.never')}</span>
            </div>
            <button className="btn-ghost" onClick={handleSync} title={t('header.syncNow')}>
              <Refresh className="h-4 w-4" /> <span className="hidden sm:inline">{t('header.syncNow')}</span>
            </button>
            <button className="btn-ghost" onClick={() => setLocked(true)} title={t('header.lockConsole')}>
              <Lock className="h-4 w-4" />
            </button>
            <button className="btn-ghost" onClick={handleDisconnect} title={t('header.disconnect')}>
              <Power className="h-4 w-4" /> <span className="hidden sm:inline">{t('header.disconnect')}</span>
            </button>
            {onSsoLogout && (
              <button className="btn-ghost text-rose-600 hover:bg-rose-50" onClick={onSsoLogout} title={t('sso.logout')}>
                <Power className="h-4 w-4" /> <span className="hidden sm:inline">{t('sso.logout')}</span>
              </button>
            )}
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-7xl space-y-6 px-4 py-6">
        <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
          <StatCard label={t('stats.registered')} value={stats.registered} tone="navy" />
          <StatCard label={t('stats.online')} value={stats.online} tone="emerald" highlight={stats.online > 0} />
          <StatCard label={t('stats.pending')} value={stats.pending} tone="amber" />
          <StatCard label={t('stats.completed')} value={stats.completed} tone="slate" />
        </div>

        <div className="card p-4">
          <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
            <div className="flex flex-1 flex-col gap-3 sm:flex-row sm:items-center">
              <div className="relative flex-1">
                <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
                <input
                  className="input pl-9"
                  placeholder={t('toolbar.search')}
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                />
              </div>
              <div className="flex flex-wrap items-center gap-1 rounded-lg bg-slate-100 p-1 text-sm">
                {(['all', 'pending', 'active', 'expired', 'deactivated'] as const).map((s) => (
                  <button
                    key={s}
                    onClick={() => setStatusFilter(s)}
                    className={`rounded-md px-2.5 py-1 text-xs font-medium transition ${
                      statusFilter === s ? 'bg-white text-navy shadow' : 'text-slate-500 hover:text-slate-700'
                    }`}
                  >
                    {s === 'all' ? t('toolbar.statusAll') : t(`status.${s}`)}
                  </button>
                ))}
              </div>
            </div>
            <div className="flex items-center gap-2">
              <button className="btn-ghost" onClick={() => setShowConfig(true)}>
                <Settings className="h-4 w-4" /> {t('toolbar.config')}
              </button>
              <button className="btn-primary" onClick={() => setShowCreate(true)} disabled={!sede} title={sede ? '' : t('login.sede.heading')}>
                <Plus className="h-4 w-4" /> {t('toolbar.register')}
              </button>
            </div>
          </div>
        </div>

        <GuestTable
          guests={guests}
          loading={loading}
          onActivate={activate}
          onDelete={remove}
          onBadge={(g) => setShowBadgeFor(g)}
          onResend={resend}
        />
      </main>

      {showConfig && (
        <ConfigPanel
          wlcConfig={config}
          onClose={() => setShowConfig(false)}
          onWlcConfigUpdate={(c) => onConfigUpdate(c)}
        />
      )}
      {showCreate && sede && (
        <RegisterGuestModal
          sede={sede}
          onClose={() => setShowCreate(false)}
          onCreated={() => { setShowCreate(false); refresh(); }}
        />
      )}
      {showBadgeFor && (
        <BadgeModal guest={showBadgeFor} ssid={config.wlanSsid} onClose={() => setShowBadgeFor(null)} />
      )}
      {locked && <LockOverlay onUnlock={() => setLocked(false)} />}

      {toast && <Toast message={toast} onClose={() => setToast(null)} />}
    </div>
  );
}

function StatCard({ label, value, tone, highlight = false }: { label: string; value: number; tone: 'navy' | 'emerald' | 'amber' | 'slate'; highlight?: boolean }) {
  const toneClass = {
    navy: 'from-navy to-navy-600 text-white',
    emerald: 'from-emerald-500 to-emerald-600 text-white',
    amber: 'from-amber-400 to-amber-500 text-white',
    slate: 'from-slate-200 to-slate-300 text-slate-700',
  }[tone];
  return (
    <div className={`relative overflow-hidden rounded-xl bg-gradient-to-br ${toneClass} p-5 shadow-card`}>
      <div className="text-[11px] font-semibold uppercase tracking-widest opacity-80">{label}</div>
      <div className={`mt-1 text-3xl font-bold ${highlight ? 'animate-pulse-soft' : ''}`}>{value}</div>
      <div className="pointer-events-none absolute -right-6 -top-6 h-20 w-20 rounded-full bg-white/10" />
    </div>
  );
}

// ── Recent events types & helpers ──────────────────────────────────────────

interface RecentEvent {
  type: string;
  name: string;
  timestamp: number;
}

function iconForEvent(type: string) {
  switch (type) {
    case 'guest:expired': return AlertTriangle;
    case 'guest:deactivated': return Power;
    case 'guest:created': return Plus;
    case 'guest:deleted': return Trash;
    case 'guest:imported': return User;
    case 'guest:updated': return Refresh;
    default: return AlertTriangle;
  }
}

function colorForEvent(type: string): string {
  switch (type) {
    case 'guest:expired': return 'text-amber-500';
    case 'guest:deactivated': return 'text-rose-500';
    case 'guest:created': return 'text-emerald-500';
    case 'guest:deleted': return 'text-slate-400';
    case 'guest:imported': return 'text-sky-500';
    case 'guest:updated': return 'text-slate-500';
    default: return 'text-slate-500';
  }
}

function labelForEvent(t: ReturnType<typeof useLocale>[2], type: string): string {
  const label = t(`ws.label.${type.replace(':', '.')}`, {});
  // If i18n returns the key itself (meaning it wasn't found), use the type name as fallback
  if (label.startsWith('ws.label.')) return type.replace('guest:', '');
  return label;
}

function formatRelativeTime(timestamp: number): string {
  const diff = Date.now() - timestamp;
  if (diff < 5_000) return 'ora';
  if (diff < 60_000) return `${Math.floor(diff / 1000)}s`;
  if (diff < 3_600_000) return `${Math.floor(diff / 60000)}m`;
  return `${Math.floor(diff / 3600000)}h`;
}

// ── Alert sound ────────────────────────────────────────────────────────────

/** Shared AudioContext reused across all alert sounds. */
let _audioCtx: AudioContext | null = null;

/**
 * Play a short alert beep using the Web Audio API.
 * No audio files needed — generates a sine-wave tone in the browser.
 * Reuses a single AudioContext for the page lifetime.
 * Gracefully ignores errors if the AudioContext is unavailable.
 */
function playAlertSound(): void {
  try {
    if (!_audioCtx) _audioCtx = new AudioContext();
    const oscillator = _audioCtx.createOscillator();
    const gain = _audioCtx.createGain();

    oscillator.type = 'sine';
    oscillator.frequency.setValueAtTime(880, _audioCtx.currentTime); // A5
    gain.gain.setValueAtTime(0.3, _audioCtx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.01, _audioCtx.currentTime + 0.3); // fade out

    oscillator.connect(gain);
    gain.connect(_audioCtx.destination);

    oscillator.start(_audioCtx.currentTime);
    oscillator.stop(_audioCtx.currentTime + 0.3);
  } catch {
    // Audio not available — silently ignore
  }
}

function LockOverlay({ onUnlock }: { onUnlock: () => void }) {
  const [, , t] = useLocale();
  const [pin, setPin] = useState('');
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/80 backdrop-blur">
      <div className="card w-full max-w-sm p-6 text-center">
        <Lock className="mx-auto h-10 w-10 text-navy" />
        <h3 className="mt-3 text-lg font-bold">{t('header.lockConsole')}</h3>
        <p className="text-sm text-slate-500">Inserisci PIN (qualsiasi valore per la demo)</p>
        <input
          className="input mt-4 text-center text-lg tracking-widest"
          value={pin}
          onChange={(e) => setPin(e.target.value)}
          autoFocus
        />
        <button className="btn-primary mt-4 w-full" onClick={onUnlock}>
          Sblocca
        </button>
      </div>
    </div>
  );
}
