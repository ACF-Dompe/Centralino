import { useLocale } from '../i18n';
import { Building, ArrowRight, LogIn } from './icons';

export default function SsoLogin() {
  const [, , t] = useLocale();

  return (
    <div className="grid min-h-screen lg:grid-cols-2">
      {/* Brand panel */}
      <div className="relative hidden flex-col justify-between overflow-hidden bg-navy p-12 text-white lg:flex">
        <div className="absolute -right-32 -top-32 h-96 w-96 rounded-full bg-white/5 blur-2xl" />
        <div className="absolute -bottom-32 -left-16 h-80 w-80 rounded-full bg-brand-red/20 blur-2xl" />
        <div className="flex items-center gap-3">
          <img src="/logo.png" alt="Dompe" className="h-8" />
        </div>

        <div className="relative z-10 max-w-md">
          <div className="mb-4 inline-flex items-center gap-2 rounded-full bg-white/10 px-3 py-1 text-xs font-medium ring-1 ring-white/20">
            <Building className="h-3.5 w-3.5" /> {t('sso.corporateConsole')}
          </div>
          <h1 className="text-4xl font-bold leading-tight">
            {t('app.title')}
          </h1>
          <p className="mt-4 text-base text-white/70">
            {t('app.subtitle')}
          </p>
          <ul className="mt-8 space-y-3 text-sm text-white/80">
            <li className="flex items-center gap-3"><span className="h-1.5 w-1.5 rounded-full bg-brand-red" />{t('login.bullet.locations')}</li>
            <li className="flex items-center gap-3"><span className="h-1.5 w-1.5 rounded-full bg-emerald-400" />{t('login.bullet.credentials')}</li>
            <li className="flex items-center gap-3"><span className="h-1.5 w-1.5 rounded-full bg-amber-300" />{t('login.bullet.sync')}</li>
          </ul>
        </div>

        <div className="relative z-10 text-xs text-white/50">
          v1.1.0 · {new Date().getFullYear()} · CISCO CATALYST 9800
        </div>
      </div>

      {/* Right panel: SSO login */}
      <div className="flex items-center justify-center bg-slate-50 p-6">
        <div className="w-full max-w-md">
          <div className="mb-6 flex items-center gap-3 lg:hidden">
            <img src="/logo.png" alt="Dompe" className="h-6" />
          </div>

          <div className="card p-8 text-center">
            <div className="mx-auto flex h-16 w-16 items-center justify-center rounded-2xl bg-navy shadow-card">
              <LogIn className="h-8 w-8 text-white" />
            </div>

            <h2 className="mt-6 text-2xl font-bold text-navy">
              {t('sso.heading')}
            </h2>
            <p className="mt-2 text-sm text-slate-500">
              {t('sso.subtitle')}
            </p>

            <a
              href="/api/auth/login"
              className="btn-primary mt-8 inline-flex w-full items-center justify-center gap-2"
            >
              <LogIn className="h-5 w-5" />
              {t('sso.loginButton')}
              <ArrowRight className="h-5 w-5" />
            </a>

            <p className="mt-4 text-xs text-slate-400">
              {t('sso.description')}
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}
