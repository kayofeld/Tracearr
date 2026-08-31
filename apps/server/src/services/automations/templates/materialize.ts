/**
 * Turning a template version plus its bindings into an automation, and the name
 * an instance gets by default. One place, so every binding failure reads the same.
 */

import { eq } from 'drizzle-orm';
import { z } from 'zod';
import {
  AUTOMATION_NAME_MAX,
  TemplateBindingError,
  materializeTemplate,
  uuidSchema,
  type CreateAutomationInput,
  type TemplateDefinition,
  type TemplateInput,
} from '@tracearr/shared';
import { type Executor } from '../../../db/client.js';
import { servers } from '../../../db/schema.js';
import { firstIssueMessage } from '../../../utils/zod.js';

export interface TemplateVersionBody {
  inputs: TemplateInput[];
  definition: TemplateDefinition;
}

export type MaterializeResult =
  { ok: true; definition: CreateAutomationInput } | { ok: false; reason: string };

/**
 * Binding fails three ways: a key the version never declared, a required input
 * nothing named, or bound values the automation schema rejects. All three are the
 * caller's payload, never a server fault.
 */
export function materializeInstance(
  version: TemplateVersionBody,
  inputs: Record<string, unknown>,
  name: string
): MaterializeResult {
  const declared = new Set(version.inputs.map((input) => input.key));
  const unknown = Object.keys(inputs).filter((key) => !declared.has(key));
  if (unknown.length > 0) {
    return { ok: false, reason: `Unknown input(s): ${unknown.join(', ')}` };
  }
  try {
    return { ok: true, definition: materializeTemplate(version, inputs, { name }) };
  } catch (error) {
    if (error instanceof TemplateBindingError) {
      return { ok: false, reason: `Unbound required input(s): ${error.missing.join(', ')}` };
    }
    if (error instanceof z.ZodError) return { ok: false, reason: firstIssueMessage(error) };
    throw error;
  }
}

/**
 * The displayed default names the server the instance is pinned to; exports never
 * carry it. The template's own name survives the cap and the server part is trimmed.
 */
export async function defaultInstanceName(
  executor: Executor,
  templateName: string,
  version: TemplateVersionBody,
  inputs: Record<string, unknown>
): Promise<string> {
  const key = version.inputs.find((input) => input.kind === 'server')?.key;
  const bound = key === undefined ? undefined : inputs[key];
  const name = templateName.slice(0, AUTOMATION_NAME_MAX);
  // The binding is whatever the caller sent; the column would reject a non-uuid at the driver.
  const serverId = uuidSchema.safeParse(bound);
  if (!serverId.success) return name;

  const rows = await executor
    .select({ name: servers.name })
    .from(servers)
    .where(eq(servers.id, serverId.data));
  const server = rows[0];
  return server ? `${name} — ${server.name}`.slice(0, AUTOMATION_NAME_MAX) : name;
}
