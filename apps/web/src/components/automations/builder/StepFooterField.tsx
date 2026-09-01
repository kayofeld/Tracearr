import type { ReactNode } from 'react';
import { Separator } from '@/components/ui/separator';

interface StepFooterFieldProps {
  /** The control names itself with this, so the question is asked once. */
  labelId: string;
  label: string;
  control: ReactNode;
  /** What the answer asks for next, on its own lines. */
  children?: ReactNode;
}

/** The setting that closes a step: a hairline, one question, and the control that answers it. */
export function StepFooterField({ labelId, label, control, children }: StepFooterFieldProps) {
  return (
    <div className="mt-4 space-y-3.5">
      <Separator />
      <div className="flex flex-wrap items-center gap-x-5 gap-y-2.5 @max-lg:flex-col @max-lg:items-stretch">
        <span id={labelId} className="text-sm font-medium">
          {label}
        </span>
        {control}
      </div>
      {children}
    </div>
  );
}
