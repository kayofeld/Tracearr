import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type * as UseMobile from '@/hooks/use-mobile';
import { SidebarProvider, SidebarTrigger, useSidebar } from './sidebar';

vi.mock('@/hooks/use-mobile', async (importOriginal) => {
  const actual = await importOriginal<typeof UseMobile>();
  return { ...actual, useIsMobile: () => mockIsMobile };
});

let mockIsMobile = false;

function StateProbe() {
  const { state } = useSidebar();
  return <span data-testid="state">{state}</span>;
}

function renderProvider(props?: { defaultOpen?: boolean }) {
  return render(
    <SidebarProvider {...props}>
      <StateProbe />
      <SidebarTrigger />
    </SidebarProvider>
  );
}

function clearCookies() {
  for (const entry of document.cookie.split(';')) {
    const name = entry.split('=')[0]?.trim();
    if (name) document.cookie = `${name}=; path=/; max-age=0`;
  }
}

describe('SidebarProvider persistence', () => {
  beforeEach(clearCookies);

  it('falls back to defaultOpen when no cookie is stored', () => {
    renderProvider({ defaultOpen: false });

    expect(screen.getByTestId('state')).toHaveTextContent('collapsed');
  });

  it('restores the collapsed state written by a previous session', () => {
    document.cookie = 'sidebar_state=false; path=/';

    renderProvider();

    expect(screen.getByTestId('state')).toHaveTextContent('collapsed');
  });

  it('lets the stored state win over defaultOpen', () => {
    document.cookie = 'sidebar_state=true; path=/';

    renderProvider({ defaultOpen: false });

    expect(screen.getByTestId('state')).toHaveTextContent('expanded');
  });

  it('ignores a cookie whose name merely ends with the sidebar key', () => {
    document.cookie = 'not_sidebar_state=false; path=/';

    renderProvider({ defaultOpen: true });

    expect(screen.getByTestId('state')).toHaveTextContent('expanded');
  });

  it('ignores a stored value that is not a boolean', () => {
    document.cookie = 'sidebar_state=maybe; path=/';

    renderProvider({ defaultOpen: true });

    expect(screen.getByTestId('state')).toHaveTextContent('expanded');
  });

  it('writes the new state to the cookie when toggled', async () => {
    const user = userEvent.setup();
    renderProvider({ defaultOpen: true });

    await user.click(screen.getByRole('button'));

    expect(screen.getByTestId('state')).toHaveTextContent('collapsed');
    expect(document.cookie).toContain('sidebar_state=false');
  });
});

describe('SidebarTrigger disclosure state', () => {
  beforeEach(clearCookies);
  afterEach(() => {
    mockIsMobile = false;
  });

  it('announces the desktop panel state', async () => {
    const user = userEvent.setup();
    renderProvider({ defaultOpen: true });
    const trigger = screen.getByRole('button');

    expect(trigger).toHaveAttribute('aria-expanded', 'true');

    await user.click(trigger);

    expect(trigger).toHaveAttribute('aria-expanded', 'false');
  });

  it('announces the mobile sheet state, not the desktop one', async () => {
    mockIsMobile = true;
    const user = userEvent.setup();
    // defaultOpen drives the desktop panel; the mobile sheet starts closed
    // regardless, so the two states disagree here on purpose.
    renderProvider({ defaultOpen: true });
    const trigger = screen.getByRole('button');

    expect(trigger).toHaveAttribute('aria-expanded', 'false');

    await user.click(trigger);

    expect(trigger).toHaveAttribute('aria-expanded', 'true');
  });

  it('lets a caller supply a translated accessible name', () => {
    render(
      <SidebarProvider>
        <SidebarTrigger aria-label="Navigation ausklappen" />
      </SidebarProvider>
    );

    expect(screen.getByRole('button', { name: 'Navigation ausklappen' })).toBeInTheDocument();
  });
});
