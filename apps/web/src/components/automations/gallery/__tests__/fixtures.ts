import type { TemplateDefinition, TemplateInput } from '@tracearr/shared';
import type { AutomationTemplate } from '@/lib/api';

/** The catalog rows the gallery tests read, one per group. */
export function template(
  overrides: Partial<AutomationTemplate> & { id: string; slug: string },
  version: { inputs: TemplateInput[]; definition: TemplateDefinition }
): AutomationTemplate {
  return {
    name: overrides.slug,
    description: '',
    group: 'notifications',
    kind: 'notification',
    builtin: true,
    source: 'builtin',
    author: null,
    currentVersion: 1,
    usedBy: 0,
    createdAt: '2026-08-01T00:00:00.000Z',
    updatedAt: '2026-08-01T00:00:00.000Z',
    ...overrides,
    version: { version: 1, ...version },
  };
}

const notification = (triggerType: 'session.started' | 'server.down'): TemplateDefinition => ({
  kind: 'notification',
  triggers: [{ id: 'aaaaaaaa-0000-4000-8000-000000000001', type: triggerType, enabled: true }],
  conditions: { groups: [] },
  actions: {
    actions: [
      {
        id: 'aaaaaaaa-0000-4000-8000-000000000002',
        type: 'send',
        enabled: true,
        to: { $input: 'to' },
      },
    ],
  },
  scope: { serverId: { $input: 'server' } },
  enforceAcrossServers: false,
  cooldownMinutes: null,
});

const sendInputs: TemplateInput[] = [
  { key: 'server', kind: 'server', label: 'Server', required: false },
  { key: 'to', kind: 'destinations', label: 'Send to', required: true },
];

export const STREAM_STARTED = template(
  { id: 'template-stream-started', slug: 'stream-started', name: 'Stream started' },
  { inputs: sendInputs, definition: notification('session.started') }
);

export const SERVER_DOWN = template(
  {
    id: 'template-server-down',
    slug: 'server-down',
    name: 'Server down',
    group: 'server_health',
  },
  { inputs: sendInputs, definition: notification('server.down') }
);

export const CONCURRENT_STREAMS = template(
  {
    id: 'template-concurrent-streams',
    slug: 'concurrent-streams',
    name: 'Too many streams at once',
    group: 'policies',
    kind: 'policy',
  },
  {
    inputs: [
      {
        key: 'max',
        kind: 'number',
        label: 'Streams allowed',
        required: false,
        default: 3,
        min: 1,
        max: 100,
      },
    ],
    definition: {
      kind: 'policy',
      severity: 'warning',
      triggers: [
        { id: 'aaaaaaaa-0000-4000-8000-000000000011', type: 'session.started', enabled: true },
      ],
      conditions: {
        groups: [
          {
            id: 'aaaaaaaa-0000-4000-8000-000000000012',
            enabled: true,
            conditions: [
              {
                id: 'aaaaaaaa-0000-4000-8000-000000000013',
                enabled: true,
                field: 'concurrent_streams',
                operator: 'gt',
                value: { $input: 'max' },
              },
            ],
          },
        ],
      },
      actions: { actions: [] },
      scope: {},
      enforceAcrossServers: false,
      cooldownMinutes: null,
    },
  }
);

export const KILL_PAUSED = template(
  {
    id: 'template-kill-paused-streams',
    slug: 'kill-paused-streams',
    name: 'Stop paused streams',
    group: 'housekeeping',
  },
  {
    inputs: [
      {
        key: 'minutes',
        kind: 'duration',
        unit: 'minutes',
        label: 'Minutes paused',
        required: false,
        default: 30,
        min: 1,
        max: 1440,
      },
      {
        key: 'message',
        kind: 'text',
        label: 'Message shown to the viewer',
        required: false,
        maxLength: 500,
        default: 'Your stream was stopped because it was paused for too long',
      },
    ],
    definition: {
      kind: 'notification',
      triggers: [
        {
          id: 'aaaaaaaa-0000-4000-8000-000000000021',
          type: 'session.held_for',
          enabled: true,
          params: { minutes: { $input: 'minutes' }, measure: 'current' },
        },
      ],
      conditions: { groups: [] },
      actions: {
        actions: [
          {
            id: 'aaaaaaaa-0000-4000-8000-000000000022',
            type: 'kill_stream',
            enabled: true,
            message: { $input: 'message' },
          },
        ],
      },
      scope: {},
      enforceAcrossServers: false,
      cooldownMinutes: null,
    },
  }
);

