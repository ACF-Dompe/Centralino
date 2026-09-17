import { useCallback, useEffect, useState } from 'react';
import { useLocale } from '../i18n';
import { adminApi, ApiError } from '../api/client';
import { X, Users, Building, Lock, Loader2, AlertTriangle, Save, Check, RefreshCw } from './icons';
import type { AdminSede, AdminUser, BreakGlassAccount, Role, UserStatus } from '../types';

interface Props {
  /** The signed-in admin, so the panel can refuse to let them edit themselves. */
  currentUserEmail: string;
  onClose: () => void;
}

type Tab = 'users' | 'sedi' | 'breakglass';

const ROLES: Role[] = ['admin', 'operator', 'viewer'];
const STATUSES: UserStatus[] = ['pending', 'active', 'suspended'];

/**
 * Administration: the user directory, site and controller settings, and the
 * state of the emergency accounts.
 *
 * Replaces the old "Configura Canali" dialog, which edited the same controller
 * fields but wrote them through a path that always landed on the first site's
 * row whatever site the operator was on.
 */
export default function AdminPanel({ currentUserEmail, onClose }: Props) {
  const [, , t] = useLocale();
  const [tab, setTab] = useState<Tab>('users');

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-slate-900/60 p-4 backdrop-blur-sm">
      <div data-testid="admin-panel" className="card my-8 w-full max-w-4xl shadow-elev">
        <div className="flex items-start justify-between border-b border-slate-200 px-6 py-4">
          <div>
            <div className="text-[10px] font-semibold uppercase tracking-widest text-slate-500">
              {t('admin.title')}
            </div>
            <h2 className="text-lg font-bold text-navy">{t('admin.subtitle')}</h2>
          </div>
          <button data-testid="admin-panel-close" onClick={onClose} className="btn-ghost p-1">
            <X className="h-5 w-5" />
          </button>
        </div>

        <div className="flex gap-1 border-b border-slate-200 px-6 pt-3">
          <TabButton active={tab === 'users'} testId="admin-tab-users" onClick={() => setTab('users')}>
            <Users className="h-3.5 w-3.5" /> {t('admin.tab.users')}
          </TabButton>
          <TabButton active={tab === 'sedi'} testId="admin-tab-sedi" onClick={() => setTab('sedi')}>
            <Building className="h-3.5 w-3.5" /> {t('admin.tab.sedi')}
          </TabButton>
          <TabButton active={tab === 'breakglass'} testId="admin-tab-breakglass" onClick={() => setTab('breakglass')}>
            <Lock className="h-3.5 w-3.5" /> {t('admin.tab.breakglass')}
          </TabButton>
        </div>

        <div className="p-6">
          {tab === 'users' && <UsersTab currentUserEmail={currentUserEmail} />}
          {tab === 'sedi' && <SediTab />}
          {tab === 'breakglass' && <BreakGlassTab />}
        </div>
      </div>
    </div>
  );
}

function TabButton({
  active, onClick, testId, children,
}: { active: boolean; onClick: () => void; testId: string; children: React.ReactNode }) {
  return (
    <button
      data-testid={testId}
      onClick={onClick}
      className={`inline-flex items-center gap-1.5 rounded-t-lg px-3 py-2 text-xs font-semibold transition ${
        active ? 'bg-navy text-white' : 'text-slate-500 hover:bg-slate-100 hover:text-slate-700'
      }`}
    >
      {children}
    </button>
  );
}

/* ----------------------------- Users ----------------------------- */

