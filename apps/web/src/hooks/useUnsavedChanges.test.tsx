import { describe, it, expect } from 'vitest';
import { useState } from 'react';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createMemoryRouter, Link, RouterProvider } from 'react-router';
import { useUnsavedChanges } from './useUnsavedChanges';

function Editor({ dirty: initialDirty }: { dirty: boolean }) {
  const [dirty, setDirty] = useState(initialDirty);
  const blocker = useUnsavedChanges(dirty);

  return (
    <div>
      <h1>editor</h1>
      <Link to="/elsewhere">leave</Link>
      <button type="button" onClick={() => setDirty(false)}>
        save
      </button>
      {blocker.state === 'blocked' && (
        <>
          <button type="button" onClick={() => blocker.proceed()}>
            discard
          </button>
          <button type="button" onClick={() => blocker.reset()}>
            stay
          </button>
        </>
      )}
    </div>
  );
}

function renderEditor(dirty: boolean) {
  const router = createMemoryRouter(
    [
      { path: '/', element: <Editor dirty={dirty} /> },
      { path: '/elsewhere', element: <h1>elsewhere</h1> },
    ],
    { initialEntries: ['/'] }
  );
  return render(<RouterProvider router={router} />);
}

function dispatchBeforeUnload() {
  const event = new Event('beforeunload', { cancelable: true });
  window.dispatchEvent(event);
  return event;
}

describe('useUnsavedChanges', () => {
  it('holds the user on the page while there are unsaved changes', async () => {
    const user = userEvent.setup();
    renderEditor(true);

    await user.click(screen.getByRole('link', { name: 'leave' }));

    expect(screen.getByRole('heading', { name: 'editor' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'discard' })).toBeInTheDocument();
  });

  it('lets the blocked navigation through once the user confirms', async () => {
    const user = userEvent.setup();
    renderEditor(true);

    await user.click(screen.getByRole('link', { name: 'leave' }));
    await user.click(screen.getByRole('button', { name: 'discard' }));

    expect(screen.getByRole('heading', { name: 'elsewhere' })).toBeInTheDocument();
  });

  it('navigates freely when nothing is dirty', async () => {
    const user = userEvent.setup();
    renderEditor(false);

    await user.click(screen.getByRole('link', { name: 'leave' }));

    expect(screen.getByRole('heading', { name: 'elsewhere' })).toBeInTheDocument();
  });

  it('lets the user carry on after choosing to stay, then saving', async () => {
    const user = userEvent.setup();
    renderEditor(true);

    await user.click(screen.getByRole('link', { name: 'leave' }));
    await user.click(screen.getByRole('button', { name: 'stay' }));

    expect(screen.getByRole('heading', { name: 'editor' })).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'save' }));
    await user.click(screen.getByRole('link', { name: 'leave' }));

    expect(screen.getByRole('heading', { name: 'elsewhere' })).toBeInTheDocument();
  });

  it('drops the block when the form is saved while it is holding a navigation', async () => {
    const user = userEvent.setup();
    renderEditor(true);

    await user.click(screen.getByRole('link', { name: 'leave' }));
    await user.click(screen.getByRole('button', { name: 'save' }));

    expect(screen.queryByRole('button', { name: 'discard' })).not.toBeInTheDocument();

    await user.click(screen.getByRole('link', { name: 'leave' }));

    expect(screen.getByRole('heading', { name: 'elsewhere' })).toBeInTheDocument();
  });

  it('cancels a page unload while there are unsaved changes', () => {
    renderEditor(true);

    expect(dispatchBeforeUnload().defaultPrevented).toBe(true);
  });

  it('leaves a page unload alone when nothing is dirty', () => {
    renderEditor(false);

    expect(dispatchBeforeUnload().defaultPrevented).toBe(false);
  });
});
