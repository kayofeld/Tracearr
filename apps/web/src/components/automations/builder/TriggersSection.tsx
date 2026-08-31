import { Fragment, useMemo, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { Play } from 'lucide-react';
import { TRIGGERS, type TriggerNode, type TriggerType } from '@tracearr/shared';
import { FieldSeparator } from '@/components/ui/field';
import { ItemGroup } from '@/components/ui/item';
import { Kbd } from '@/components/ui/kbd';
import { suggestedValues, triggerPickerEntries, type AutomationScope } from '@/lib/automations';
import { nodeDomId, type BuilderDispatch } from './builderReducer';
import { FlowStep } from './FlowStep';
import { NodePicker } from './NodePicker';
import { RowIssues } from './RowActions';
import { ScopeField } from './ScopeField';
import { SectionEmpty } from './SectionEmpty';
import { TriggerRow } from './TriggerRow';
import { useRowKeyboard } from './useRowKeyboard';
import { BUILDER_SECTIONS, type NodeIssues } from './validation';

interface TriggersSectionProps {
  triggers: readonly TriggerNode[];
  scope: AutomationScope;
  enforceAcrossServers: boolean;
  canEnforceAcrossServers: boolean;
  issues: NodeIssues;
  pulseId: string | null;
  dispatch: BuilderDispatch;
}

function isTriggerType(value: string): value is TriggerType {
  return value in TRIGGERS;
}

export function TriggersSection({
  triggers,
  scope,
  enforceAcrossServers,
  canEnforceAcrossServers,
  issues,
  pulseId,
  dispatch,
}: TriggersSectionProps) {
  const { t } = useTranslation('pages');
  const sectionRef = useRef<HTMLElement>(null);

  const entries = useMemo(() => triggerPickerEntries(t), [t]);
  const suggested = useMemo(
    () =>
      suggestedValues(
        entries,
        triggers.map((trigger) => trigger.type)
      ),
    [entries, triggers]
  );

  const rows = useRowKeyboard({
    ids: triggers.map((trigger) => trigger.id),
    sectionRef,
    onToggle: (id) => dispatch({ type: 'toggleNode', id }),
    onRemove: (id, index) => {
      dispatch({ type: 'removeNode', id });
      rows.reclaim(index);
    },
  });

  const sectionIssues = issues.get(BUILDER_SECTIONS.triggers);
  const scopeIssues = issues.get(BUILDER_SECTIONS.scope);

  const addTrigger = (value: string) => {
    if (isTriggerType(value)) dispatch({ type: 'addTrigger', triggerType: value });
  };

  return (
    <FlowStep
      step={1}
      title={t('automations.builder.when.title')}
      helper={t('automations.builder.when.helper')}
      id={nodeDomId(BUILDER_SECTIONS.triggers)}
      sectionRef={sectionRef}
      footer={
        // A scope problem points here, so the field outlives an emptied trigger list.
        (triggers.length > 0 || scopeIssues !== undefined) && (
          <div id={nodeDomId(BUILDER_SECTIONS.scope)} tabIndex={-1} className="outline-none">
            <ScopeField
              scope={scope}
              onChange={(value) => dispatch({ type: 'setScope', value })}
              enforceAcrossServers={enforceAcrossServers}
              onEnforceAcrossServersChange={(value) =>
                dispatch({ type: 'setEnforceAcrossServers', value })
              }
              canEnforceAcrossServers={canEnforceAcrossServers}
              showErrors={scopeIssues !== undefined}
            />
          </div>
        )
      }
    >
      {triggers.length === 0 ? (
        <SectionEmpty
          icon={<Play />}
          title={t('automations.builder.when.emptyTitle')}
          description={t('automations.builder.when.emptyDescription')}
          action={
            <NodePicker
              primary
              entries={entries}
              suggested={suggested}
              label={t('automations.builder.when.emptyAction')}
              onSelect={addTrigger}
            />
          }
        />
      ) : (
        <ItemGroup className="gap-2">
          {triggers.map((trigger, index) => (
            <Fragment key={trigger.id}>
              {index > 0 && (
                <FieldSeparator align="start" role="presentation">
                  {t('automations.builder.when.or')}
                </FieldSeparator>
              )}
              <TriggerRow
                trigger={trigger}
                issues={issues.get(trigger.id)}
                pulsing={pulseId === trigger.id}
                rowProps={rows.rowProps(index)}
                dispatch={dispatch}
              />
            </Fragment>
          ))}
        </ItemGroup>
      )}

      <RowIssues issues={sectionIssues} />

      {triggers.length > 0 && (
        <div className="mt-3 flex flex-wrap items-center gap-3">
          <NodePicker
            entries={entries}
            suggested={suggested}
            label={t('automations.builder.when.add')}
            onSelect={addTrigger}
          />
          <span className="text-muted-foreground ml-auto flex items-center gap-3 text-xs">
            <span className="flex items-center gap-1">
              <Kbd>D</Kbd>
              {t('automations.builder.rows.toggleHint')}
            </span>
            <span className="flex items-center gap-1 @max-lg:hidden">
              <Kbd>Del</Kbd>
              {t('automations.builder.rows.removeHint')}
            </span>
          </span>
        </div>
      )}
    </FlowStep>
  );
}
