/** The builder's action metadata registry: config fields, colours and per-type defaults. */

import {
  LEAF_ACTION_TYPES,
  type LeafAction,
  type LeafActionType,
  type TrustAction,
  type ViolationSeverity,
} from '@tracearr/shared';
import type { PagesTextKey, Translate } from './conditionFields';

// Config field types for rendering action configuration
export type ConfigFieldType = 'number' | 'text' | 'select' | 'slider' | 'destinations';

// Option definition for select fields
export interface ConfigFieldOption {
  value: string;
  label: string;
  /** Tooltip shown on hover */
  tooltip?: string;
}

// Config field definition
export interface ConfigField {
  name: string;
  type: ConfigFieldType;
  /** An idea several actions carry is labelled once, from the shared catalog. */
  labelKey: PagesTextKey;
  descriptionKey?: PagesTextKey;
  placeholderKey?: PagesTextKey;
  /** The unit named beside a number input. */
  unitKey?: PagesTextKey;
  required?: boolean;
  /** Options this field takes from a translated catalog instead of carrying inline. */
  optionSource?: 'sessionTargets' | 'trustModes';
  min?: number;
  max?: number;
  step?: number;
  /** If true, renders on its own line below other fields */
  fullWidth?: boolean;
}

// Action definition interface
export interface ActionDefinition {
  type: LeafActionType;
  configFields: ConfigField[];
  color: 'default' | 'warning' | 'destructive';
}

export const SEVERITIES = [
  'low',
  'warning',
  'high',
] as const satisfies readonly ViolationSeverity[];

/** Which sessions a kill_stream or message_client action reaches. */
const SESSION_TARGETS = ['triggering', 'oldest', 'newest', 'all_except_one', 'all_user'] as const;

const TRUST_MODES = ['adjust', 'set', 'reset'] as const satisfies readonly TrustAction['mode'][];

export function severityLabel(t: Translate, severity: ViolationSeverity): string {
  return t(`automations.severity.${severity}`);
}

export function actionLabel(t: Translate, type: LeafActionType): string {
  return t(`automations.actions.${type}.label`);
}

export function actionDescription(t: Translate, type: LeafActionType): string {
  return t(`automations.actions.${type}.description`);
}

/** Only message_client carries a caveat, so only it has a hint key. */
export function actionHint(t: Translate, type: LeafActionType): string | undefined {
  return type === 'message_client' ? t('automations.actions.message_client.hint') : undefined;
}

/** A config field's choices, translated from the catalog it names. */
export function configFieldOptions(t: Translate, field: ConfigField): ConfigFieldOption[] {
  switch (field.optionSource) {
    case 'sessionTargets':
      return SESSION_TARGETS.map((value) => ({
        value,
        label: t(`automations.sessionTargets.${value}.label`),
        tooltip: t(`automations.sessionTargets.${value}.tooltip`),
      }));
    case 'trustModes':
      return TRUST_MODES.map((value) => ({
        value,
        label: t(`automations.trustModes.${value}.label`),
      }));
    default:
      return [];
  }
}

