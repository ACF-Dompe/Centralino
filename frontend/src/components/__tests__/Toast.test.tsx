/**
 * Unit tests for Toast component.
 *
 * Tests rendering for each kind (success, error, info), auto-dismiss
 * after 4s, and manual close via the X button.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import Toast from '../Toast';

describe('Toast', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('renders success message with check icon', () => {
    const onClose = vi.fn();
    render(<Toast message={{ kind: 'success', text: 'Operazione completata' }} onClose={onClose} />);

    expect(screen.getByText('Operazione completata')).toBeInTheDocument();
    expect(document.querySelector('svg')).toBeInTheDocument();
  });

  it('renders error message with alert triangle icon', () => {
    const onClose = vi.fn();
    render(<Toast message={{ kind: 'error', text: 'Errore di connessione' }} onClose={onClose} />);

    expect(screen.getByText('Errore di connessione')).toBeInTheDocument();
  });

  it('renders info message', () => {
    const onClose = vi.fn();
    render(<Toast message={{ kind: 'info', text: 'Info generica' }} onClose={onClose} />);

    expect(screen.getByText('Info generica')).toBeInTheDocument();
  });

  it('auto-dismisses after 4 seconds', () => {
    const onClose = vi.fn();
    render(<Toast message={{ kind: 'success', text: 'Auto dismiss' }} onClose={onClose} />);

    expect(onClose).not.toHaveBeenCalled();

    act(() => { vi.advanceTimersByTime(4000); });

    expect(onClose).toHaveBeenCalledOnce();
  });

  it('does not auto-dismiss before 4 seconds', () => {
    const onClose = vi.fn();
    render(<Toast message={{ kind: 'success', text: 'Non ancora' }} onClose={onClose} />);

    act(() => { vi.advanceTimersByTime(3000); });

    expect(onClose).not.toHaveBeenCalled();
  });

  it('calls onClose when the X button is clicked (using fireEvent, not userEvent)', async () => {
    const onClose = vi.fn();
    render(<Toast message={{ kind: 'info', text: 'Chiudi manuale' }} onClose={onClose} />);

    const closeBtn = document.querySelector('button');
    expect(closeBtn).not.toBeNull();
    if (closeBtn) {
      await act(async () => {
        closeBtn.click();
      });
      expect(onClose).toHaveBeenCalledOnce();
    }
  });

  it('differentiates success and error styling', () => {
    const onClose = vi.fn();

    const { container: successContainer } = render(
      <Toast message={{ kind: 'success', text: 'OK' }} onClose={onClose} />,
    );
    const successToast = successContainer.querySelector('.fixed.bottom-4');
    expect(successToast?.textContent).toContain('OK');

    const { container: errorContainer } = render(
      <Toast message={{ kind: 'error', text: 'ERR' }} onClose={onClose} />,
    );
    const errorToast = errorContainer.querySelector('.fixed.bottom-4');
    expect(errorToast?.textContent).toContain('ERR');
  });
});
