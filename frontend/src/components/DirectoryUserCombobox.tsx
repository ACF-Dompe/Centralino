import { useEffect, useId, useState } from 'react';
import { api } from '../api/client';
import { useLocale } from '../i18n';
import { Loader2 } from './icons';
import type { DirectoryUser } from '../types';

interface Props {
  id: string;
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  required?: boolean;
}

const DEBOUNCE_MS = 300;
const MIN_CHARS = 2;

/**
 * Free-text input with live suggestions from Entra ID.
 *
 * Every keystroke (after a short debounce) asks the backend again: nothing is
 * cached, so the list always reflects the directory as it is now. Picking a
 * suggestion fills in the display name; typing anything else is allowed too
 * (an external sponsor is not in the directory).
 *
 * When the search is unavailable (503: switched off, as in local dev) the
 * component quietly degrades to a plain input.
 */
export default function DirectoryUserCombobox({ id, value, onChange, placeholder, required }: Props) {
  const [, , t] = useLocale();
  const listboxId = `${id}-listbox${useId().replace(/:/g, '')}`;

  // What to search for. Set by typing only — picking a suggestion must not
  // trigger a new search for the name that was just picked.
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<DirectoryUser[]>([]);
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [searched, setSearched] = useState(false);
  const [active, setActive] = useState(-1);
  const [unavailable, setUnavailable] = useState(false);

  useEffect(() => {
    const q = query.trim();
    if (unavailable || q.length < MIN_CHARS) {
      setResults([]);
      setSearched(false);
      setLoading(false);
      return;
    }

    const controller = new AbortController();
    const timer = setTimeout(() => {
      setLoading(true);
      api
        .searchDirectoryUsers(q, controller.signal)
        .then((r) => {
          if (controller.signal.aborted) return;
          setResults(r.data);
          setSearched(true);
          setActive(-1);
        })
        .catch((err: unknown) => {
          if (controller.signal.aborted) return;
          // 503 means "not configured": stop asking. Anything else may be
          // transient, so the next keystroke tries again.
          if ((err as { status?: number }).status === 503) setUnavailable(true);
          setResults([]);
          setSearched(false);
        })
        .finally(() => {
          if (!controller.signal.aborted) setLoading(false);
        });
    }, DEBOUNCE_MS);

    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [query, unavailable]);

  function pick(user: DirectoryUser) {
    onChange(user.displayName);
    setQuery('');
    setOpen(false);
    setActive(-1);
  }

  const showList = open && !unavailable && query.trim().length >= MIN_CHARS && (loading || searched);

  function onKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'ArrowDown' && results.length > 0) {
      e.preventDefault();
      setOpen(true);
      setActive((i) => Math.min(i + 1, results.length - 1));
    } else if (e.key === 'ArrowUp' && results.length > 0) {
      e.preventDefault();
      setActive((i) => Math.max(i - 1, 0));
    } else if (e.key === 'Enter' && showList && active >= 0 && results[active]) {
      // Pick the highlighted person rather than submitting the form.
      e.preventDefault();
      pick(results[active]);
    } else if (e.key === 'Escape' && showList) {
      e.preventDefault();
      setOpen(false);
    }
  }

  return (
    <div className="relative">
      <input
        id={id}
        className="input pr-9"
        role="combobox"
        aria-autocomplete="list"
        aria-expanded={showList}
        aria-controls={listboxId}
        aria-activedescendant={showList && active >= 0 ? `${listboxId}-opt-${active}` : undefined}
        autoComplete="off"
        required={required}
        value={value}
        placeholder={placeholder}
        onChange={(e) => {
          onChange(e.target.value);
          setQuery(e.target.value);
          setOpen(true);
        }}
        onFocus={() => setOpen(true)}
        onBlur={() => setOpen(false)}
        onKeyDown={onKeyDown}
      />
      {loading && (
        <Loader2
          data-testid="directory-loading"
          className="pointer-events-none absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 animate-spin text-slate-400"
        />
      )}
      {showList && (
        <ul
          id={listboxId}
          role="listbox"
          data-testid="directory-listbox"
          className="absolute z-10 mt-1 max-h-60 w-full overflow-auto rounded-lg border border-slate-200 bg-white py-1 text-sm shadow-elev"
        >
          {results.map((u, i) => (
            <li
              key={u.id}
              id={`${listboxId}-opt-${i}`}
              role="option"
              aria-selected={i === active}
              data-testid={`directory-option-${i}`}
              className={`cursor-pointer px-3 py-2 ${i === active ? 'bg-navy/5 text-navy' : 'text-slate-700 hover:bg-slate-50'}`}
              // mousedown, not click: it fires before the input's blur closes the list.
              onMouseDown={(e) => {
                e.preventDefault();
                pick(u);
              }}
              onMouseEnter={() => setActive(i)}
            >
              {u.displayName}
            </li>
          ))}
          {results.length === 0 && (
            <li className="px-3 py-2 text-xs text-slate-500" aria-live="polite">
              {loading ? t('create.host.searching') : t('create.host.noResults')}
            </li>
          )}
        </ul>
      )}
    </div>
  );
}
