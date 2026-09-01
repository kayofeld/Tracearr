import { Fragment, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { Plus, X } from 'lucide-react';
import type { ConditionGroup, ConditionMatch } from '@tracearr/shared';
import { Button } from '@/components/ui/button';
import { ItemGroup } from '@/components/ui/item';
import { idOf, type BuilderDispatch } from './builderReducer';
import { ConditionRow } from './ConditionRow';
import { ConnectiveSelect } from './ConnectiveSelect';
import { useRowKeyboard } from './useRowKeyboard';
import type { BuilderRefs } from './builderRefs';
import type { NodeIssues } from './validation';

interface ConditionGroupCardProps {
  group: ConditionGroup;
  refs: BuilderRefs;
  issues: NodeIssues;
  pulseId: string | null;
  /** The lines on their own: no card, no remove, and the caller offers the add button. */
  bare?: boolean;
  dispatch: BuilderDispatch;
}

/** Checks that stand or fall together, joined by the word between them. */
export function ConditionGroupCard({
  group,
  refs,
  issues,
  pulseId,
  bare = false,
  dispatch,
}: ConditionGroupCardProps) {
  const { t } = useTranslation('pages');
  const cardRef = useRef<HTMLDivElement>(null);
  const groupId = idOf(group);
  // A group saved before `match` existed matches any of its conditions.
  const match: ConditionMatch = group.match ?? 'any';

  const rows = useRowKeyboard({
    ids: group.conditions.map(idOf),
    sectionRef: cardRef,
    onToggle: (id) => dispatch({ type: 'toggleNode', id }),
    onRemove: (id, index) => {
      dispatch({ type: 'removeNode', id });
      rows.reclaim(index);
    },
  });

  const lines = (
    <ItemGroup className="gap-2">
      {group.conditions.map((condition, index) => (
        <Fragment key={idOf(condition)}>
          {index > 0 && (
            <ConnectiveSelect
              match={match}
              onChange={(next) => dispatch({ type: 'setConditionMatch', groupId, match: next })}
            />
          )}
          <ConditionRow
            condition={condition}
            refs={refs}
            issues={issues.get(idOf(condition))}
            pulsing={pulseId === idOf(condition)}
            rowProps={rows.rowProps(index)}
            dispatch={dispatch}
          />
        </Fragment>
      ))}
    </ItemGroup>
  );

  if (bare) {
    return <div ref={cardRef}>{lines}</div>;
  }

  return (
    <div ref={cardRef} className="@container space-y-2 rounded-lg border p-3">
      <div className="flex justify-end">
        <Button
          type="button"
          variant="ghost"
          size="icon"
          aria-label={t('automations.builder.conditions.removeGroup')}
          onClick={() => dispatch({ type: 'removeNode', id: groupId })}
        >
          <X />
        </Button>
      </div>

      {lines}

      <Button
        type="button"
        variant="ghost"
        size="sm"
        className="text-muted-foreground"
        onClick={() => dispatch({ type: 'addCondition', groupId })}
      >
        <Plus />
        {t('automations.builder.conditions.addAnother')}
      </Button>
    </div>
  );
}
