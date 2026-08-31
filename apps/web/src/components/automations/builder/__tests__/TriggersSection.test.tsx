import { useState } from 'react';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { initI18n } from '@tracearr/translations';
import type { TriggerNode } from '@tracearr/shared';
import { TriggersSection } from '../TriggersSection';

vi.mock('@/hooks/useServer', () => ({ useServer: () => ({ servers: [] }) }));
vi.mock('@/hooks/queries/useUsers', () => ({ useUsers: () => ({ data: undefined }) }));

beforeAll(async () => {
  await initI18n({ lng: 'en' });
});

const started: TriggerNode = {
  id: '11111111-1111-4111-8111-111111111111',
  type: 'session.started',
  enabled: true,
};
const paused: TriggerNode = {
  id: '22222222-2222-4222-8222-222222222222',
  type: 'session.paused',
  enabled: true,
};
const held: TriggerNode = {
  id: '33333333-3333-4333-8333-333333333333',
  type: 'session.held_for',
  enabled: true,
  params: { minutes: 30, measure: 'current' },
};

function renderSection(triggers: TriggerNode[]) {
  const dispatch = vi.fn();
  render(
    <TriggersSection
      triggers={triggers}
      scope={{ mode: 'global' }}
      enforceAcrossServers={false}
      canEnforceAcrossServers={false}
      issues={new Map()}
      pulseId={null}
      dispatch={dispatch}
    />
  );
  return { dispatch };
}

/** Removal has to actually happen for the focus it leaves behind to be worth asserting. */
function StatefulSection({ initial }: { initial: TriggerNode[] }) {
  const [triggers, setTriggers] = useState(initial);
  return (
    <TriggersSection
      triggers={triggers}
      scope={{ mode: 'global' }}
      enforceAcrossServers={false}
      canEnforceAcrossServers={false}
      issues={new Map()}
      pulseId={null}
      dispatch={(action) => {
        if (action.type === 'removeNode') {
          setTriggers((list) => list.filter((trigger) => trigger.id !== action.id));
        }
      }}
    />
  );
}

/** The step is an <li> of its own, so its rows start after it. */
function rows() {
  return screen.getAllByRole('listitem').slice(1);
}

/** Every row answers the narrow column the same way: icon, controls, then the middle. */
function expectNarrowIdiom(row: HTMLElement | undefined) {
  expect(row?.querySelector('[data-slot="item-media"]')?.className).toContain('@max-lg:order-1');
  expect(row?.querySelector('[data-slot="item-actions"]')?.className).toContain('@max-lg:order-2');
  expect(row?.querySelector('[data-slot="item-actions"]')?.className).toContain('@max-lg:ml-auto');
  expect(row?.querySelector('[data-slot="item-content"]')?.className).toContain('@max-lg:order-3');
  expect(row?.querySelector('[data-slot="item-content"]')?.className).toContain(
    '@max-lg:basis-full'
  );
}

describe('TriggersSection', () => {
  it('says what the section is for while it is empty', () => {
    renderSection([]);

    expect(screen.getByText('What should start this?')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Choose what starts it/ })).toBeInTheDocument();
  });

  it('closes the step with the question about who it applies to, once it has a trigger', () => {
    renderSection([started]);

    expect(screen.getByRole('radio', { name: 'Everyone' })).toBeInTheDocument();
  });

  it('asks nothing about scope while the step is empty', () => {
    renderSection([]);

    expect(screen.queryByRole('radio', { name: 'Everyone' })).not.toBeInTheDocument();
  });

  it('keeps the scope question mounted while a problem points at it', () => {
    render(
      <TriggersSection
        triggers={[]}
        scope={{ mode: 'account', serverId: 's1', serverUserId: '' }}
        enforceAcrossServers={false}
        canEnforceAcrossServers={false}
        issues={new Map([['scope', [{ nodeId: 'scope', message: 'Pick who this applies to' }]]])}
        pulseId={null}
        dispatch={vi.fn()}
      />
    );

    expect(screen.getByRole('radio', { name: 'Everyone' })).toBeInTheDocument();
    expect(screen.getByText('Pick who this applies to')).toBeInTheDocument();
  });

  it('puts an or between the triggers and none before the first', () => {
    renderSection([started, paused]);

    expect(screen.getAllByText('or')).toHaveLength(1);
  });

  it('holds the paused-for threshold in the row itself', async () => {
    const user = userEvent.setup();
    const { dispatch } = renderSection([held]);

    const minutes = screen.getByLabelText('Minutes');
    expect(minutes).toHaveValue('30');
    expect(screen.getByText('this time')).toBeInTheDocument();

    await user.clear(minutes);
    await user.type(minutes, '90');

    expect(dispatch).toHaveBeenLastCalledWith({
      type: 'setTriggerParam',
      id: held.id,
      patch: { minutes: 90 },
    });
  });

  it('switches a trigger off and takes one out', async () => {
    const user = userEvent.setup();
    const { dispatch } = renderSection([started]);

    await user.click(screen.getByRole('switch', { name: /A stream starts/ }));
    expect(dispatch).toHaveBeenCalledWith({ type: 'toggleNode', id: started.id });

    await user.click(screen.getByRole('button', { name: /Remove A stream starts/ }));
    expect(dispatch).toHaveBeenCalledWith({ type: 'removeNode', id: started.id });
  });

  it('toggles a row with D and leaves the modifier combinations to the browser', async () => {
    const user = userEvent.setup();
    const { dispatch } = renderSection([started]);

    rows()[0]?.focus();
    await user.keyboard('d');

    expect(dispatch).toHaveBeenCalledWith({ type: 'toggleNode', id: started.id });

    dispatch.mockClear();
    await user.keyboard('{Meta>}d{/Meta}');

    expect(dispatch).not.toHaveBeenCalled();
  });

  it('removes a row with Delete and hands the keyboard to its neighbour', async () => {
    const user = userEvent.setup();
    render(<StatefulSection initial={[started, paused]} />);

    rows()[0]?.focus();
    await user.keyboard('{Delete}');

    const remaining = rows();
    expect(remaining).toHaveLength(1);
    expect(document.activeElement).toBe(remaining[0]);
  });

  it('stacks a trigger row when the column is narrow, controls still at the right', () => {
    renderSection([held]);

    expectNarrowIdiom(rows()[0]);
  });

  it('shows what a row got wrong', () => {
    const dispatch = vi.fn();
    render(
      <TriggersSection
        triggers={[started]}
        scope={{ mode: 'global' }}
        enforceAcrossServers={false}
        canEnforceAcrossServers={false}
        issues={new Map([[started.id, [{ nodeId: started.id, message: 'Not available here' }]]])}
        pulseId={null}
        dispatch={dispatch}
      />
    );

    expect(screen.getByText('Not available here')).toBeInTheDocument();
  });
});
