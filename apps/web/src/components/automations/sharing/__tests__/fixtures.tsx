import type { ReactElement, ReactNode } from 'react';
import { render } from '@testing-library/react';
import userEvent, { type UserEvent } from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { TemplateEnvelope } from '@tracearr/shared';
import type { TemplatePreview } from '@/lib/api';

const FINGERPRINT = '4f2a7c1d9e3b5a8f0c2d4e6a8b0c2d4e6f8a0b2c4d6e8f0a2b4c6d8e0f2a9c13';

/**
 * A pasted policy that kills a stream from inside a branch, so the review has both a
 * buried consequence and two things to bind.
 */
export const SHARED_ENVELOPE: TemplateEnvelope = {
  schemaVersion: 1,
  slug: 'two-places-at-once',
  name: 'Two places at once',
  description: 'Flag an account playing from two places at the same time.',
  group: 'policies',
  kind: 'policy',
  author: 'moviesRus',
  minServerVersion: '2.2.0',
  inputs: [
    { key: 'to', kind: 'destinations', label: 'Send to', required: true },
    { key: 'server', kind: 'server', label: 'Server', required: false },
  ],
  definition: {
    kind: 'policy',
    severity: 'warning',
    triggers: [
      { id: 'bbbbbbbb-0000-4000-8000-000000000001', type: 'session.started', enabled: true },
    ],
    conditions: {
      groups: [
        {
          id: 'bbbbbbbb-0000-4000-8000-000000000002',
          enabled: true,
          conditions: [
            {
              id: 'bbbbbbbb-0000-4000-8000-000000000003',
              enabled: true,
              field: 'active_session_distance_km',
              operator: 'gte',
              value: 100,
            },
          ],
        },
      ],
    },
    actions: {
      actions: [
        {
          id: 'bbbbbbbb-0000-4000-8000-000000000004',
          type: 'send',
          enabled: true,
          to: { $input: 'to' },
        },
        {
          id: 'bbbbbbbb-0000-4000-8000-000000000005',
          type: 'if',
          enabled: true,
          conditions: {
            groups: [
              {
                id: 'bbbbbbbb-0000-4000-8000-000000000006',
                enabled: true,
                conditions: [
                  {
                    id: 'bbbbbbbb-0000-4000-8000-000000000007',
                    enabled: true,
                    field: 'is_transcoding',
                    operator: 'eq',
                    value: 'video',
                  },
                ],
              },
            ],
          },
          then: [
            { id: 'bbbbbbbb-0000-4000-8000-000000000008', type: 'kill_stream', enabled: true },
          ],
          else: [],
        },
      ],
    },
    scope: { serverId: { $input: 'server' } },
    enforceAcrossServers: false,
    cooldownMinutes: 30,
  },
  fingerprint: FINGERPRINT,
};

export const SHARE_CODE = `tracearr1.${'eJyNkc'.repeat(4)}`;

export function previewOf(overrides: Partial<TemplatePreview> = {}): TemplatePreview {
  return {
    envelope: SHARED_ENVELOPE,
    fingerprint: SHARED_ENVELOPE.fingerprint,
    minServerVersion: { required: '2.2.0', current: '2.3.0', satisfied: true },
    ...overrides,
  };
}

/** The real mutations run against a mocked `api`, so retries would only slow a failure down. */
export function renderSharing(ui: ReactElement): { user: UserEvent } {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  function Wrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  }

  render(ui, { wrapper: Wrapper });
  return { user: userEvent.setup() };
}
