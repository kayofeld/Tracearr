import { z } from 'zod';
import { nodeFieldsShape, automationConditionsSchema } from './conditions.js';
import { type TriggerContext } from './triggers.js';

export const sendActionSchema = z.object({
  ...nodeFieldsShape,
  type: z.literal('send'),
  to: z.array(z.uuid()).min(1),
  cooldown_minutes: z.number().int().nonnegative().optional(),
  title: z.string().min(1).max(200).optional(),
  body: z.string().min(1).max(2000).optional(),
});

export const trustActionSchema = z
  .object({
    ...nodeFieldsShape,
    type: z.literal('trust'),
    mode: z.enum(['adjust', 'set', 'reset']),
    amount: z.number().int().min(-100).max(100).optional(),
    value: z.number().int().min(0).max(100).optional(),
    cooldown_minutes: z.number().int().nonnegative().optional(),
  })
  .superRefine((action, ctx) => {
    if (action.mode === 'adjust' && action.amount === undefined) {
      ctx.addIssue({ code: 'custom', message: 'adjust needs an amount' });
    }
    if (action.mode === 'set' && action.value === undefined) {
      ctx.addIssue({ code: 'custom', message: 'set needs a value' });
    }
    if (action.mode === 'adjust' && action.value !== undefined) {
      ctx.addIssue({ code: 'custom', message: 'adjust takes an amount, not a value' });
    }
    if (action.mode === 'set' && action.amount !== undefined) {
      ctx.addIssue({ code: 'custom', message: 'set takes a value, not an amount' });
    }
    if (action.mode === 'reset' && (action.amount !== undefined || action.value !== undefined)) {
      ctx.addIssue({ code: 'custom', message: 'reset takes no parameter' });
    }
  });

export const sessionTargetSchema = z.enum([
  'triggering',
  'oldest',
  'newest',
  'all_except_one',
  'all_user',
]);

export type SessionTarget = z.infer<typeof sessionTargetSchema>;

export const killStreamActionSchema = z.object({
  ...nodeFieldsShape,
  type: z.literal('kill_stream'),
  /** Seconds to wait before killing. The kill only fires if the rule condition still holds after the wait; 0 (default) still re-checks once before killing. */
  delay_seconds: z.number().int().min(0).max(300).optional(),
  cooldown_minutes: z.number().int().nonnegative().optional(),
  /** Message to display to user before termination. If omitted, terminates silently. */
  message: z.string().min(1).max(500).optional(),
  target: sessionTargetSchema.optional(),
});

export const messageClientActionSchema = z.object({
  ...nodeFieldsShape,
  type: z.literal('message_client'),
  message: z.string().min(1).max(500),
  target: sessionTargetSchema.optional(),
});

/** Everything an `if` branch may hold: the effects, with no further branching. */
export const leafActionSchema = z.discriminatedUnion('type', [
  sendActionSchema,
  trustActionSchema,
  killStreamActionSchema,
  messageClientActionSchema,
]);

export const ifActionSchema = z.strictObject({
  ...nodeFieldsShape,
  type: z.literal('if'),
  conditions: automationConditionsSchema,
  then: z.array(leafActionSchema),
  else: z.array(leafActionSchema),
});

// Union of all actions
export const actionSchema = z.discriminatedUnion('type', [
  sendActionSchema,
  trustActionSchema,
  killStreamActionSchema,
  messageClientActionSchema,
  ifActionSchema,
]);

// Rule actions container (actions are optional side-effects; violations are always auto-created)
export const automationActionsSchema = z.object({
  actions: z.array(actionSchema),
});

export const LEAF_ACTION_TYPES = ['send', 'trust', 'kill_stream', 'message_client'] as const;
export const ACTION_TYPES = [...LEAF_ACTION_TYPES, 'if'] as const;
export const actionTypeSchema = z.enum(ACTION_TYPES);

export const ACTIONS = {
  send: { group: 'notify', requires: 'install' },
  trust: { group: 'policy', requires: 'account' },
  kill_stream: { group: 'policy', requires: 'session' },
  message_client: { group: 'policy', requires: 'session' },
  if: { group: 'control', requires: 'install' },
} as const satisfies Record<
  (typeof ACTION_TYPES)[number],
  { group: 'notify' | 'policy' | 'control'; requires: TriggerContext }
>;

export type LeafActionType = (typeof LEAF_ACTION_TYPES)[number];
export type ActionType = z.infer<typeof actionTypeSchema>;
export type SendAction = z.infer<typeof sendActionSchema>;
export type TrustAction = z.infer<typeof trustActionSchema>;
export type KillStreamAction = z.infer<typeof killStreamActionSchema>;
export type MessageClientAction = z.infer<typeof messageClientActionSchema>;
export type LeafAction = z.infer<typeof leafActionSchema>;
export type IfAction = z.infer<typeof ifActionSchema>;
export type Action = z.infer<typeof actionSchema>;
export type AutomationActions = z.infer<typeof automationActionsSchema>;