// The main action definitions registry
const ACTION_DEFINITIONS: Record<LeafActionType, ActionDefinition> = {
  send: {
    type: 'send',
    color: 'default',
    configFields: [
      {
        name: 'to',
        labelKey: 'automations.bind.destinationsLabel',
        type: 'destinations',
        required: true,
      },
      {
        name: 'cooldown_minutes',
        labelKey: 'automations.configFields.cooldown_minutes.label',
        descriptionKey: 'automations.actions.send.fields.cooldown_minutes.description',
        type: 'number',
        min: 0,
        max: 1440,
        step: 5,
        unitKey: 'automations.units.minutes',
      },
    ],
  },

  trust: {
    type: 'trust',
    color: 'default',
    configFields: [
      {
        name: 'mode',
        labelKey: 'automations.actions.trust.fields.mode.label',
        type: 'select',
        required: true,
        optionSource: 'trustModes',
      },
      {
        name: 'amount',
        labelKey: 'automations.actions.trust.fields.amount.label',
        descriptionKey: 'automations.actions.trust.fields.amount.description',
        type: 'number',
        min: -100,
        max: 100,
        step: 1,
      },
      {
        name: 'value',
        labelKey: 'automations.actions.trust.fields.value.label',
        type: 'slider',
        min: 0,
        max: 100,
        step: 1,
      },
    ],
  },

  kill_stream: {
    type: 'kill_stream',
    color: 'destructive',
    configFields: [
      {
        name: 'cooldown_minutes',
        labelKey: 'automations.configFields.cooldown_minutes.label',
        descriptionKey: 'automations.actions.kill_stream.fields.cooldown_minutes.description',
        type: 'number',
        min: 0,
        max: 1440,
        step: 5,
        unitKey: 'automations.units.minutes',
      },
      {
        name: 'delay_seconds',
        labelKey: 'automations.actions.kill_stream.fields.delay_seconds.label',
        descriptionKey: 'automations.actions.kill_stream.fields.delay_seconds.description',
        type: 'number',
        min: 0,
        max: 300,
        step: 5,
        unitKey: 'automations.units.seconds',
      },
      {
        name: 'target',
        labelKey: 'automations.configFields.target.label',
        descriptionKey: 'automations.actions.kill_stream.fields.target.description',
        type: 'select',
        optionSource: 'sessionTargets',
        fullWidth: true,
      },
      {
        name: 'message',
        labelKey: 'automations.configFields.message.label',
        placeholderKey: 'automations.actions.kill_stream.fields.message.placeholder',
        descriptionKey: 'automations.bind.helper.killMessage',
        type: 'text',
        fullWidth: true,
      },
    ],
  },

  message_client: {
    type: 'message_client',
    color: 'default',
    configFields: [
      {
        name: 'target',
        labelKey: 'automations.configFields.target.label',
        descriptionKey: 'automations.actions.message_client.fields.target.description',
        type: 'select',
        optionSource: 'sessionTargets',
        fullWidth: true,
      },
      {
        name: 'message',
        labelKey: 'automations.configFields.message.label',
        placeholderKey: 'automations.actions.message_client.fields.message.placeholder',
        descriptionKey: 'automations.bind.helper.clientMessage',
        type: 'text',
        required: true,
      },
    ],
  },
};

/** Run steps name their action as a plain string, including types this build never knew. */
export function storedActionLabel(t: Translate, action: string): string {
  if (action === 'if') return t('automations.catalog.actions.if.label');
  const known = (LEAF_ACTION_TYPES as readonly string[]).includes(action);
  return known ? actionLabel(t, action as LeafActionType) : action;
}

/** The same action in the past tense, for a row saying what a run did. */
export function ranActionLabel(t: Translate, action: string): string | undefined {
  if (!(LEAF_ACTION_TYPES as readonly string[]).includes(action)) return undefined;
  return t(`automations.actions.${action as LeafActionType}.ran`);
}

/** The parameter each trust mode carries; the schema rejects a mode with its sibling's parameter. */
export const TRUST_MODE_PARAMS: Record<TrustAction['mode'], Partial<TrustAction>> = {
  adjust: { amount: -10 },
  set: { value: 50 },
  reset: {},
};

/** Trust carries one parameter per mode, so a row shows only that mode's field. */
export function visibleConfigFields(action: LeafAction): ConfigField[] {
  const { configFields } = ACTION_DEFINITIONS[action.type];
  if (action.type !== 'trust') return configFields;
  const params = Object.keys(TRUST_MODE_PARAMS[action.mode]);
  return configFields.filter((field) => field.name === 'mode' || params.includes(field.name));
}

/** Switching trust mode swaps the parameter set wholesale; the node fields and cooldown survive. */
export function applyActionFieldChange(
  action: LeafAction,
  name: string,
  value: unknown
): LeafAction {
  if (action.type === 'trust' && name === 'mode') {
    const mode = value as TrustAction['mode'];
    const { id, enabled, cooldown_minutes } = action;
    const next: TrustAction = { type: 'trust', mode, ...TRUST_MODE_PARAMS[mode] };
    if (id !== undefined) next.id = id;
    if (enabled !== undefined) next.enabled = enabled;
    if (cooldown_minutes !== undefined) next.cooldown_minutes = cooldown_minutes;
    return next;
  }
  return { ...action, [name]: value };
}

/** Create a default action of a given type. */
export function createDefaultAction(type: LeafActionType): LeafAction {
  switch (type) {
    case 'send':
      return { type: 'send', to: [] };
    case 'trust':
      return { type: 'trust', mode: 'adjust', ...TRUST_MODE_PARAMS.adjust };
    case 'kill_stream':
      return { type: 'kill_stream' };
    case 'message_client':
      return { type: 'message_client', message: '' };
  }
}
