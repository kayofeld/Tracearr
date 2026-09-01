import { beforeAll, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { i18n, initI18n } from '@tracearr/translations';
import { actionPickerEntries, triggerPickerEntries, type Translate } from '@/lib/automations';
import { NodePicker } from '../NodePicker';

let t: Translate;

beforeAll(async () => {
  await initI18n({ lng: 'en' });
  t = i18n.getFixedT(null, 'pages');
});

describe('NodePicker', () => {
  it('groups what it offers and hands back the picked value', async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();
    render(
      <NodePicker entries={triggerPickerEntries(t)} onSelect={onSelect} label="Add trigger" />
    );

    await user.click(screen.getByRole('button', { name: /Add trigger/ }));

    expect(await screen.findByText('Sessions')).toBeInTheDocument();
    expect(screen.getByText('Servers')).toBeInTheDocument();

    await user.click(screen.getByRole('option', { name: /A server goes down/ }));

    expect(onSelect).toHaveBeenCalledWith('server.down');
  });

  it('finds a trigger by a word that is not in its label', async () => {
    const user = userEvent.setup();
    render(<NodePicker entries={triggerPickerEntries(t)} onSelect={vi.fn()} label="Add trigger" />);

    await user.click(screen.getByRole('button', { name: /Add trigger/ }));
    await user.type(await screen.findByRole('combobox'), 'unreachable');

    expect(screen.getByRole('option', { name: /A server goes down/ })).toBeInTheDocument();
    expect(screen.queryByRole('option', { name: /A stream starts/ })).not.toBeInTheDocument();
  });

  it('leads with what pairs well once something has been picked', async () => {
    const user = userEvent.setup();
    render(
      <NodePicker
        entries={triggerPickerEntries(t)}
        suggested={['session.paused']}
        onSelect={vi.fn()}
        label="Add trigger"
      />
    );

    await user.click(screen.getByRole('button', { name: /Add trigger/ }));

    expect(await screen.findByText('Suggested')).toBeInTheDocument();
  });

  it('keeps if out of the picker inside a branch', async () => {
    const user = userEvent.setup();
    const { unmount } = render(
      <NodePicker entries={actionPickerEntries(t)} onSelect={vi.fn()} label="Add action" />
    );

    await user.click(screen.getByRole('button', { name: /Add action/ }));
    expect(await screen.findByRole('option', { name: /If… otherwise…/ })).toBeInTheDocument();
    unmount();

    render(
      <NodePicker
        entries={actionPickerEntries(t, { branch: true })}
        onSelect={vi.fn()}
        label="Add action"
      />
    );

    await user.click(screen.getByRole('button', { name: /Add action/ }));
    expect(await screen.findByText('Notify')).toBeInTheDocument();
    expect(screen.queryByRole('option', { name: /If… otherwise…/ })).not.toBeInTheDocument();
  });
});
