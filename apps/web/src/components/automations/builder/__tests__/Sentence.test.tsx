import { beforeAll, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { initI18n } from '@tracearr/translations';
import { SENTENCE_SECTIONS, type DescribeFragment } from '@/lib/automations';
import { Sentence } from '../Sentence';

beforeAll(async () => {
  await initI18n({ lng: 'en' });
});

const fragments: DescribeFragment[] = [
  { nodeId: 'trigger-1', text: 'When a stream starts,' },
  { nodeId: null, text: 'then' },
  { nodeId: 'action-1', text: 'send to team-discord.' },
];

describe('Sentence', () => {
  it('makes every clause that came from a node clickable', async () => {
    const user = userEvent.setup();
    const onFocusNode = vi.fn();
    render(<Sentence fragments={fragments} onFocusNode={onFocusNode} />);

    await user.click(screen.getByRole('button', { name: 'When a stream starts,' }));

    expect(onFocusNode).toHaveBeenCalledWith('trigger-1');
  });

  it('leaves the connective text as plain text', () => {
    render(<Sentence fragments={fragments} onFocusNode={vi.fn()} />);

    expect(screen.queryByRole('button', { name: 'then' })).not.toBeInTheDocument();
    expect(screen.getByText('then')).toBeInTheDocument();
  });

  it('counts what it left out and still says who it applies to', () => {
    const long: DescribeFragment[] = [
      ...Array.from({ length: 12 }, (_, index) => ({
        nodeId: `node-${index}`,
        text: 'a stream has been paused for thirty minutes',
      })),
      { nodeId: SENTENCE_SECTIONS.scope, text: 'Applies to Beehive.' },
    ];

    render(<Sentence fragments={long} onFocusNode={vi.fn()} />);

    expect(screen.getByText(/\+\d+ more/)).toHaveAttribute('data-slot', 'badge');
    expect(screen.getByRole('button', { name: 'Applies to Beehive.' })).toBeInTheDocument();
  });

  it('caps a long sentence and counts what it left out', () => {
    const long: DescribeFragment[] = Array.from({ length: 12 }, (_, index) => ({
      nodeId: `node-${index}`,
      text: 'a stream has been paused for thirty minutes',
    }));

    render(<Sentence fragments={long} onFocusNode={vi.fn()} />);

    expect(screen.getByText(/\+\d+ more/)).toBeInTheDocument();
  });
});
