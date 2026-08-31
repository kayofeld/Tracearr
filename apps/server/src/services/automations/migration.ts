/**
 * Migration script to convert legacy rules to V2 format.
 *
 * Legacy rule types:
 * - impossible_travel: Speed between locations exceeds threshold
 * - simultaneous_locations: Multiple locations at same time
 * - device_velocity: Too many unique IPs in time window
 * - concurrent_streams: Too many active streams
 * - geo_restriction: Country blocklist/allowlist
 * - account_inactivity: No activity for period
 *
 * Each legacy type is converted to V2 conditions and actions.
 */
import type {
  AutomationConditions,
  AutomationActions,
  ViolationSeverity,
  Condition,
  ImpossibleTravelParams,
  SimultaneousLocationsParams,
  DeviceVelocityParams,
  ConcurrentStreamsParams,
  GeoRestrictionParams,
  AccountInactivityParams,
} from '@tracearr/shared';
import { automationsLogger as logger } from '../../utils/logger.js';

/** Mirrors the dropped `automations.type` enum, for upgrades that skip a version. */
export const LEGACY_RULE_TYPES = [
  'impossible_travel',
  'simultaneous_locations',
  'device_velocity',
  'concurrent_streams',
  'geo_restriction',
  'account_inactivity',
] as const;

export type LegacyRuleType = (typeof LEGACY_RULE_TYPES)[number];

export interface LegacyRule {
  id: string;
  name: string;
  type: LegacyRuleType;
  params: Record<string, unknown>;
  serverUserId: string | null;
  serverId: string | null;
  isActive: boolean;
}

export interface MigratedRule {
  id: string;
  severity: ViolationSeverity;
  conditions: AutomationConditions;
  actions: AutomationActions;
}

/**
 * Convert legacy impossible_travel rule to V2 format.
 *
 * Original behavior: Flag if calculated speed between locations exceeds maxSpeedKmh.
 * V2 equivalent: travel_speed_kmh > maxSpeedKmh
 * Also applies excludePrivateIps as is_local_network = false condition if enabled.
 */
function convertImpossibleTravel(params: ImpossibleTravelParams): AutomationConditions {
  const groups: Array<{ conditions: Condition[] }> = [
    {
      conditions: [
        {
          field: 'travel_speed_kmh',
          operator: 'gt',
          value: params.maxSpeedKmh,
        },
      ],
    },
  ];

  // If excludePrivateIps is true, add separate AND group for non-local IPs
  if (params.excludePrivateIps) {
    groups.push({
      conditions: [
        {
          field: 'is_local_network',
          operator: 'eq',
          value: false,
        },
      ],
    });
  }

  return { groups };
}

/**
 * Convert legacy simultaneous_locations rule to V2 format.
 *
 * Original behavior: Flag if user has active sessions in locations > minDistanceKm apart.
 * V2 equivalent: active_session_distance_km > minDistanceKm
 */
function convertSimultaneousLocations(params: SimultaneousLocationsParams): AutomationConditions {
  const groups: Array<{ conditions: Condition[] }> = [
    {
      conditions: [
        {
          field: 'active_session_distance_km',
          operator: 'gt',
          value: params.minDistanceKm,
        },
      ],
    },
  ];

  if (params.excludePrivateIps) {
    groups.push({
      conditions: [
        {
          field: 'is_local_network',
          operator: 'eq',
          value: false,
        },
      ],
    });
  }

  return { groups };
}

/**
 * Convert legacy device_velocity rule to V2 format.
 *
 * Original behavior: Flag if unique IPs (or devices if groupByDevice) in windowHours exceeds maxIps.
 * V2 equivalent:
 *   - groupByDevice=false (default): unique_ips_in_window > maxIps
 *   - groupByDevice=true: unique_devices_in_window > maxIps
 *
 */
function convertDeviceVelocity(params: DeviceVelocityParams): AutomationConditions {
  const field = params.groupByDevice ? 'unique_devices_in_window' : 'unique_ips_in_window';

  const groups: Array<{ conditions: Condition[] }> = [
    {
      conditions: [
        {
          field,
          operator: 'gt',
          value: params.maxIps,
          params: {
            // v1 accepted any windowHours; the v2 schema caps at 168 and a
            // larger value would make the converted rule uneditable
            window_hours: Math.min(params.windowHours || 24, 168),
          },
        },
      ],
    },
  ];

  // Separate AND group for excludePrivateIps
  if (params.excludePrivateIps) {
    groups.push({
      conditions: [
        {
          field: 'is_local_network',
          operator: 'eq',
          value: false,
        },
      ],
    });
  }

  return { groups };
}

