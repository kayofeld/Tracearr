/** Real i18n: the group heading counts, and the verdict rows read as sentences. */
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { initI18n } from '@tracearr/translations';
import type { AutomationRun } from '@tracearr/shared';

const useRun = vi.fn();
vi.mock('@/hooks/queries/useRuns', () => ({ useRun: () => useRun() }));

import { RunDetail } from './RunDetail';

function run(overrides: Partial<AutomationRun> = {}): AutomationRun {
  return {
    id: 'run-1',
    automationId: 'a-1',
    automationName: 'Concurrent cap',
    kind: 'policy',
    outcome: 'completed',
    humanSummary: null,
    severity: 'warning',
    serverUserId: 'su-1',
    sessionId: 'sess-1',
    serverId: 'srv-1',
    subjectKey: 'sess-1',
    ranActions: [],
    subject: {
      kind: 'session',
      name: 'grace@plex',
      personName: 'Grace',
      thumbUrl: null,
      serverName: 'Basement',
      libraryName: null,
      mediaType: null,
    },
    startedAt: '2026-08-19T12:00:00.000Z',
    finishedAt: '2026-08-19T12:00:01.000Z',
    acknowledgedAt: null,
    dismissedAt: null,
    steps: [{ trigger: { id: 'n1', type: 'session.started', edgeKey: null } }],
    session: null,
    evidence: [],
    definitionVersionId: 'ver-1',
    ...overrides,
  };
}

const group = (groupIndex: number, matched: boolean) => ({
  groupIndex,
  matched,
  conditions: [
    {
      field: 'concurrent_streams' as const,
      operator: 'gt' as const,
      threshold: 2,
      actual: 3,
      matched,
    },
  ],
});

beforeAll(async () => {
  await initI18n({ lng: 'en' });
});

beforeEach(() => {
  vi.clearAllMocks();
});

function renderSheet(data: AutomationRun) {
  useRun.mockReturnValue({ data, isLoading: false });
  render(
    <MemoryRouter>
      <RunDetail runId="run-1" onOpenChange={vi.fn()} />
    </MemoryRouter>
  );
}

describe('RunDetail', () => {
  it('numbers the condition groups only when there is more than one', () => {
    renderSheet(run({ evidence: [group(0, true), group(1, false)] }));

    expect(screen.getByText('Group 1')).toBeInTheDocument();
    expect(screen.getByText('Group 2')).toBeInTheDocument();
  });

  it('leaves a single group unnumbered', () => {
    renderSheet(run({ evidence: [group(0, true)] }));

    expect(screen.queryByText('Group 1')).not.toBeInTheDocument();
    expect(screen.getByText('Concurrent Streams greater than 2')).toBeInTheDocument();
  });

  it('names the trigger in words rather than by its stored type', () => {
    renderSheet(run());

    expect(screen.getByText('Triggered by A stream starts')).toBeInTheDocument();
  });

  it('keeps what was playing when only the run itself remembers it', () => {
    renderSheet(
      run({
        session: {
          mediaTitle: 'Dune',
          mediaType: null,
          grandparentTitle: null,
          player: null,
          device: null,
          product: null,
          platform: null,
          ipAddress: '10.0.0.9',
          city: null,
          country: null,
        },
      })
    );

    expect(screen.getByText('Dune')).toBeInTheDocument();
    expect(screen.getByText('10.0.0.9')).toBeInTheDocument();
  });

  it('says which branch an if took, in the words the builder uses', () => {
    renderSheet(
      run({
        steps: [
          { trigger: { id: 'n1', type: 'session.started', edgeKey: null } },
          { action: 'if', success: true, branch: 'else', matched: false, evidence: [] },
        ],
      })
    );

    expect(screen.getByText("Took the 'otherwise' steps")).toBeInTheDocument();
  });

  it('survives a run whose stored evidence is not a list', () => {
    renderSheet(run({ evidence: {} as unknown as AutomationRun['evidence'] }));

    expect(screen.getByText('Triggered by A stream starts')).toBeInTheDocument();
  });
});
