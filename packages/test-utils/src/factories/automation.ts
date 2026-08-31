/**
 * Automation factory for test data generation
 *
 * Creates automations in the definition shape: conditions, actions and triggers.
 */

import type {
  AutomationActions,
  AutomationConditions,
  AutomationKind,
  Condition,
  TriggerNode,
  ViolationSeverity,
} from '@tracearr/shared';
import { executeRawSql } from '../db/pool.js';
import { quote } from '../db/sql.js';

export interface AutomationData {
  id?: string;
  name?: string;
  kind?: AutomationKind;
  severity?: ViolationSeverity;
  conditions?: AutomationConditions;
  actions?: AutomationActions;
  triggers?: TriggerNode[];
  serverUserId?: string | null;
  serverId?: string | null;
  isActive?: boolean;
}

export interface CreatedAutomation {
  id: string;
  name: string;
  kind: AutomationKind;
  severity: ViolationSeverity;
  conditions: AutomationConditions;
  actions: AutomationActions;
  triggers: TriggerNode[];
  serverUserId: string | null;
  serverId: string | null;
  isActive: boolean;
  createdAt: Date;
  updatedAt: Date;
}

/** Overrides a named preset accepts; it owns conditions and triggers itself. */
export type AutomationPresetOverrides = Omit<AutomationData, 'conditions' | 'triggers'>;

let automationCounter = 0;

/** Generate automation data with defaults */
export function buildAutomation(overrides: AutomationData = {}): Required<AutomationData> {
  const index = ++automationCounter;

  return {
    id: overrides.id ?? crypto.randomUUID(),
    name: overrides.name ?? `Automation ${index}`,
    kind: overrides.kind ?? 'policy',
    severity: overrides.severity ?? 'warning',
    conditions: overrides.conditions ?? { groups: [] },
    actions: overrides.actions ?? { actions: [] },
    triggers: overrides.triggers ?? [
      { id: crypto.randomUUID(), type: 'session.started', enabled: true },
    ],
    serverUserId: overrides.serverUserId ?? null,
    serverId: overrides.serverId ?? null,
    isActive: overrides.isActive ?? true,
  };
}

/** Create an automation in the database */
export async function createTestAutomation(
  overrides: AutomationData = {}
): Promise<CreatedAutomation> {
  const data = buildAutomation(overrides);

  const result = await executeRawSql(`
    INSERT INTO automations (
      id, name, kind, severity, conditions, actions, triggers,
      server_user_id, server_id, is_active
    )
    VALUES (
      ${quote(data.id)},
      ${quote(data.name)},
      ${quote(data.kind)},
      ${quote(data.severity)},
      ${quote(JSON.stringify(data.conditions))}::jsonb,
      ${quote(JSON.stringify(data.actions))}::jsonb,
      ${quote(JSON.stringify(data.triggers))}::jsonb,
      ${quote(data.serverUserId)},
      ${quote(data.serverId)},
      ${data.isActive}
    )
    RETURNING *
  `);

  return mapAutomationRow(result.rows[0]);
}

function oneGroup(condition: Condition): AutomationConditions {
  return { groups: [{ conditions: [condition] }] };
}

/** Preset default names carry the counter so two presets of a kind never collide. */
function presetName(base: string): string {
  return `${base} ${++automationCounter}`;
}

/** Concurrent streams above `maxStreams`, counting one stream per device */
export async function createConcurrentStreamsAutomation(
  maxStreams = 3,
  overrides: AutomationPresetOverrides = {}
): Promise<CreatedAutomation> {
  return createTestAutomation({
    name: presetName('Concurrent Streams Automation'),
    conditions: oneGroup({
      field: 'concurrent_streams',
      operator: 'gt',
      value: maxStreams,
    }),
    ...overrides,
  });
}

/** Travel between two sessions faster than `maxSpeedKmh` */
export async function createImpossibleTravelAutomation(
  maxSpeedKmh = 500,
  overrides: AutomationPresetOverrides = {}
): Promise<CreatedAutomation> {
  return createTestAutomation({
    name: presetName('Impossible Travel Automation'),
    conditions: oneGroup({ field: 'travel_speed_kmh', operator: 'gt', value: maxSpeedKmh }),
    ...overrides,
  });
}

/** Two active sessions more than `minDistanceKm` apart */
export async function createSimultaneousLocationsAutomation(
  minDistanceKm = 100,
  overrides: AutomationPresetOverrides = {}
): Promise<CreatedAutomation> {
  return createTestAutomation({
    name: presetName('Simultaneous Locations Automation'),
    conditions: oneGroup({
      field: 'active_session_distance_km',
      operator: 'gt',
      value: minDistanceKm,
    }),
    ...overrides,
  });
}

/** More than `maxIps` distinct addresses inside `windowHours` */
export async function createDeviceVelocityAutomation(
  maxIps = 5,
  windowHours = 24,
  overrides: AutomationPresetOverrides = {}
): Promise<CreatedAutomation> {
  return createTestAutomation({
    name: presetName('Device Velocity Automation'),
    conditions: oneGroup({
      field: 'unique_ips_in_window',
      operator: 'gt',
      value: maxIps,
      params: { window_hours: windowHours },
    }),
    ...overrides,
  });
}

/**
 * Streaming from a blocked country. The local-network check is its own group:
 * groups AND together while conditions inside one group OR.
 */
export async function createGeoRestrictionAutomation(
  countries: string[] = ['XX'],
  overrides: AutomationPresetOverrides = {}
): Promise<CreatedAutomation> {
  return createTestAutomation({
    name: presetName('Geo Restriction Automation'),
    conditions: {
      groups: [
        { conditions: [{ field: 'country', operator: 'in', value: countries }] },
        { conditions: [{ field: 'is_local_network', operator: 'eq', value: false }] },
      ],
    },
    ...overrides,
  });
}

/** No activity for `days`; the trigger carries the same threshold as the condition */
export async function createAccountInactivityAutomation(
  days = 30,
  overrides: AutomationPresetOverrides = {}
): Promise<CreatedAutomation> {
  return createTestAutomation({
    name: presetName('Account Inactivity Automation'),
    conditions: oneGroup({ field: 'inactive_days', operator: 'gte', value: days }),
    triggers: [
      { id: crypto.randomUUID(), type: 'account.inactive_for', enabled: true, params: { days } },
    ],
    ...overrides,
  });
}

/** Map database row to a typed automation */
function mapAutomationRow(row: Record<string, unknown>): CreatedAutomation {
  return {
    id: row.id as string,
    name: row.name as string,
    kind: row.kind as AutomationKind,
    severity: row.severity as ViolationSeverity,
    conditions: row.conditions as AutomationConditions,
    actions: row.actions as AutomationActions,
    triggers: row.triggers as TriggerNode[],
    serverUserId: row.server_user_id as string | null,
    serverId: row.server_id as string | null,
    isActive: row.is_active as boolean,
    createdAt: row.created_at as Date,
    updatedAt: row.updated_at as Date,
  };
}

/** Reset automation counter */
export function resetAutomationCounter(): void {
  automationCounter = 0;
}
