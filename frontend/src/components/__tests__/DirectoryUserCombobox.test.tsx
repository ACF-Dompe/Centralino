/**
 * Tests for the Referente combobox: live suggestions from Entra ID, with free
 * text always allowed and a silent fallback when the search is unavailable.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { useState } from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import DirectoryUserCombobox from '../DirectoryUserCombobox';

vi.mock('../../i18n', () => ({
  useLocale: () => [
    'it',
    vi.fn(),
    (key: string) => ({
      'create.host.searching': 'Ricerca in corso…',
      'create.host.noResults': 'Nessun utente trovato',
    } as Record<string, string>)[key] ?? key,
  ],
}));

const mockSearch = vi.fn();
vi.mock('../../api/client', () => ({
  api: { searchDirectoryUsers: (...args: unknown[]) => mockSearch(...args) },
}));

/** The combobox is controlled; this is the smallest parent that holds the value. */
function Harness({ onValue }: { onValue?: (v: string) => void }) {
  const [value, setValue] = useState('');
  return (
    <>
      <label htmlFor="host">Referente</label>
      <DirectoryUserCombobox
        id="host"
        value={value}
        onChange={(v) => { setValue(v); onValue?.(v); }}
        placeholder="Cerca"
      />
    </>
  );
}

const PEOPLE = [
  { id: 'a', displayName: 'Maria Rossi' },
  { id: 'b', displayName: 'Luca Rossini' },
];

beforeEach(() => {
  vi.clearAllMocks();
  mockSearch.mockResolvedValue({ data: PEOPLE });
});

describe('DirectoryUserCombobox', () => {
  it('shows display names found in the directory', async () => {
    const user = userEvent.setup();
    render(<Harness />);

    await user.type(screen.getByLabelText('Referente'), 'ros');

    expect(await screen.findByTestId('directory-option-0')).toHaveTextContent('Maria Rossi');
    expect(screen.getByTestId('directory-option-1')).toHaveTextContent('Luca Rossini');
    expect(screen.getByLabelText('Referente')).toHaveAttribute('aria-expanded', 'true');
  });

  it('waits for two characters before searching', async () => {
    const user = userEvent.setup();
    render(<Harness />);

    await user.type(screen.getByLabelText('Referente'), 'r');
    await new Promise((r) => setTimeout(r, 400));

    expect(mockSearch).not.toHaveBeenCalled();
    expect(screen.queryByTestId('directory-listbox')).not.toBeInTheDocument();
  });

  /** Debounced: one request for a burst of keystrokes, never one per letter. */
  it('searches once for a burst of typing, with the latest text', async () => {
    const user = userEvent.setup();
    render(<Harness />);

    await user.type(screen.getByLabelText('Referente'), 'rossi');
    await screen.findByTestId('directory-option-0');

    expect(mockSearch).toHaveBeenCalledTimes(1);
    expect(mockSearch).toHaveBeenCalledWith('rossi', expect.anything());
  });

  it('fills in the display name when a person is picked', async () => {
    const onValue = vi.fn();
    const user = userEvent.setup();
    render(<Harness onValue={onValue} />);

    await user.type(screen.getByLabelText('Referente'), 'ros');
    await user.click(await screen.findByTestId('directory-option-1'));

    expect(screen.getByLabelText('Referente')).toHaveValue('Luca Rossini');
    expect(onValue).toHaveBeenLastCalledWith('Luca Rossini');
    expect(screen.queryByTestId('directory-listbox')).not.toBeInTheDocument();
  });

  it('picks with the keyboard', async () => {
    const user = userEvent.setup();
    render(<Harness />);

    await user.type(screen.getByLabelText('Referente'), 'ros');
    await screen.findByTestId('directory-option-0');
    await user.keyboard('{ArrowDown}{ArrowDown}{Enter}');

    expect(screen.getByLabelText('Referente')).toHaveValue('Luca Rossini');
  });

  it('keeps free text when nothing is picked', async () => {
    mockSearch.mockResolvedValue({ data: [] });
    const user = userEvent.setup();
    render(<Harness />);

    await user.type(screen.getByLabelText('Referente'), 'Sponsor Esterno');

    expect(await screen.findByText('Nessun utente trovato')).toBeInTheDocument();
    expect(screen.getByLabelText('Referente')).toHaveValue('Sponsor Esterno');
  });

  /** 503 = search switched off (local dev): a plain input, no error shown. */
  it('falls back to a plain input when the directory is unavailable', async () => {
    mockSearch.mockRejectedValue(Object.assign(new Error('off'), { status: 503 }));
    const user = userEvent.setup();
    render(<Harness />);

    await user.type(screen.getByLabelText('Referente'), 'ros');
    await waitFor(() => expect(mockSearch).toHaveBeenCalledTimes(1));
    await user.type(screen.getByLabelText('Referente'), 'si');
    await new Promise((r) => setTimeout(r, 400));

    // It stops asking after the first 503.
    expect(mockSearch).toHaveBeenCalledTimes(1);
    expect(screen.queryByTestId('directory-listbox')).not.toBeInTheDocument();
    expect(screen.getByLabelText('Referente')).toHaveValue('rossi');
  });

  it('closes the list on Escape', async () => {
    const user = userEvent.setup();
    render(<Harness />);

    await user.type(screen.getByLabelText('Referente'), 'ros');
    await screen.findByTestId('directory-listbox');
    await user.keyboard('{Escape}');

    expect(screen.queryByTestId('directory-listbox')).not.toBeInTheDocument();
  });
});
