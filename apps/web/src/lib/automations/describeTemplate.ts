/**
 * A template's sentence, with whatever the reader has bound so far filled in. The
 * gallery card, the binding form and the import review all read from here.
 */

import { CONDITION_FIELDS, slotValueFor } from '@tracearr/shared';
import type { PagesKey } from '@tracearr/translations';
import type {
  AutomationActions,
  AutomationConditions,
  AutomationKind,
  AutomationScopeRef,
  ConditionField,
  TemplateDefinition,
  TemplateInput,
  TriggerNode,
  UnitSystem,
  ViolationSeverity,
} from '@tracearr/shared';
import {
  describeAutomation,
  SENTENCE_SECTIONS,
  type DescribableDefinition,
  type DescribeFragment,
  type DescribeRefs,
} from './describe';
import type { Translate } from './conditionFields';

export interface TemplateVersionBody {
  inputs: TemplateInput[];
  definition: TemplateDefinition;
}

/** An optional input left unbound; the key it sits under drops out of the definition. */
const DROP = Symbol('unbound');

type TemplateTextKey = Extract<PagesKey, `automations.templates.${string}.${string}`>;

/**
 * The catalog ships copy for the templates it bundles; an import brings its own words.
 * An envelope's own text is never handed to i18next, which would resolve `$t(...)` in it.
 */
const NO_COPY = '\u0000tracearr.noCopy';

function templateText(t: Translate, slug: string, field: string, fallback: string): string {
  const copy = t(`automations.templates.${slug}.${field}` as TemplateTextKey, {
    defaultValue: NO_COPY,
  });
  return copy === NO_COPY ? fallback : copy;
}

export function templateName(t: Translate, template: { slug: string; name: string }): string {
  return templateText(t, template.slug, 'name', template.name);
}

export function templateDescription(
  t: Translate,
  template: { slug: string; description: string }
): string {
  return templateText(t, template.slug, 'description', template.description);
}

/** Words a reader might search for that the name and the sentence do not carry. */
export function templateKeywords(t: Translate, slug: string): string {
  return templateText(t, slug, 'keywords', '');
}

/** The four kinds the app words better than a bare envelope label does. */
function kindLabel(t: Translate, kind: TemplateInput['kind']): string | undefined {
  switch (kind) {
    case 'server':
      return t('automations.bind.serverLabel');
    case 'account':
      return t('automations.bind.accountLabel');
    case 'person':
      return t('automations.bind.personLabel');
    case 'destinations':
      return t('automations.bind.destinationsLabel');
    default:
      return undefined;
  }
}

/** What a field row and the sentence's placeholder both call an input. */
export function templateInputLabel(t: Translate, input: TemplateInput): string {
  const bare = input.label.trim().toLowerCase() === input.kind;
  return (bare ? kindLabel(t, input.kind) : undefined) ?? input.label;
}

/** A pick that holds nothing reads as unbound, so the sentence keeps naming the input. */
export const isUnbound = (value: unknown): boolean =>
  value === undefined || value === '' || (Array.isArray(value) && value.length === 0);

function placeholderKey(node: unknown): string | undefined {
  if (node === null || typeof node !== 'object' || !('$input' in node)) return undefined;
  const { $input: key } = node;
  return typeof key === 'string' ? key : undefined;
}

/** A slot that sits outside any node the sentence can address. */
const NO_NODE = '';

/** Which inputs wrote each node, so a field can light the clause its answer landed in. */
type NodeInputKeys = ReadonlyMap<string, readonly string[]>;

interface BoundDefinition {
  definition: DescribableDefinition;
  inputsByNode: NodeInputKeys;
}

/** A node id, or the section a scope slot belongs to since scope carries no id. */
function nodeIdOf(node: object, current: string): string {
  const { id } = node as { id?: unknown };
  return typeof id === 'string' ? id : current;
}

/** Inputs answered with a list, whose slot keeps an empty one rather than losing the key. */
function holdsList(input: TemplateInput): boolean {
  switch (input.kind) {
    case 'destinations':
      return true;
    case 'select':
      return input.multiple === true;
    case 'field_value':
      return CONDITION_FIELDS[input.field].valueType === 'multiSelect';
    default:
      return false;
  }
}

/**
 * The definition with bound values and defaults substituted. `placeholders` keeps an
 * unbound required input naming itself, which the sentence wants and a draft does not.
 */
