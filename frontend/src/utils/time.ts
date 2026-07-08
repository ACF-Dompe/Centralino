import type { GuestStatus } from '../types';

export function formatRemaining(totalSeconds: number, elapsedSeconds: number, expiredLabel: string): string {
  const remaining = Math.max(0, totalSeconds - elapsedSeconds);
  if (remaining <= 0) return expiredLabel;
  const days = Math.floor(remaining / 86400);
  const hours = Math.floor((remaining % 86400) / 3600);
  const minutes = Math.floor((remaining % 3600) / 60);
  const seconds = Math.floor(remaining % 60);
  const pad = (n: number) => String(n).padStart(2, '0');
  if (days > 0) return `${days}g ${pad(hours)}:${pad(minutes)}:${pad(seconds)}`;
  return `${pad(hours)}:${pad(minutes)}:${pad(seconds)}`;
}

export function progressPercent(totalSeconds: number, elapsedSeconds: number): number {
  if (totalSeconds <= 0) return 0;
  const remaining = Math.max(0, totalSeconds - elapsedSeconds);
  return Math.min(100, (remaining / totalSeconds) * 100);
}

export function statusBadgeClass(status: GuestStatus): string {
  switch (status) {
    case 'active':
      return 'bg-emerald-100 text-emerald-700 ring-1 ring-emerald-200';
    case 'pending':
      return 'bg-amber-100 text-amber-800 ring-1 ring-amber-200';
    case 'expired':
      return 'bg-slate-200 text-slate-600 ring-1 ring-slate-300';
    case 'deactivated':
      return 'bg-rose-100 text-rose-700 ring-1 ring-rose-200';
  }
}

export function progressBarClass(pct: number): string {
  if (pct > 50) return 'bg-emerald-500';
  if (pct > 20) return 'bg-amber-500';
  return 'bg-rose-500';
}
