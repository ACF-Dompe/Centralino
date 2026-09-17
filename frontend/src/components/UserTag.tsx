import { useLocale } from '../i18n';
import { Lock, User } from './icons';

interface UserTagProps {
  user: { displayName: string; email: string };
  /** Render the emergency-access variant (amber, with the "Emergenza" badge). */
  isBreakGlass?: boolean;
  /**
   * Display and positioning classes, owned by the caller: the sede selector hides
   * the tag below the md breakpoint, the header does not. Defaults to `flex`.
   */
  className?: string;
  testId?: string;
}

/**
 * The "who am I" tag shown in the header and on the sede selector.
 *
 * Deliberately shows the name only. The mail address used to sit next to it,
 * but Entra releases the UPN as the name claim for this tenant, so the tag read
 * the address twice and pushed the header buttons off screen. The address is
 * still one hover away, in the tooltip.
 */
export default function UserTag({ user, isBreakGlass = false, className = 'flex', testId }: UserTagProps) {
  const [, , t] = useLocale();
  const name = user.displayName || user.email;

  if (isBreakGlass) {
    return (
      <div
        data-testid={testId ?? 'breakglass-user-tag'}
        className={`items-center gap-2 rounded-lg border border-amber-300 bg-amber-50 px-2.5 py-1.5 text-xs text-amber-800 ${className}`}
        title={t('breakglass.banner')}
      >
        <Lock className="h-3.5 w-3.5" />
        <span className="font-medium">{name}</span>
        <span className="rounded bg-amber-200/70 px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wide">
          {t('breakglass.badge')}
        </span>
      </div>
    );
  }

  return (
    <div
      data-testid={testId ?? 'sso-user-tag'}
      className={`items-center gap-2 rounded-lg border border-slate-200 bg-slate-50 px-2.5 py-1.5 text-xs text-slate-600 ${className}`}
      title={user.email || name}
    >
      <User className="h-3.5 w-3.5" />
      <span className="font-medium text-slate-700">{name}</span>
    </div>
  );
}
