import { useTranslation } from 'react-i18next';
import { cn } from '@/lib/utils';
import { Input } from '@/components/ui/input';
import {
  INPUT_GROUP_CONTROL,
  INPUT_GROUP_UNIT,
  InputGroup,
  InputGroupAddon,
} from '@/components/ui/input-group';
import { NumericInput } from '@/components/ui/numeric-input';
import { Slider } from '@/components/ui/slider';
import { Switch } from '@/components/ui/switch';
import { MultiSelect, type MultiSelectOption } from '@/components/ui/multi-select';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';

export type ControlValue = string | number | boolean | string[] | number[];

export type ControlSpec =
  | { kind: 'number'; min?: number; max?: number; step?: number; unit?: string }
  | { kind: 'boolean' }
  | { kind: 'text'; placeholder?: string }
  | { kind: 'select'; options: MultiSelectOption[]; placeholder?: string }
  | { kind: 'multiSelect'; options: MultiSelectOption[]; placeholder?: string }
  | { kind: 'slider'; min: number; max: number; step: number };

interface FieldControlProps {
  spec: ControlSpec;
  value: ControlValue | undefined;
  onChange: (value: ControlValue) => void;
  id?: string;
  className?: string;
  'aria-label'?: string;
  'aria-labelledby'?: string;
}

export function FieldControl({
  spec,
  value,
  onChange,
  id,
  className,
  'aria-label': ariaLabel,
  'aria-labelledby': ariaLabelledBy,
}: FieldControlProps) {
  const { t } = useTranslation('pages');

  switch (spec.kind) {
    case 'boolean': {
      const checked = value === true;
      return (
        <div className={cn('flex h-9 items-center gap-2', className)}>
          <Switch id={id} aria-label={ariaLabel} checked={checked} onCheckedChange={onChange} />
          <span className="text-muted-foreground text-sm">
            {checked
              ? t('automations.builder.conditions.yes')
              : t('automations.builder.conditions.no')}
          </span>
        </div>
      );
    }

    case 'number':
      // The unit sits in the control, so it converts with the reader's unit system
      // instead of sitting beside a label that cannot. Field forces direct children
      // to w-full, so the cap belongs on the group.
      return (
        <InputGroup className={cn(spec.unit ? 'max-w-44' : 'max-w-24', className)}>
          <NumericInput
            id={id}
            aria-label={ariaLabel}
            data-slot="input-group-control"
            className={INPUT_GROUP_CONTROL}
            min={spec.min}
            max={spec.max}
            step={spec.step}
            value={typeof value === 'number' ? value : (spec.min ?? 0)}
            onChange={onChange}
          />
          {spec.unit && (
            <InputGroupAddon align="inline-end" className={INPUT_GROUP_UNIT}>
              {spec.unit}
            </InputGroupAddon>
          )}
        </InputGroup>
      );

    case 'slider': {
      const current = typeof value === 'number' ? value : spec.min;
      return (
        <div className={cn('flex h-9 items-center gap-3', className)}>
          <Slider
            id={id}
            className="flex-1"
            aria-label={ariaLabel}
            aria-labelledby={ariaLabelledBy}
            min={spec.min}
            max={spec.max}
            step={spec.step}
            value={[current]}
            onValueChange={([next]) => onChange(next ?? spec.min)}
          />
          <span className="w-8 shrink-0 text-right text-sm font-medium tabular-nums">
            {current}
          </span>
        </div>
      );
    }

    case 'select':
      return (
        <Select value={typeof value === 'string' ? value : ''} onValueChange={onChange}>
          <SelectTrigger
            id={id}
            aria-label={ariaLabel}
            aria-labelledby={ariaLabelledBy}
            className={className}
          >
            <SelectValue
              placeholder={spec.placeholder ?? t('automations.builder.selectPlaceholder')}
            />
          </SelectTrigger>
          <SelectContent>
            {spec.options.map((option) => (
              <SelectItem key={option.value} value={option.value}>
                {option.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      );

    case 'multiSelect':
      return (
        <MultiSelect
          id={id}
          aria-label={ariaLabel}
          aria-labelledby={ariaLabelledBy}
          className={className}
          options={spec.options}
          value={Array.isArray(value) ? value.map(String) : []}
          onChange={onChange}
          placeholder={spec.placeholder ?? t('automations.builder.selectPlaceholder')}
          searchPlaceholder={t('automations.builder.searchPlaceholder')}
          emptyMessage={t('automations.builder.noMatches')}
          clearLabel={t('automations.builder.clearSelection')}
          countLabel={(count) => t('automations.builder.selectedCount', { count })}
        />
      );

    case 'text':
      return (
        <Input
          id={id}
          aria-label={ariaLabel}
          aria-labelledby={ariaLabelledBy}
          className={className}
          type="text"
          placeholder={spec.placeholder}
          value={typeof value === 'string' ? value : ''}
          onChange={(e) => onChange(e.target.value)}
        />
      );
  }
}
