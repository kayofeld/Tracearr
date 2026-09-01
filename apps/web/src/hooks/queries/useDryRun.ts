import { useEffect, useRef } from 'react';
import { useMutation } from '@tanstack/react-query';
import type { CreateAutomationInput } from '@tracearr/shared';
import { api } from '@/lib/api';

/** How long the draft has to settle before the server is asked about it again. */
const DEBOUNCE_MS = 400;

interface DryRunOptions {
  /** False while the draft is unfinished or a save is in flight. */
  enabled: boolean;
  /** One session to check against, replacing the ones playing now. */
  sampleSessionId?: string;
}

/**
 * What the draft would do against the sessions playing now, re-asked as it settles.
 * A mutation rather than a query: the definition is the request body, and nothing
 * about the answer is worth keeping once the draft moves on.
 */
export function useDryRun(
  definition: CreateAutomationInput,
  { enabled, sampleSessionId }: DryRunOptions
) {
  const check = useMutation({
    mutationFn: (input: CreateAutomationInput) =>
      api.automations.dryRun({
        definition: input,
        ...(sampleSessionId ? { sample: { sessionId: sampleSessionId } } : {}),
      }),
  });

  const { mutate, reset } = check;

  // A disabled check has nothing true left to show, so its last answer goes with it.
  useEffect(() => {
    if (!enabled) reset();
  }, [enabled, reset]);

  const latest = useRef(definition);
  useEffect(() => {
    latest.current = definition;
  }, [definition]);

  // The body is the whole definition, so its contents are what a re-check waits on.
  const key = JSON.stringify(definition);

  useEffect(() => {
    if (!enabled) return;
    const timer = window.setTimeout(() => mutate(latest.current), DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [key, enabled, sampleSessionId, mutate]);

  return check;
}