export const PAUSED_TOO_LONG = template(
  { id: 'template-paused-too-long', slug: 'paused-too-long', name: 'Paused too long' },
  {
    inputs: [
      {
        key: 'minutes',
        kind: 'duration',
        unit: 'minutes',
        label: 'Minutes paused',
        required: false,
        default: 30,
        min: 1,
        max: 1440,
      },
      ...sendInputs,
    ],
    definition: {
      kind: 'notification',
      triggers: [
        {
          id: 'aaaaaaaa-0000-4000-8000-000000000031',
          type: 'session.held_for',
          enabled: true,
          params: { minutes: { $input: 'minutes' }, measure: 'current' },
        },
      ],
      conditions: { groups: [] },
      actions: {
        actions: [
          {
            id: 'aaaaaaaa-0000-4000-8000-000000000032',
            type: 'send',
            enabled: true,
            to: { $input: 'to' },
          },
        ],
      },
      scope: { serverId: { $input: 'server' } },
      enforceAcrossServers: false,
      cooldownMinutes: null,
    },
  }
);

/**
 * Long enough that the capped sentence stops before its last clause, and gated on a
 * boolean, so both the search index and the live sentence have something to prove.
 */
export const BLOCKED_COUNTRIES = template(
  {
    id: 'template-geo-restriction',
    slug: 'geo-restriction',
    name: 'Blocked countries',
    group: 'policies',
    kind: 'policy',
  },
  {
    inputs: [
      {
        key: 'countries',
        kind: 'field_value',
        field: 'country',
        label: 'Blocked countries',
        required: true,
      },
      {
        key: 'ignoreLan',
        kind: 'boolean',
        label: 'Ignore local network sessions',
        required: false,
        default: true,
      },
    ],
    definition: {
      kind: 'policy',
      severity: 'warning',
      triggers: [
        { id: 'aaaaaaaa-0000-4000-8000-000000000041', type: 'session.started', enabled: true },
      ],
      conditions: {
        groups: [
          {
            id: 'aaaaaaaa-0000-4000-8000-000000000042',
            enabled: true,
            conditions: [
              {
                id: 'aaaaaaaa-0000-4000-8000-000000000043',
                enabled: true,
                field: 'country',
                operator: 'in',
                value: { $input: 'countries' },
              },
              {
                id: 'aaaaaaaa-0000-4000-8000-000000000044',
                enabled: true,
                field: 'is_transcoding',
                operator: 'eq',
                value: 'video',
              },
            ],
          },
          {
            id: 'aaaaaaaa-0000-4000-8000-000000000045',
            enabled: { $input: 'ignoreLan' },
            conditions: [
              {
                id: 'aaaaaaaa-0000-4000-8000-000000000046',
                enabled: true,
                field: 'is_local_network',
                operator: 'eq',
                value: false,
              },
            ],
          },
        ],
      },
      actions: {
        actions: [
          {
            id: 'aaaaaaaa-0000-4000-8000-000000000047',
            type: 'message_client',
            enabled: true,
            message: 'Not here',
          },
        ],
      },
      scope: {},
      enforceAcrossServers: false,
      cooldownMinutes: null,
    },
  }
);

/** Someone shared this one with every blank already answered. */
export const NO_INPUTS = template(
  { id: 'template-no-inputs', slug: 'no-inputs', name: 'Stop 4K transcodes', builtin: false },
  {
    inputs: [],
    definition: {
      kind: 'notification',
      triggers: [
        { id: 'aaaaaaaa-0000-4000-8000-000000000051', type: 'session.started', enabled: true },
      ],
      conditions: { groups: [] },
      actions: {
        actions: [
          { id: 'aaaaaaaa-0000-4000-8000-000000000052', type: 'kill_stream', enabled: true },
        ],
      },
      scope: {},
      enforceAcrossServers: false,
      cooldownMinutes: null,
    },
  }
);

export const TEMPLATES: AutomationTemplate[] = [
  STREAM_STARTED,
  PAUSED_TOO_LONG,
  SERVER_DOWN,
  CONCURRENT_STREAMS,
  BLOCKED_COUNTRIES,
  KILL_PAUSED,
];
