import { cn } from '@/lib/utils';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';

export interface BooleanFieldProps {
  /** `true` or unset; `false` is normalised away so an inactive filter is
   *  always `undefined`. */
  value: boolean | undefined;
  onChange: (value: true | undefined) => void;
  label: string;
  id: string;
  className?: string;
}

export function BooleanField({ value, onChange, label, id, className }: BooleanFieldProps) {
  return (
    <div className={cn('flex items-center gap-2', className)}>
      <Switch
        id={id}
        checked={value === true}
        onCheckedChange={(checked) => onChange(checked ? true : undefined)}
      />
      <Label htmlFor={id} className="text-sm font-normal">
        {label}
      </Label>
    </div>
  );
}