function bindDefinition(
  version: TemplateVersionBody,
  bound: Record<string, unknown>,
  options: { placeholders?: boolean } = {}
): BoundDefinition {
  const placeholders = options.placeholders ?? true;
  const resolved = new Map<string, { input: TemplateInput; value: unknown }>();
  for (const input of version.inputs) {
    const value = isUnbound(bound[input.key])
      ? 'default' in input
        ? input.default
        : undefined
      : bound[input.key];
    if (!isUnbound(value)) resolved.set(input.key, { input, value });
  }

  const inputsByNode = new Map<string, string[]>();
  const record = (nodeId: string, key: string) => {
    const keys = inputsByNode.get(nodeId);
    if (keys) keys.push(key);
    else inputsByNode.set(nodeId, [key]);
  };

  const substitute = (node: unknown, slot: string, nodeId: string): unknown => {
    const key = placeholderKey(node);
    if (key !== undefined) {
      const binding = resolved.get(key);
      if (binding) {
        record(nodeId, key);
        return slotValueFor(binding.input, binding.value, slot);
      }
      const input = version.inputs.find((entry) => entry.key === key);
      if (!input?.required) return DROP;
      if (!placeholders) return holdsList(input) ? [] : DROP;
      record(nodeId, key);
      return node;
    }
    if (Array.isArray(node)) {
      return node.map((item) => substitute(item, slot, nodeId)).filter((item) => item !== DROP);
    }
    if (node !== null && typeof node === 'object') {
      const own = nodeIdOf(node, nodeId);
      const out: Record<string, unknown> = {};
      for (const [childKey, child] of Object.entries(node as Record<string, unknown>)) {
        const value = substitute(child, childKey, own);
        if (value !== DROP) out[childKey] = value;
      }
      return out;
    }
    return node;
  };

  const { definition } = version;
  const scope: DescribableDefinition['scope'] = {};
  for (const [key, value] of Object.entries(definition.scope)) {
    const bindingValue = substitute(value, key, SENTENCE_SECTIONS.scope);
    if (bindingValue !== DROP && bindingValue !== undefined) {
      Object.assign(scope, { [key]: bindingValue });
    }
  }

  return {
    definition: {
      kind: definition.kind,
      triggers: substitute(
        definition.triggers,
        'triggers',
        NO_NODE
      ) as DescribableDefinition['triggers'],
      conditions: substitute(
        definition.conditions,
        'conditions',
        NO_NODE
      ) as DescribableDefinition['conditions'],
      actions: substitute(
        definition.actions,
        'actions',
        NO_NODE
      ) as DescribableDefinition['actions'],
      scope,
    },
    inputsByNode,
  };
}

/**
 * What the builder opens on before anything is saved. A stored `Automation` satisfies
 * it, so one seeding path serves both.
 */
export interface AutomationDraft {
  name: string;
  description: string | null;
  kind: AutomationKind;
  severity: ViolationSeverity | null;
  isActive: boolean;
  triggers: TriggerNode[];
  conditions: AutomationConditions;
  actions: AutomationActions;
  serverId: string | null;
  serverUserId: string | null;
  userId: string | null;
  scopeRef?: AutomationScopeRef | null;
  enforceAcrossServers: boolean;
}

/**
 * The template as a row the builder can edit. A slot nothing answered drops out, unless it
 * holds a list, which lands empty for the builder's own validation to flag.
 */
export function templateDraft(
  version: TemplateVersionBody,
  bound: Record<string, unknown>,
  options: { name: string; isActive: boolean }
): AutomationDraft {
  const { definition } = bindDefinition(version, bound, { placeholders: false });
  const scope = definition.scope ?? {};
  // Nothing unresolved survives the bind, so the remaining values are the stored kinds.
  const scopeId = (value: unknown) => (typeof value === 'string' ? value : null);

  return {
    name: options.name,
    description: null,
    kind: version.definition.kind,
    severity: version.definition.severity ?? null,
    isActive: options.isActive,
    triggers: (definition.triggers ?? []) as TriggerNode[],
    conditions: (definition.conditions ?? { groups: [] }) as AutomationConditions,
    actions: (definition.actions ?? { actions: [] }) as AutomationActions,
    serverId: scopeId(scope.serverId),
    serverUserId: scopeId(scope.serverUserId),
    userId: scopeId(scope.userId),
    enforceAcrossServers: version.definition.enforceAcrossServers ?? false,
  };
}

/** The two message slots the app words for the reader when the envelope stays quiet. */
export type MessageSlot = 'killMessage' | 'clientMessage';

const MESSAGE_SLOTS: Record<string, MessageSlot> = {
  kill_stream: 'killMessage',
  message_client: 'clientMessage',
};

/**
 * The message slot an input fills, so a viewer message says when the viewer sees it.
 * Nothing in the sentence names either one.
 */
export function messageSlotForInput(
  definition: TemplateDefinition,
  key: string
): MessageSlot | undefined {
  const walk = (actions: TemplateDefinition['actions']['actions']): MessageSlot | undefined => {
    for (const action of actions) {
      if (action.type === 'if') {
        const nested = walk([...action.then, ...action.else]);
        if (nested) return nested;
        continue;
      }
      const slot = MESSAGE_SLOTS[action.type];
      if (slot && 'message' in action && placeholderKey(action.message) === key) return slot;
    }
    return undefined;
  };

  return walk(definition.actions.actions);
}

/**
 * The condition field an input's value lands in, so a number is edited and shown the
 * way the builder edits and shows that same condition.
 */
export function conditionFieldForInput(
  definition: TemplateDefinition,
  key: string
): ConditionField | undefined {
  const inGroups = (conditions: TemplateDefinition['conditions']): ConditionField | undefined => {
    for (const group of conditions.groups) {
      for (const condition of group.conditions) {
        if (placeholderKey(condition.value) === key) return condition.field;
      }
    }
    return undefined;
  };

  const top = inGroups(definition.conditions);
  if (top) return top;
  for (const action of definition.actions.actions) {
    if (action.type !== 'if') continue;
    const nested = inGroups(action.conditions);
    if (nested) return nested;
  }
  return undefined;
}

/** The template in words, in the reader's units, with the parts they have filled in. */
export function describeTemplate(
  version: TemplateVersionBody,
  bound: Record<string, unknown>,
  refs: DescribeRefs,
  t: Translate,
  unitSystem: UnitSystem
): DescribeFragment[] {
  const { definition, inputsByNode } = bindDefinition(version, bound);
  const fragments = describeAutomation(definition, refs, t, unitSystem, {
    inputKinds: Object.fromEntries(version.inputs.map((input) => [input.key, input.kind])),
  });

  return fragments.map((fragment) => {
    const keys = fragment.nodeId === null ? undefined : inputsByNode.get(fragment.nodeId);
    return keys ? { ...fragment, inputKeys: keys } : fragment;
  });
}
