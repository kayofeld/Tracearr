import { automationsLogger } from '../../../utils/logger.js';
import type {
  DispatchOptions,
  DispatchResult,
  EvaluationInputs,
  RuleEvent,
  Subscriber,
  SubscriberOutcome,
  TriggerType,
} from './types.js';
import type { ActionResult } from '../executors/index.js';
import type { ViolationInsertResult } from '../../../jobs/poller/violations.js';

interface Registration {
  name: string;
  handler: Subscriber<TriggerType>;
}

const registry = new Map<TriggerType, Registration[]>();

export function subscribe<T extends TriggerType>(
  type: T,
  name: string,
  handler: Subscriber<T>
): void {
  const list = registry.get(type) ?? [];
  list.push({ name, handler });
  registry.set(type, list);
}

export function resetDispatcherForTests(): void {
  registry.clear();
}

function subjectOf(event: RuleEvent): string {
  if ('session' in event && event.session) return event.session.id;
  if ('sessionId' in event) return event.sessionId;
  if ('serverUser' in event) return event.serverUser.id;
  if ('media' in event) return `media:${event.media.libraryItemId}`;
  if ('server' in event) return `server:${event.server.id}`;
  return 'install';
}

/**
 * Synchronous, in-order fan-out. Without opts.tx a throwing subscriber is
 * recorded and the rest still run; with opts.tx it propagates so the caller's
 * transaction (and its serialization retry) sees it.
 */
export async function dispatch(
  event: RuleEvent,
  inputs?: EvaluationInputs,
  opts: DispatchOptions = {}
): Promise<DispatchResult> {
  const violations: ViolationInsertResult[] = [];
  const outcomes: SubscriberOutcome[] = [];
  const deferred: Array<() => Promise<ActionResult[]>> = [];

  for (const { name, handler } of registry.get(event.type) ?? []) {
    try {
      const result = await handler(event, inputs, opts);
      if (result) {
        violations.push(...result.violations);
        if (result.deferredActions) deferred.push(result.deferredActions);
      }
      outcomes.push({ subscriber: name, ok: true });
    } catch (error) {
      if (opts.tx) throw error;
      automationsLogger.error('Rule subscriber failed', {
        trigger: event.type,
        subscriber: name,
        subject: subjectOf(event),
        error,
      });
      outcomes.push({ subscriber: name, ok: false, error });
    }
  }

  const result: DispatchResult = { violations, outcomes };
  if (deferred.length > 0) {
    result.deferredActions = async () => {
      const all: ActionResult[] = [];
      for (const run of deferred) all.push(...(await run()));
      return all;
    };
  }
  return result;
}