function UsersTab({ currentUserEmail }: { currentUserEmail: string }) {
  const [, , t] = useLocale();
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [sedi, setSedi] = useState<AdminSede[]>([]);
  const [loading, setLoading] = useState(true);
  const [statusFilter, setStatusFilter] = useState<UserStatus | 'all'>('all');
  const [error, setError] = useState<string | null>(null);
  const [savedId, setSavedId] = useState<number | null>(null);

  /** Pending edits, keyed by user id, so each row saves on its own. */
  const [drafts, setDrafts] = useState<Record<number, { role: Role; status: UserStatus; sedeIds: number[] }>>({});

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [u, s] = await Promise.all([
        adminApi.listUsers(statusFilter === 'all' ? undefined : { status: statusFilter }),
        // The unfiltered list: api.listSedi honours the caller's own grants,
        // which would hide sites an admin still has to assign to other people.
        adminApi.listSedi(),
      ]);
      setUsers(u.data);
      setSedi(s.data);
      setDrafts({});
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, [statusFilter]);

  useEffect(() => { void load(); }, [load]);

  function draftFor(u: AdminUser) {
    return drafts[u.id] ?? { role: u.role, status: u.status, sedeIds: u.sedeIds };
  }

  function setDraft(u: AdminUser, patch: Partial<{ role: Role; status: UserStatus; sedeIds: number[] }>) {
    setDrafts((d) => ({ ...d, [u.id]: { ...draftFor(u), ...patch } }));
  }

  async function save(u: AdminUser) {
    const draft = draftFor(u);
    setError(null);
    try {
      await adminApi.patchUser(u.id, draft);
      setSavedId(u.id);
      setTimeout(() => setSavedId(null), 2000);
      await load();
    } catch (err) {
      const apiErr = err as ApiError;
      setError(apiErr.message);
    }
  }

  if (loading) {
    return <div className="flex items-center gap-2 text-sm text-slate-500"><Loader2 className="h-4 w-4 animate-spin" /> {t('toast.loading')}</div>;
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <div className="flex items-center gap-1 rounded-lg bg-slate-100 p-1 text-sm">
          {(['all', ...STATUSES] as const).map((s) => (
            <button
              key={s}
              data-testid={`admin-users-filter-${s}`}
              onClick={() => setStatusFilter(s as UserStatus | 'all')}
              className={`rounded-md px-2.5 py-1 text-xs font-medium transition ${
                statusFilter === s ? 'bg-white text-navy shadow' : 'text-slate-500 hover:text-slate-700'
              }`}
            >
              {s === 'all' ? t('admin.users.all') : t(`userStatus.${s}`)}
            </button>
          ))}
        </div>
        <button className="btn-ghost text-xs" onClick={() => void load()}>
          <RefreshCw className="h-3.5 w-3.5" /> {t('admin.refresh')}
        </button>
      </div>

      <p className="text-xs text-slate-500">{t('admin.users.hint')}</p>

      {error && (
        <div className="rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-xs text-rose-700">
          <AlertTriangle className="mr-1 inline h-3 w-3 align-text-bottom" />{error}
        </div>
      )}

      {users.length === 0 ? (
        <div className="rounded-lg border border-slate-200 bg-slate-50 p-4 text-sm text-slate-500">
          {t('admin.users.empty')}
        </div>
      ) : (
        <div className="space-y-3">
          {users.map((u) => {
            const draft = draftFor(u);
            const isSelf = !!currentUserEmail && u.email?.toLowerCase() === currentUserEmail.toLowerCase();
            const dirty = JSON.stringify(draft) !== JSON.stringify({ role: u.role, status: u.status, sedeIds: u.sedeIds });
            return (
              <div key={u.id} data-testid={`admin-user-${u.id}`} className="rounded-lg border border-slate-200 p-4">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-bold text-slate-800">{u.displayName || u.email}</span>
                      {u.status === 'pending' && (
                        <span className="rounded bg-amber-100 px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wide text-amber-800">
                          {t('admin.users.pendingBadge')}
                        </span>
                      )}
                      {isSelf && (
                        <span className="rounded bg-slate-100 px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wide text-slate-500">
                          {t('admin.users.you')}
                        </span>
                      )}
                    </div>
                    <div className="mt-0.5 font-mono text-xs text-slate-500">{u.email ?? u.subject}</div>
                    <div className="mt-1 text-[11px] text-slate-400">
                      {t('admin.users.lastLogin')}: {u.lastLoginAt ? new Date(u.lastLoginAt).toLocaleString() : '—'}
                      {u.profiledBy && ` · ${t('admin.users.profiledBy')}: ${u.profiledBy}`}
                    </div>
                  </div>

                  <div className="flex items-center gap-2">
                    <label className="sr-only" htmlFor={`role-${u.id}`}>{t('admin.users.role')}</label>
                    <select
                      id={`role-${u.id}`}
                      data-testid={`admin-user-role-${u.id}`}
                      className="input py-1 text-xs"
                      value={draft.role}
                      disabled={isSelf}
                      onChange={(e) => setDraft(u, { role: e.target.value as Role })}
                    >
                      {ROLES.map((r) => <option key={r} value={r}>{t(`role.${r}`)}</option>)}
                    </select>

                    <label className="sr-only" htmlFor={`status-${u.id}`}>{t('admin.users.status')}</label>
                    <select
                      id={`status-${u.id}`}
                      data-testid={`admin-user-status-${u.id}`}
                      className="input py-1 text-xs"
                      value={draft.status}
                      disabled={isSelf}
                      onChange={(e) => setDraft(u, { status: e.target.value as UserStatus })}
                    >
                      {STATUSES.map((s) => <option key={s} value={s}>{t(`userStatus.${s}`)}</option>)}
                    </select>

                    <button
                      data-testid={`admin-user-save-${u.id}`}
                      className="btn-primary px-3 py-1 text-xs"
                      disabled={!dirty}
                      onClick={() => void save(u)}
                    >
                      {savedId === u.id ? <Check className="h-3.5 w-3.5" /> : <Save className="h-3.5 w-3.5" />}
                      {t('admin.users.save')}
                    </button>
                  </div>
                </div>

                <div className="mt-3">
                  <div className="text-[10px] font-semibold uppercase tracking-widest text-slate-500">
                    {t('admin.users.sedi')}
                  </div>
                  {draft.role === 'admin' ? (
                    <p className="mt-1 text-xs italic text-slate-500">{t('admin.users.adminAllSedi')}</p>
                  ) : (
                    <div className="mt-1.5 flex flex-wrap gap-2">
                      {sedi.map((s) => (
                        <label key={s.id} className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 px-2 py-1 text-xs">
                          <input
                            type="checkbox"
                            data-testid={`admin-user-${u.id}-sede-${s.code}`}
                            checked={draft.sedeIds.includes(s.id)}
                            onChange={(e) => setDraft(u, {
                              sedeIds: e.target.checked
                                ? [...draft.sedeIds, s.id]
                                : draft.sedeIds.filter((id) => id !== s.id),
                            })}
                          />
                          <span className="font-mono text-[10px] font-bold text-navy">{s.code}</span>
                          <span className="text-slate-600">{s.name}</span>
                        </label>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

/* ----------------------------- Sedi / WLC ----------------------------- */

function SediTab() {
  const [, , t] = useLocale();
  const [sedi, setSedi] = useState<AdminSede[]>([]);
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState<number | 'new' | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const r = await adminApi.listSedi();
      setSedi(r.data);
      setSelected((cur) => (cur === 'new' ? 'new' : (cur ?? r.data[0]?.id ?? null)));
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  if (loading) {
    return <div className="flex items-center gap-2 text-sm text-slate-500"><Loader2 className="h-4 w-4 animate-spin" /> {t('toast.loading')}</div>;
  }

  const current = selected === 'new' ? null : sedi.find((s) => s.id === selected) ?? null;

  return (
    <div className="grid gap-4 md:grid-cols-[14rem_1fr]">
      <div className="space-y-1">
        <button
          data-testid="sede-new-btn"
          className={`w-full rounded-lg px-3 py-2 text-left text-xs font-semibold transition ${
            selected === 'new' ? 'bg-navy text-white' : 'text-navy hover:bg-navy/5'
          }`}
          onClick={() => setSelected('new')}
        >
          + {t('admin.sede.new')}
        </button>
        {sedi.map((s) => (
          <button
            key={s.id}
            data-testid={`admin-sede-${s.code}`}
            onClick={() => setSelected(s.id)}
            className={`w-full rounded-lg px-3 py-2 text-left transition ${
              selected === s.id ? 'bg-slate-100 ring-1 ring-navy/20' : 'hover:bg-slate-50'
            }`}
          >
            <div className="flex items-center gap-2">
              <span className="font-mono text-[10px] font-bold text-navy">{s.code}</span>
              <span className="truncate text-xs font-semibold text-slate-700">{s.name}</span>
            </div>
            <div className="mt-1 flex items-center gap-1.5 text-[10px]">
              <Dot ok={s.active} label={s.active ? t('admin.sede.active') : t('admin.sede.inactive')} />
              <Dot ok={s.credentialConfigured} label={t('admin.sede.credential')} />
              <Dot ok={s.wlcLastCheckOk === true} label={t('admin.sede.lastCheck')} />
            </div>
          </button>
        ))}
      </div>

      <div>
        {error && (
          <div className="mb-3 rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-xs text-rose-700">
            <AlertTriangle className="mr-1 inline h-3 w-3 align-text-bottom" />{error}
          </div>
        )}
        {selected === 'new'
          ? <SedeForm key="new" sede={null} onSaved={() => { setSelected(null); void load(); }} />
          : current
            ? <SedeForm key={current.id} sede={current} onSaved={() => void load()} />
            : <p className="text-sm text-slate-500">{t('admin.sede.selectOne')}</p>}
      </div>
    </div>
  );
}

function Dot({ ok, label }: { ok: boolean; label: string }) {
  return (
    <span className="inline-flex items-center gap-0.5 text-slate-400" title={label}>
      <span className={`h-1.5 w-1.5 rounded-full ${ok ? 'bg-emerald-500' : 'bg-slate-300'}`} />
      {label}
    </span>
  );
}

function SedeForm({ sede, onSaved }: { sede: AdminSede | null; onSaved: () => void }) {
  const [, , t] = useLocale();
  const isNew = sede == null;

  const [code, setCode] = useState(sede?.code ?? '');
  const [name, setName] = useState(sede?.name ?? '');
  const [city, setCity] = useState(sede?.city ?? '');
  const [address, setAddress] = useState(sede?.address ?? '');
  const [wlcHost, setWlcHost] = useState(sede?.wlcHost ?? '');
  const [wlcPort, setWlcPort] = useState(sede?.wlcPort ?? 443);
  const [wlcSshPort, setWlcSshPort] = useState(sede?.wlcSshPort ?? 22);
  const [wlcUsername, setWlcUsername] = useState(sede?.wlcUsername ?? 'admin_guest');
  const [wlcSsid, setWlcSsid] = useState(sede?.wlcSsid ?? 'Dompe Guest');

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [testResult, setTestResult] = useState<{ ok: boolean; message: string } | null>(null);

  async function save() {
    setBusy(true);
    setError(null);
    try {
      const body = { name, city, address, wlcHost, wlcPort, wlcSshPort, wlcUsername, wlcSsid };
      if (isNew) {
        await adminApi.createSede({ code: code.trim().toUpperCase(), ...body });
      } else {
        await adminApi.updateSede(sede.id, body);
      }
      onSaved();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function test() {
    if (isNew) return;
    setBusy(true);
    setTestResult(null);
    try {
      const r = await adminApi.testSede(sede.id);
      setTestResult({ ok: r.success, message: r.success ? t('admin.sede.testOk') : (r.error ?? t('admin.sede.testFailed')) });
      onSaved();
    } catch (err) {
      setTestResult({ ok: false, message: (err as Error).message });
    } finally {
      setBusy(false);
    }
  }

  async function toggleActive(force = false) {
    if (isNew) return;
    setBusy(true);
    setError(null);
    try {
      await adminApi.setSedeActive(sede.id, !sede.active, force);
      onSaved();
    } catch (err) {
      const apiErr = err as ApiError;
      if (apiErr.code === 'untested_sede') {
        // Offer the override rather than dead-ending: pre-creating a site
        // before its Key Vault secret exists is a legitimate thing to do.
        if (window.confirm(t('admin.sede.forceActivate'))) {
          setBusy(false);
          return toggleActive(true);
        }
      } else {
        setError(apiErr.message);
      }
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    if (isNew) return;
    if (!window.confirm(t('admin.sede.confirmDelete', { code: sede.code }))) return;
    setBusy(true);
    setError(null);
    try {
      await adminApi.deleteSede(sede.id);
      onSaved();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-4">
      {/* A site cannot work without its Key Vault secret, and creating that is
          a platform-team request — so name both identifiers explicitly rather
          than leaving the admin to guess the convention. */}
      {!isNew && !sede.credentialConfigured && (
        <div data-testid="sede-credential-missing" className="rounded-lg border border-rose-200 bg-rose-50 p-3 text-xs text-rose-800">
          <div className="font-semibold">
            <AlertTriangle className="mr-1 inline h-3.5 w-3.5 align-text-bottom" />
            {t('admin.sede.credentialMissing')}
          </div>
          <div className="mt-2 space-y-1 font-mono text-[11px]">
            <div>Key Vault: <strong>{sede.credentialSecretName}</strong></div>
            <div>Env var: <strong>{sede.credentialEnvVar}</strong></div>
          </div>
        </div>
      )}

      <div className="grid gap-3 sm:grid-cols-2">
        <Field label={t('admin.sede.code')} htmlFor="sede-code">
          <input
            id="sede-code"
            className="input"
            value={code}
            // Immutable after creation: the code is what resolves the Key Vault
            // secret, so changing it would detach the site from its password.
            disabled={!isNew}
            onChange={(e) => setCode(e.target.value.toUpperCase())}
            placeholder="MIL"
          />
          {!isNew && <p className="mt-1 text-[10px] text-slate-400">{t('admin.sede.codeImmutable')}</p>}
        </Field>
        <Field label={t('admin.sede.name')} htmlFor="sede-name">
          <input id="sede-name" className="input" value={name} onChange={(e) => setName(e.target.value)} />
        </Field>
        <Field label={t('admin.sede.city')} htmlFor="sede-city">
          <input id="sede-city" className="input" value={city} onChange={(e) => setCity(e.target.value)} />
        </Field>
        <Field label={t('admin.sede.address')} htmlFor="sede-address">
          <input id="sede-address" className="input" value={address ?? ''} onChange={(e) => setAddress(e.target.value)} />
        </Field>
      </div>

      <div className="border-t border-slate-200 pt-4">
        <div className="text-[10px] font-semibold uppercase tracking-widest text-slate-500">
          {t('admin.sede.wlcSection')}
        </div>
        <div className="mt-2 grid gap-3 sm:grid-cols-2">
          <Field label={t('admin.sede.host')} htmlFor="wlc-host">
            <input id="wlc-host" className="input" value={wlcHost ?? ''} onChange={(e) => setWlcHost(e.target.value)} placeholder="172.18.106.100" />
          </Field>
          <Field label={t('admin.sede.username')} htmlFor="wlc-username">
            <input id="wlc-username" className="input" value={wlcUsername} onChange={(e) => setWlcUsername(e.target.value)} />
          </Field>
          <Field label={t('admin.sede.port')} htmlFor="wlc-port">
            <input id="wlc-port" type="number" className="input" value={wlcPort} onChange={(e) => setWlcPort(Number(e.target.value))} />
          </Field>
          <Field label={t('admin.sede.sshPort')} htmlFor="wlc-ssh-port">
            <input id="wlc-ssh-port" type="number" className="input" value={wlcSshPort} onChange={(e) => setWlcSshPort(Number(e.target.value))} />
          </Field>
          <Field label={t('admin.sede.ssid')} htmlFor="wlc-ssid">
            <input id="wlc-ssid" className="input" value={wlcSsid} onChange={(e) => setWlcSsid(e.target.value)} />
          </Field>
        </div>
        {/* The password is deliberately absent: it lives in Key Vault and the
            application never reads it back, let alone writes it. */}
        <p className="mt-2 text-[11px] text-slate-400">{t('admin.sede.passwordNote')}</p>
      </div>

      {!isNew && sede.wlcLastCheckAt && (
        <div className="text-[11px] text-slate-500">
          {t('admin.sede.lastCheck')}: {new Date(sede.wlcLastCheckAt).toLocaleString()}
          {' · '}
          {sede.wlcLastCheckOk ? t('admin.sede.testOk') : (sede.wlcLastCheckError ?? t('admin.sede.testFailed'))}
        </div>
      )}

      {testResult && (
        <div className={`rounded-lg px-3 py-2 text-xs ${testResult.ok ? 'border border-emerald-200 bg-emerald-50 text-emerald-800' : 'border border-rose-200 bg-rose-50 text-rose-700'}`}>
          {testResult.message}
        </div>
      )}
      {error && (
        <div className="rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-xs text-rose-700">
          <AlertTriangle className="mr-1 inline h-3 w-3 align-text-bottom" />{error}
        </div>
      )}

      <div className="flex flex-wrap items-center gap-2 border-t border-slate-200 pt-4">
        <button data-testid="sede-save-btn" className="btn-primary" disabled={busy} onClick={() => void save()}>
          <Save className="h-4 w-4" /> {t('admin.sede.save')}
        </button>
        {!isNew && (
          <>
            <button data-testid="sede-test-btn" className="btn-ghost" disabled={busy} onClick={() => void test()}>
              <RefreshCw className="h-4 w-4" /> {t('admin.sede.test')}
            </button>
            <button data-testid="sede-active-toggle" className="btn-ghost" disabled={busy} onClick={() => void toggleActive()}>
              {sede.active ? t('admin.sede.deactivate') : t('admin.sede.activate')}
            </button>
            <button data-testid="sede-delete-btn" className="btn-ghost ml-auto text-rose-600 hover:bg-rose-50" disabled={busy} onClick={() => void remove()}>
              {t('admin.sede.delete')}
            </button>
          </>
        )}
      </div>
    </div>
  );
}

function Field({ label, htmlFor, children }: { label: string; htmlFor: string; children: React.ReactNode }) {
  return (
    <div>
      <label className="label" htmlFor={htmlFor}>{label}</label>
      {children}
    </div>
  );
}

/* ----------------------------- Break glass ----------------------------- */

function BreakGlassTab() {
  const [, , t] = useLocale();
  const [accounts, setAccounts] = useState<BreakGlassAccount[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const r = await adminApi.listBreakGlass();
      setAccounts(r.data);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  async function act(fn: () => Promise<unknown>) {
    setError(null);
    try {
      await fn();
      await load();
    } catch (err) {
      setError((err as Error).message);
    }
  }

  if (loading) {
    return <div className="flex items-center gap-2 text-sm text-slate-500"><Loader2 className="h-4 w-4 animate-spin" /> {t('toast.loading')}</div>;
  }

  return (
    <div className="space-y-4">
      {/* Creating an account and rotating its password stay in the CLI. These
          credentials bypass Entra and MFA entirely, so there is deliberately no
          button here that can produce a new one. */}
      <div data-testid="admin-bg-cli-notice" className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-xs text-amber-900">
        <AlertTriangle className="mr-1 inline h-3.5 w-3.5 align-text-bottom" />
        {t('admin.bg.cliOnly')}
      </div>

      {error && (
        <div className="rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-xs text-rose-700">
          <AlertTriangle className="mr-1 inline h-3 w-3 align-text-bottom" />{error}
        </div>
      )}

      {accounts.length === 0 ? (
        <div className="rounded-lg border border-slate-200 bg-slate-50 p-4 text-sm text-slate-500">
          {t('admin.bg.empty')}
        </div>
      ) : (
        <div className="space-y-2">
          {accounts.map((a) => (
            <div key={a.username} data-testid={`admin-bg-${a.username}`} className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-slate-200 p-3">
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <span className="font-mono text-sm font-bold text-slate-800">{a.username}</span>
                  <span className={`badge ${
                    a.state === 'enabled' ? 'bg-emerald-100 text-emerald-700'
                      : a.state === 'locked' ? 'bg-rose-100 text-rose-700'
                        : 'bg-slate-100 text-slate-600'
                  }`}>
                    {t(`admin.bg.state.${a.state}`)}
                  </span>
                  <span className="rounded bg-navy/5 px-1.5 py-0.5 text-[10px] font-bold uppercase text-navy">{a.role}</span>
                </div>
                <div className="mt-0.5 text-xs text-slate-500">{a.displayName}</div>
                <div className="mt-1 text-[11px] text-slate-400">
                  {t('admin.bg.lastLogin')}: {a.lastLoginAt ? new Date(a.lastLoginAt).toLocaleString() : '—'}
                  {a.failedAttempts > 0 && ` · ${t('admin.bg.failedAttempts')}: ${a.failedAttempts}`}
                  {a.expiresAt && ` · ${t('admin.bg.expires')}: ${new Date(a.expiresAt).toLocaleDateString()}`}
                </div>
              </div>
              <div className="flex items-center gap-1">
                {a.enabled ? (
                  <button
                    data-testid={`admin-bg-disable-${a.username}`}
                    className="btn-ghost text-xs"
                    onClick={() => void act(() => adminApi.disableBreakGlass(a.username))}
                  >
                    {t('admin.bg.disable')}
                  </button>
                ) : (
                  <button
                    data-testid={`admin-bg-enable-${a.username}`}
                    className="btn-ghost text-xs"
                    onClick={() => void act(() => adminApi.enableBreakGlass(a.username))}
                  >
                    {t('admin.bg.enable')}
                  </button>
                )}
                {a.state === 'locked' && (
                  <button
                    data-testid={`admin-bg-unlock-${a.username}`}
                    className="btn-ghost text-xs"
                    onClick={() => void act(() => adminApi.unlockBreakGlass(a.username))}
                  >
                    {t('admin.bg.unlock')}
                  </button>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
