import type { ReactNode } from 'react';
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from '@/components/ui/empty';

interface SectionEmptyProps {
  icon: ReactNode;
  title: string;
  description: string;
  /** The one obvious thing to do here, drawn as the step's primary action. */
  action: ReactNode;
}

/** A step with nothing in it yet, saying what belongs there and offering to fill it. */
export function SectionEmpty({ icon, title, description, action }: SectionEmptyProps) {
  return (
    <Empty className="bg-muted/20 gap-4 border border-dashed p-8 md:p-8">
      <EmptyHeader className="gap-1.5">
        <EmptyMedia variant="icon">{icon}</EmptyMedia>
        <EmptyTitle className="text-base">{title}</EmptyTitle>
        <EmptyDescription>{description}</EmptyDescription>
      </EmptyHeader>
      <EmptyContent>{action}</EmptyContent>
    </Empty>
  );
}
