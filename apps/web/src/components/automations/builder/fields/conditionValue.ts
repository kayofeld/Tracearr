/** The control a condition's value is edited with, and the unit it is shown in. */

import {
  formatConditionFieldValue,
  fromMetricDistance,
  toMetricDistance,
  type AutomationFilterOptions,
  type Condition,
  type ConditionField,
  type ConditionFieldDescriptor,
  type UnitSystem,
} from '@tracearr/shared';
import {
  fieldDescriptor,
  fieldOptions,
  fieldPlaceholder,
  isArrayOperator,
  unitLabel,
  type Translate,
} from '@/lib/automations';
import type { MultiSelectOption } from '@/components/ui/multi-select';
import type { ControlSpec, ControlValue } from './FieldControl';

export interface ConditionValueContext {
  filterOptions: AutomationFilterOptions | undefined;
  unitSystem: UnitSystem;
}

export interface ConditionValueView {
  spec: ControlSpec;
  /** What the control shows, which is not what is stored once units differ. */
  value: ControlValue | undefined;
  toStored: (next: ControlValue) => Condition['value'];
}

function dynamicOptions(
  t: Translate,
  field: ConditionField,
  filterOptions: AutomationFilterOptions | undefined
): MultiSelectOption[] | undefined {
  if (!filterOptions) return undefined;

  switch (fieldDescriptor(field)?.dynamicSource) {
    case 'countries':
      return filterOptions.countries?.map((country) => ({
        value: country.code,
        label: country.name,
        group: country.hasSessions
          ? t('automations.builder.conditions.recentlySeen')
          : t('automations.builder.conditions.allCountries'),
      }));
    case 'servers':
      return filterOptions.servers?.map((server) => ({ value: server.id, label: server.name }));
    case 'users':
      return filterOptions.users?.map((user) => ({
        value: user.id,
        label: user.identityName || user.username,
      }));
    default:
      return undefined;
  }
}

function buildSpec(
  t: Translate,
  field: ConditionField,
  descriptor: ConditionFieldDescriptor,
  ctx: { isArray: boolean; filterOptions: AutomationFilterOptions | undefined; unit?: string }
): ControlSpec {
  const placeholder = fieldPlaceholder(t, field);

  switch (descriptor.valueType) {
    case 'boolean':
      return { kind: 'boolean' };
    case 'select':
    case 'multiSelect': {
      const options = dynamicOptions(t, field, ctx.filterOptions) ?? fieldOptions(t, field);
      return { kind: ctx.isArray ? 'multiSelect' : 'select', options, placeholder };
    }
    case 'number':
      return {
        kind: 'number',
        min: descriptor.min,
        max: descriptor.max,
        step: descriptor.step,
        unit: ctx.unit ?? (descriptor.unit && unitLabel(t, descriptor.unit)),
      };
    default:
      return { kind: 'text', placeholder };
  }
}

/** Distances are stored metric; the control shows whichever system the reader set. */
export function conditionValueView(
  t: Translate,
  condition: Condition,
  descriptor: ConditionFieldDescriptor,
  ctx: ConditionValueContext
): ConditionValueView {
  const isArray = isArrayOperator(condition.operator);
  const converted =
    descriptor.valueType === 'number' && typeof condition.value === 'number'
      ? formatConditionFieldValue(condition.value, condition.field, ctx.unitSystem)
      : undefined;

  if (!converted?.unit) {
    return {
      spec: buildSpec(t, condition.field, descriptor, {
        isArray,
        filterOptions: ctx.filterOptions,
      }),
      value: condition.value,
      toStored: (next) => next,
    };
  }

  return {
    spec: buildSpec(t, condition.field, descriptor, {
      isArray,
      filterOptions: ctx.filterOptions,
      unit: converted.unit,
    }),
    value: Math.round(fromMetricDistance(Number(condition.value), ctx.unitSystem)),
    toStored: (next) =>
      typeof next === 'number' ? Math.round(toMetricDistance(next, ctx.unitSystem)) : next,
  };
}
