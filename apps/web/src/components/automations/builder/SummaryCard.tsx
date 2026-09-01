import { AutomationIdentityFields } from '@/components/automations/AutomationIdentityFields';
import { nodeDomId, type BuilderDispatch } from './builderReducer';
import { RowIssues } from './RowActions';
import { SentencePanel } from './SentencePanel';
import { BUILDER_SECTIONS, type NodeIssues } from './validation';
import type { ReactNode } from 'react';

interface SummaryCardProps {
  name: string;
  description: string;
  issues: NodeIssues;
  /** The automation in words, built by the page so every clause can reach its row. */
  sentence: ReactNode;
  liveCheck: ReactNode;
  dispatch: BuilderDispatch;
}

/** What the automation is called, what it says, and what it would do right now. */
export function SummaryCard({
  name,
  description,
  issues,
  sentence,
  liveCheck,
  dispatch,
}: SummaryCardProps) {
  const nameIssues = issues.get(BUILDER_SECTIONS.name);
  const noteIssues = issues.get(BUILDER_SECTIONS.description);

  return (
    <AutomationIdentityFields
      name={name}
      onNameChange={(value) => dispatch({ type: 'setName', value })}
      description={description}
      onDescriptionChange={(value) => dispatch({ type: 'setDescription', value })}
      // The anchors are the inputs themselves, so jumping to a problem lands in one.
      nameId={nodeDomId(BUILDER_SECTIONS.name)}
      descriptionId={nodeDomId(BUILDER_SECTIONS.description)}
      nameInvalid={nameIssues !== undefined}
      descriptionInvalid={noteIssues !== undefined}
      nameError={<RowIssues issues={nameIssues} />}
      descriptionError={<RowIssues issues={noteIssues} />}
    >
      <SentencePanel>{sentence}</SentencePanel>

      {liveCheck}
    </AutomationIdentityFields>
  );
}
