import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { CopyButton } from './copy-button';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock('sonner', () => ({
  toast: { error: vi.fn() },
}));

import { toast } from 'sonner';

const originalClipboard = Object.getOwnPropertyDescriptor(navigator, 'clipboard');

describe('CopyButton', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.useRealTimers();
    if (originalClipboard) Object.defineProperty(navigator, 'clipboard', originalClipboard);
    else delete (navigator as { clipboard?: Clipboard }).clipboard;
  });

  it('puts the value on the clipboard', async () => {
    const user = userEvent.setup();
    render(<CopyButton value="tracearr-api-key" label="Copy API key" />);

    await user.click(screen.getByRole('button', { name: 'Copy API key' }));

    await expect(navigator.clipboard.readText()).resolves.toBe('tracearr-api-key');
  });

  it('confirms with a check icon, then returns to the copy icon', async () => {
    vi.useFakeTimers();
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText: vi.fn().mockResolvedValue(undefined) },
      configurable: true,
    });
    const { container } = render(<CopyButton value="abc" label="Copy token" />);

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Copy token' }));
    });

    expect(container.querySelector('.lucide-check')).toBeInTheDocument();

    act(() => {
      vi.advanceTimersByTime(1500);
    });

    expect(container.querySelector('.lucide-check')).toBeNull();
    expect(container.querySelector('.lucide-copy')).toBeInTheDocument();
  });

  it('reports a clipboard the browser refused', async () => {
    const user = userEvent.setup();
    render(<CopyButton value="abc" label="Copy token" />);
    vi.spyOn(navigator.clipboard, 'writeText').mockRejectedValue(new Error('denied'));

    await user.click(screen.getByRole('button', { name: 'Copy token' }));

    expect(toast.error).toHaveBeenCalledWith('toast.error.copyFailed');
  });

  it('keeps the icon-only shape by default and writes the label beside it on request', () => {
    const { rerender } = render(<CopyButton value="abc" label="Copy the share code" />);

    expect(screen.getByRole('button', { name: 'Copy the share code' })).toHaveTextContent('');

    rerender(<CopyButton value="abc" label="Copy the share code" showLabel />);

    expect(screen.getByRole('button', { name: 'Copy the share code' })).toHaveTextContent(
      'Copy the share code'
    );
  });

  it('does not copy while disabled', async () => {
    const user = userEvent.setup();
    render(<CopyButton value="abc" label="Copy token" disabled />);

    await user.click(screen.getByRole('button', { name: 'Copy token' }));

    await expect(navigator.clipboard.readText()).resolves.toBe('');
  });
});
