/**
 * What a template will do to a person, read off its definition rather than off
 * whatever its author wrote about it.
 */

import { useTranslation } from 'react-i18next';
import {
  Bell,
  Flag,
  MessageSquare,
  Server,
  TrendingUp,
  XCircle,
  type LucideIcon,
} from 'lucide-react';
import type { TemplateDefinition } from '@tracearr/shared';
import { cn } from '@/lib/utils';

type TemplateAction = TemplateDefinition['actions']['actions'][number];

export type TemplateEffectId =
  | 'kill'
  | 'trust'
  | 'message'
  | 'violation'
  | 'tellsOnly'
  | 'allServers'
  | 'everyServer'
  | 'oneServer';

export interface TemplateEffectScope {
  /** The server the reader picked, if they picked one. */
  serverName?: string;
  /** Whether the template offers a server to pick at all. */
  hasServerInput: boolean;
}

const ACTION_LINES: Record<string, TemplateEffectId> = {
  kill_stream: 'kill',
  trust: 'trust',
  message_client: 'message',
};

const EFFECT_ICONS: Record<TemplateEffectId, LucideIcon> = {
  kill: XCircle,
  trust: TrendingUp,
  message: MessageSquare,
  violation: Flag,
  tellsOnly: Bell,
  allServers: Server,
  everyServer: Server,
  oneServer: Server,
};

/** The two lines that name harm take the warning colour, on the icon only. */
const HARM: readonly TemplateEffectId[] = ['kill', 'violation'];

/** An `if` hides its effects one level down, and they count the same as the rest. */
function actionLines(actions: readonly TemplateAction[], found: Set<TemplateEffectId>): void {
  for (const action of actions) {
    if (action.type === 'if') {
      actionLines(action.then, found);
      actionLines(action.else, found);
      continue;
    }
    const line = ACTION_LINES[action.type];
    if (line) found.add(line);
  }
}

/** The lines this template earns, in reading order, with the scope line always last. */
export function templateEffects(
  definition: TemplateDefinition,
  scope: TemplateEffectScope
): TemplateEffectId[] {
  const found = new Set<TemplateEffectId>();
  actionLines(definition.actions.actions, found);

  const lines: TemplateEffectId[] = (['kill', 'trust', 'message'] as const).filter((line) =>
    found.has(line)
  );
  if (definition.kind === 'policy') lines.push('violation');
  if (lines.length === 0) lines.push('tellsOnly');

  if (scope.serverName !== undefined) lines.push('oneServer');
  else lines.push(scope.hasServerInput ? 'allServers' : 'everyServer');

  return lines;
}

interface TemplateEffectsProps extends TemplateEffectScope {
  definition: TemplateDefinition;
}

/** The consequence block: one line per thing the reader is agreeing to. */
export function TemplateEffects({ definition, serverName, hasServerInput }: TemplateEffectsProps) {
  const { t } = useTranslation('pages');
  const lines = templateEffects(definition, { serverName, hasServerInput });

  // The surface is what marks these as statements rather than more helper text,
  // now that the block has no heading over it.
  return (
    <section
      aria-label={t('automations.effects.title')}
      className="bg-muted/25 rounded-lg px-3.5 py-3"
    >
      <ul className="flex flex-col gap-2">
        {lines.map((line) => {
          const Icon = EFFECT_ICONS[line];
          return (
            <li key={line} className="flex items-start gap-2 text-sm leading-snug">
              <Icon
                aria-hidden
                className={cn(
                  'text-muted-foreground mt-0.5 size-[0.9375rem] shrink-0',
                  HARM.includes(line) && 'text-warning'
                )}
              />
              {t(`automations.effects.${line}`, { server: serverName ?? '' })}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
