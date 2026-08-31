import { Fragment } from 'react';
import { useTranslation } from 'react-i18next';
import { Plus } from 'lucide-react';
import { contextOf, fieldsAvailableFor, type AutomationConditions } from '@tracearr/shared';
import { Button } from '@/components/ui/button';
import { FieldSeparator } from '@/components/ui/field';
import { Item, ItemContent, ItemActions } from '@/components/ui/item';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { idOf, nodeDomId, type BuilderDispatch } from './builderReducer';
import { ConditionGroupCard } from './ConditionGroupCard';
import { FlowStep } from './FlowStep';
import { RowIssues } from './RowActions';
import { BUILDER_SECTIONS, type NodeIssues } from './validation';
import type { BuilderRefs } from './builderRefs';

interface ConditionsSectionProps {
  conditions: AutomationConditions;
  refs: BuilderRefs;
  issues: NodeIssues;
  pulseId: string | null;
  dispatch: BuilderDispatch;
}

/** What has to hold before the automation goes ahead. */
export function ConditionsSection({
  conditions,
  refs,
  issues,
  pulseId,
  dispatch,
}: ConditionsSectionProps) {
  const { t } = useTranslation('pages');

  const { groups } = conditions;
  const hasFields = fieldsAvailableFor(contextOf(refs.triggers)).length > 0;
  const sectionIssues = issues.get(BUILDER_SECTIONS.conditions);
  // A second set puts its own add button in each card, so the step keeps one only while there is one set.
  const soleGroup = groups.length === 1 ? groups[0] : undefined;

  const addFirst = (
    <Button
      type="button"
      variant="outline"
      size="sm"
      disabled={!hasFields}
      onClick={() => dispatch({ type: 'addConditionGroup' })}
    >
      <Plus />
      {t('automations.builder.conditions.addFirst')}
    </Button>
  );

  return (
    <FlowStep
      step={2}
      title={t('automations.builder.conditions.sectionTitle')}
      optional={t('automations.builder.conditions.optional')}
      helper={t('automations.builder.conditions.helper')}
      id={nodeDomId(BUILDER_SECTIONS.conditions)}
    >
      {groups.length === 0 ? (
        <Item variant="outline" size="sm" className="bg-muted/20 border-dashed">
          <ItemContent>
            <p className="text-muted-foreground text-sm">
              {t('automations.builder.conditions.emptyLine')}
            </p>
          </ItemContent>
          <ItemActions>
            {hasFields ? (
              addFirst
            ) : (
              <Tooltip>
                <TooltipTrigger asChild>
                  <span className="inline-flex">{addFirst}</span>
                </TooltipTrigger>
                <TooltipContent>{t('automations.builder.conditions.noFields')}</TooltipContent>
              </Tooltip>
            )}
          </ItemActions>
        </Item>
      ) : (
        <>
          <div className="space-y-2">
            {groups.map((group, index) => (
              <Fragment key={idOf(group)}>
                {index > 0 && (
                  <FieldSeparator align="start" role="presentation">
                    {t('automations.builder.conditions.groupSeparator')}
                  </FieldSeparator>
                )}
                <ConditionGroupCard
                  group={group}
                  refs={refs}
                  issues={issues}
                  pulseId={pulseId}
                  bare={groups.length === 1}
                  dispatch={dispatch}
                />
              </Fragment>
            ))}
          </div>

          <div className="mt-3 flex flex-wrap items-center gap-3">
            {soleGroup && (
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => dispatch({ type: 'addCondition', groupId: idOf(soleGroup) })}
              >
                <Plus />
                {t('automations.builder.conditions.addFirst')}
              </Button>
            )}
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="text-muted-foreground"
              onClick={() => dispatch({ type: 'addConditionGroup' })}
            >
              <Plus />
              {t('automations.builder.conditions.addGroup')}
            </Button>
          </div>
        </>
      )}

      <RowIssues issues={sectionIssues} />
    </FlowStep>
  );
}
