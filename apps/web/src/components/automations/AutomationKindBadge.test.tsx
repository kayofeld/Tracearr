/** Real i18n: the two words are the point, and echoing keys would prove nothing. */
import { beforeAll, describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { initI18n } from '@tracearr/translations';
import { AutomationKindBadge } from './AutomationKindBadge';

beforeAll(async () => {
  await initI18n({ lng: 'en' });
});

describe('AutomationKindBadge', () => {
  it('calls a policy a violation and a notification an alert', () => {
    const { rerender } = render(<AutomationKindBadge kind="policy" />);

    expect(screen.getByText('Violation')).toBeInTheDocument();

    rerender(<AutomationKindBadge kind="notification" />);

    expect(screen.getByText('Alert')).toBeInTheDocument();
  });

  it('weights the two kinds differently, so a list reads at a glance', () => {
    const { container, rerender } = render(<AutomationKindBadge kind="policy" />);
    const policy = container.firstElementChild?.className;

    rerender(<AutomationKindBadge kind="notification" />);

    expect(container.firstElementChild?.className).not.toBe(policy);
  });
});