/**
 * Convert legacy concurrent_streams rule to V2 format.
 *
 * Original behavior: Flag if active streams > maxStreams.
 * V2 equivalent: concurrent_streams > maxStreams
 */
function convertConcurrentStreams(params: ConcurrentStreamsParams): AutomationConditions {
  const groups: Array<{ conditions: Condition[] }> = [
    {
      conditions: [
        {
          field: 'concurrent_streams',
          operator: 'gt',
          value: params.maxStreams,
        },
      ],
    },
  ];

  if (params.excludePrivateIps) {
    groups.push({
      conditions: [
        {
          field: 'is_local_network',
          operator: 'eq',
          value: false,
        },
      ],
    });
  }

  return { groups };
}

/**
 * Convert legacy geo_restriction rule to V2 format.
 *
 * Original behavior:
 * - blocklist mode: Flag if country IN blocked list
 * - allowlist mode: Flag if country NOT IN allowed list
 *
 * V2 equivalent:
 * - blocklist: country IN [blocked countries]
 * - allowlist: country NOT IN [allowed countries]
 */
function convertGeoRestriction(params: GeoRestrictionParams): AutomationConditions {
  const groups: Array<{ conditions: Condition[] }> = [];

  if (params.mode === 'blocklist') {
    groups.push({
      conditions: [
        {
          field: 'country',
          operator: 'in',
          value: params.countries,
        },
      ],
    });
  } else {
    // allowlist - flag if NOT in allowed countries
    groups.push({
      conditions: [
        {
          field: 'country',
          operator: 'not_in',
          value: params.countries,
        },
      ],
    });
  }

  // If excludePrivateIps is true, add separate AND group for non-local IPs
  if (params.excludePrivateIps) {
    groups.push({
      conditions: [
        {
          field: 'is_local_network',
          operator: 'eq',
          value: false,
        },
      ],
    });
  }

  return { groups };
}

/**
 * Convert legacy account_inactivity rule to V2 format.
 *
 * Original behavior: Flag if last activity > threshold.
 * V2 equivalent: inactive_days > calculated_days
 *
 * Note: This triggers when a previously inactive user starts a session.
 */
function convertAccountInactivity(params: AccountInactivityParams): AutomationConditions {
  // Convert to days for comparison
  let inactivityDays = params.inactivityValue;
  if (params.inactivityUnit === 'weeks') {
    inactivityDays *= 7;
  } else if (params.inactivityUnit === 'months') {
    inactivityDays *= 30; // Approximate
  }

  return {
    groups: [
      {
        conditions: [
          {
            field: 'inactive_days',
            // v1's account-inactivity check compared with gte; gt here
            // fired one day late for every converted rule
            operator: 'gte',
            value: inactivityDays,
          },
        ],
      },
    ],
  };
}

/**
 * Create default actions for migrated rules.
 * Violations are auto-created from rule severity, so no violation action needed.
 */
function createDefaultActions(): AutomationActions {
  return {
    actions: [],
  };
}

/**
 * Convert a legacy rule to V2 format.
 */
export function convertLegacyRule(rule: LegacyRule): MigratedRule | null {
  let conditions: AutomationConditions;

  try {
    switch (rule.type) {
      case 'impossible_travel':
        conditions = convertImpossibleTravel(rule.params as unknown as ImpossibleTravelParams);
        break;
      case 'simultaneous_locations':
        conditions = convertSimultaneousLocations(
          rule.params as unknown as SimultaneousLocationsParams
        );
        break;
      case 'device_velocity':
        conditions = convertDeviceVelocity(rule.params as unknown as DeviceVelocityParams);
        break;
      case 'concurrent_streams':
        conditions = convertConcurrentStreams(rule.params as unknown as ConcurrentStreamsParams);
        break;
      case 'geo_restriction':
        conditions = convertGeoRestriction(rule.params as unknown as GeoRestrictionParams);
        break;
      case 'account_inactivity':
        conditions = convertAccountInactivity(rule.params as unknown as AccountInactivityParams);
        break;
      default:
        logger.warn(`Unknown rule type: ${rule.type}`, { ruleId: rule.id, type: rule.type });
        return null;
    }

    return {
      id: rule.id,
      severity: 'warning' as ViolationSeverity,
      conditions,
      actions: createDefaultActions(),
    };
  } catch (error) {
    logger.error(`Error converting rule ${rule.id}`, { ruleId: rule.id, error });
    return null;
  }
}
