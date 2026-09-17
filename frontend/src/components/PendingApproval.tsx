import { useLocale } from '../i18n';
import { Lock, Building, Mail, User } from './icons';
import type { SamlUser } from '../api/client';

interface Props {
  user: SamlUser;
  onLogout: () => void;
}

/**
 * Shown to somebody who signed in successfully but cannot do anything yet.
 *
 * It exists because "authenticated" and "authorized" are separate here: anybody
 * in the tenant can complete SSO, and the directory grants nothing until an
 * admin profiles the new entry. Without this screen such a user would land on a
 * dashboard where every action failed, or — worse — be bounced back to the
 * sign-in page they had just completed, over and over.
 *
 * The mail address is on screen on purpose: it is what the user has to quote
 * when they ask an administrator to enable them.
 */
export default function PendingApproval({ user, onLogout }: Props) {
  const [, , t] = useLocale();
  const suspended = user.status === 'suspended';

  return (
    <div className="grid min-h-screen lg:grid-cols-2">
      {/* Brand panel — same treatment as the SSO and sede screens */}
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
          <h1 className="text-4xl font-bold leading-tight">{t('app.title')}</h1>
          <p className="mt-4 text-base text-white/70">{t('app.subtitle')}</p>
        </div>
        <div className="relative z-10 text-xs text-white/50">
          {new Date().getFullYear()} · CISCO CATALYST 9800
        </div>
      </div>

      <div className="flex items-center justify-center bg-slate-50 p-6">
        <div data-testid="pending-approval" className="card w-full max-w-md p-8">
          <div className="flex items-center gap-3">
            <div className="rounded-full bg-amber-100 p-2.5 text-amber-700">
              <Lock className="h-5 w-5" />
            </div>
            <h2 className="text-xl font-bold text-navy">
              {suspended ? t('suspended.title') : t('pending.title')}
            </h2>
          </div>

          <p className="mt-4 text-sm text-slate-600">
            {suspended ? t('suspended.description') : t('pending.description')}
          </p>

          <div className="mt-6 space-y-2 rounded-lg border border-slate-200 bg-white p-4">
            <div className="text-[10px] font-semibold uppercase tracking-widest text-slate-500">
              {t('pending.yourAccount')}
            </div>
            <div className="flex items-center gap-2 text-sm text-slate-700">
              <User className="h-4 w-4 text-slate-400" />
              <span className="font-medium">{user.displayName || user.nameID}</span>
            </div>
            {user.email && (
              <div className="flex items-center gap-2 text-sm">
                <Mail className="h-4 w-4 text-slate-400" />
                <span className="font-mono text-slate-600">{user.email}</span>
              </div>
            )}
          </div>

          <p className="mt-4 text-xs text-slate-500">{t('pending.contactAdmin')}</p>

          <button
            data-testid="pending-logout-btn"
            className="btn-ghost mt-6 w-full justify-center"
            onClick={onLogout}
          >
            {t('pending.logout')}
          </button>
        </div>
      </div>
    </div>
  );
}
