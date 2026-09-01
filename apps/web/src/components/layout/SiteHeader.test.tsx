import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { SidebarProvider, Sidebar, useSidebar } from '@/components/ui/sidebar';
import { SiteHeader } from './SiteHeader';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock('@/hooks/use-mobile', () => ({
  useIsMobile: () => true,
}));

function SheetProbe() {
  const { openMobile } = useSidebar();
  return <span data-testid="sheet-open">{String(openMobile)}</span>;
}

describe('SiteHeader', () => {
  it('gives mobile a sidebar trigger that lives outside the sheet and opens it', async () => {
    const user = userEvent.setup();
    render(
      <SidebarProvider>
        <Sidebar collapsible="icon">nav</Sidebar>
        <SiteHeader />
        <SheetProbe />
      </SidebarProvider>
    );

    expect(screen.getByTestId('sheet-open')).toHaveTextContent('false');
    const trigger = screen.getByRole('button', { name: 'toggleSidebar' });
    await user.click(trigger);
    expect(screen.getByTestId('sheet-open')).toHaveTextContent('true');
  });

  it('is hidden at desktop widths', () => {
    render(
      <SidebarProvider>
        <SiteHeader />
      </SidebarProvider>
    );
    const header = screen.getByRole('banner');
    expect(header.className).toContain('md:hidden');
  });
});
