import { useEffect } from 'react';
import { Check, X, AlertTriangle } from './icons';

export type ToastMsg = { kind: 'success' | 'error' | 'info'; text: string };

export default function Toast({ message, onClose }: { message: ToastMsg; onClose: () => void }) {
  useEffect(() => {
    const t = setTimeout(onClose, 4000);
    return () => clearTimeout(t);
  }, [onClose, message]);

  const palette = {
    success: 'bg-emerald-600 text-white',
    error: 'bg-rose-600 text-white',
    info: 'bg-slate-800 text-white',
  }[message.kind];

  const Icon = message.kind === 'success' ? Check : message.kind === 'error' ? AlertTriangle : X;

  return (
    <div className="fixed bottom-4 right-4 z-50 animate-fade-in">
      <div className={`flex items-center gap-2 rounded-lg px-4 py-3 shadow-elev ${palette}`}>
        <Icon className="h-4 w-4" />
        <span className="text-sm font-medium">{message.text}</span>
        <button onClick={onClose} className="ml-2 rounded p-1 hover:bg-white/10">
          <X className="h-3.5 w-3.5" />
        </button>
      </div>
    </div>
  );
}
