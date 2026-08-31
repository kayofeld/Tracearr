import { useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ArrowDown, ArrowUp, Bell, MoreHorizontal } from 'lucide-react';
import {
  ACTION_TYPES,
  type Action,
  type ActionType,
  type AutomationActions,
  type AutomationKind,
  type ViolationSeverity,
} from '@tracearr/shared';
import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { ItemGroup } from '@/components/ui/item';
import { Kbd } from '@/components/ui/kbd';
import { actionLabel, actionPickerEntries, suggestedValues } from '@/lib/automations';
import { idOf, nodeDomId, type BuilderDispatch } from './builderReducer';
import { ActionRow } from './ActionRow';
import { FlowStep } from './FlowStep';
import { IfRow } from './IfRow';
import { NodePicker } from './NodePicker';
import { RecordAsField } from './RecordAsField';
import { RowIssues } from './RowActions';
import { SectionEmpty } from './SectionEmpty';
import { useRowKeyboard } from './useRowKeyboard';
import { BUILDER_SECTIONS, type NodeIssues } from './validation';
import type { BranchExpansion, BuilderRefs } from './builderRefs';

interface ActionsSectionProps {
  actions: AutomationActions;
  kind: AutomationKind;
  severity: ViolationSeverity;
  refs: BuilderRefs;
  issues: NodeIssues;
  pulseId: string | null;
  expansion: BranchExpansion;
  dispatch: BuilderDispatch;
}

/** What a removal is waiting on: the node, and where the keyboard goes afterwards. */
interface PendingRemoval {
  id: string;
  reclaim: () => void;
}

function isActionType(value: string): value is ActionType {
  return (ACTION_TYPES as readonly string[]).includes(value);
}

function rowName(t: ReturnType<typeof useTranslation<'pages'>>['t'], action: Action): string {
  return action.type === 'if'
    ? t('automations.catalog.actions.if.label')
    : actionLabel(t, action.type);
}

/** What happens once the triggers fire and the conditions hold, in order. */
export function ActionsSection({
  actions,
  kind,
  severity,
  refs,
  issues,
  pulseId,
  expansion,
  dispatch,
}: ActionsSectionProps) {
  const { t } = useTranslation(['pages', 'common']);
  const sectionRef = useRef<HTMLElement>(null);
  const [pending, setPending] = useState<PendingRemoval | null>(null);

  const list = actions.actions;
  const entries = useMemo(() => actionPickerEntries(t), [t]);
  const suggested = useMemo(
    () =>
      suggestedValues(
        entries,
        list.map((action) => action.type)
      ),
    [entries, list]
  );

  const branches = new Set(list.filter((action) => action.type === 'if').map(idOf));

  const rows = useRowKeyboard({
    ids: list.map(idOf),
    sectionRef,
    onToggle: (id) => dispatch({ type: 'toggleNode', id }),
    onRemove: (id, index) => setPending({ id, reclaim: () => rows.reclaim(index) }),
    onMove: (id, delta) => dispatch({ type: 'moveAction', id, delta }),
    onExpand: expansion.toggle,
    canExpand: (id) => branches.has(id),
  });

  const sectionIssues = issues.get(BUILDER_SECTIONS.actions);

  const addAction = (value: string) => {
    if (isActionType(value)) dispatch({ type: 'addAction', actionType: value });
  };

  const menuFor = (action: Action, index: number) => (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          aria-label={t('pages:automations.builder.actions.menu', { name: rowName(t, action) })}
        >
          <MoreHorizontal />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuItem
          disabled={index === 0}
          onSelect={() => dispatch({ type: 'moveAction', id: idOf(action), delta: -1 })}
        >
          <ArrowUp />
          {t('pages:automations.builder.actions.moveUp', { name: rowName(t, action) })}
        </DropdownMenuItem>
        <DropdownMenuItem
          disabled={index === list.length - 1}
          onSelect={() => dispatch({ type: 'moveAction', id: idOf(action), delta: 1 })}
        >
          <ArrowDown />
          {t('pages:automations.builder.actions.moveDown', { name: rowName(t, action) })}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );

  return (
    <FlowStep
      step={3}
      title={t('pages:automations.builder.actions.sectionTitle')}
      helper={t('pages:automations.builder.actions.helper')}
      id={nodeDomId(BUILDER_SECTIONS.actions)}
      sectionRef={sectionRef}
      footer={
        list.length > 0 && <RecordAsField kind={kind} severity={severity} dispatch={dispatch} />
      }
    >
      {list.length === 0 ? (
        <SectionEmpty
          icon={<Bell />}
          title={t('pages:automations.builder.actions.emptyTitle')}
          description={t('pages:automations.builder.actions.emptyDescription')}
          action={
            <NodePicker
              primary
              entries={entries}
              suggested={suggested}
              label={t('pages:automations.builder.actions.emptyAction')}
              onSelect={addAction}
            />
          }
        />
      ) : (
        <ItemGroup className="gap-2">
          {list.map((action, index) =>
            action.type === 'if' ? (
              <IfRow
                key={idOf(action)}
                action={action}
                refs={refs}
                issues={issues}
                pulseId={pulseId}
                rowProps={rows.rowProps(index)}
                expansion={expansion}
                menu={menuFor(action, index)}
                onRemove={() =>
                  setPending({ id: idOf(action), reclaim: () => rows.reclaim(index) })
                }
                onRemoveBranchAction={(id, reclaim) => setPending({ id, reclaim })}
                dispatch={dispatch}
              />
            ) : (
              <ActionRow
                key={idOf(action)}
                action={action}
                issues={issues.get(idOf(action))}
                pulsing={pulseId === idOf(action)}
                rowProps={rows.rowProps(index)}
                menu={menuFor(action, index)}
                onRemove={() =>
                  setPending({ id: idOf(action), reclaim: () => rows.reclaim(index) })
                }
                dispatch={dispatch}
              />
            )
          )}
        </ItemGroup>
      )}

      <RowIssues issues={sectionIssues} />

      {list.length > 0 && (
        <div className="mt-3 flex flex-wrap items-center gap-3">
          <NodePicker
            entries={entries}
            suggested={suggested}
            label={t('pages:automations.builder.actions.add')}
            onSelect={addAction}
          />
          <span className="text-muted-foreground ml-auto flex flex-wrap items-center gap-3 text-xs">
            <span className="flex items-center gap-1">
              <Kbd>D</Kbd>
              {t('pages:automations.builder.rows.toggleHint')}
            </span>
            <span className="flex items-center gap-1 @max-lg:hidden">
              <Kbd>E</Kbd>
              {t('pages:automations.builder.rows.expandHint')}
            </span>
            <span className="flex items-center gap-1 @max-lg:hidden">
              <Kbd>Alt</Kbd>
              <Kbd>↑</Kbd>
              {t('pages:automations.builder.rows.moveHint')}
            </span>
            <span className="flex items-center gap-1 @max-lg:hidden">
              <Kbd>Del</Kbd>
              {t('pages:automations.builder.rows.removeHint')}
            </span>
          </span>
        </div>
      )}

      <ConfirmDialog
        open={pending !== null}
        onOpenChange={(open) => {
          if (!open) setPending(null);
        }}
        title={t('pages:automations.builder.actions.confirmRemoveTitle')}
        description={t('pages:automations.builder.actions.confirmRemoveDescription')}
        confirmLabel={t('common:actions.remove')}
        cancelLabel={t('common:actions.cancel')}
        onConfirm={() => {
          if (!pending) return;
          dispatch({ type: 'removeNode', id: pending.id });
          pending.reclaim();
          setPending(null);
        }}
      />
    </FlowStep>
  );
}
