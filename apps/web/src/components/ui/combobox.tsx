import { useMemo, useState, type ReactNode } from 'react';
import { CheckIcon, ChevronsUpDown } from 'lucide-react';
import { cn } from '@/lib/utils';
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from '@/components/ui/command';
import { groupOptions } from '@/components/ui/group-options';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { selectTriggerClasses } from '@/components/ui/select';

export interface ComboboxOption<T extends string = string> {
  value: T;
  label: string;
  group?: string;
  icon?: ReactNode;
  description?: string;
}

interface ComboboxProps<T extends string> {
  value: T | null;
  onChange: (value: T) => void;
  options: ComboboxOption<T>[];
  placeholder: string;
  searchPlaceholder: string;
  emptyText: string;
  disabled?: boolean;
  /** Overrides the trigger's label for the selected option. */
  renderValue?: (option: ComboboxOption<T>) => ReactNode;
  id?: string;
  className?: string;
  contentClassName?: string;
  'aria-label'?: string;
  'aria-labelledby'?: string;
}

export function Combobox<T extends string>({
  value,
  onChange,
  options,
  placeholder,
  searchPlaceholder,
  emptyText,
  disabled,
  renderValue,
  id,
  className,
  contentClassName,
  'aria-label': ariaLabel,
  'aria-labelledby': ariaLabelledBy,
}: ComboboxProps<T>) {
  const [open, setOpen] = useState(false);

  const grouped = useMemo(() => groupOptions(options), [options]);

  const selected = options.find((option) => option.value === value);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          id={id}
          role="combobox"
          aria-expanded={open}
          aria-label={ariaLabel}
          aria-labelledby={ariaLabelledBy}
          disabled={disabled}
          className={cn(selectTriggerClasses, 'w-full', className)}
        >
          <span
            className={cn('flex min-w-0 items-center gap-2', !selected && 'text-muted-foreground')}
          >
            {selected?.icon}
            <span className="truncate">
              {selected ? (renderValue?.(selected) ?? selected.label) : placeholder}
            </span>
          </span>
          <ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
        </button>
      </PopoverTrigger>
      <PopoverContent className={cn('w-[260px] p-0', contentClassName)} align="start">
        <Command>
          <CommandInput placeholder={searchPlaceholder} />
          <CommandList>
            <CommandEmpty>{emptyText}</CommandEmpty>
            {grouped.map(([group, items]) => (
              <CommandGroup key={group} heading={group || undefined}>
                {items.map((option) => (
                  <CommandItem
                    key={option.value}
                    value={option.value}
                    keywords={[option.label]}
                    onSelect={() => {
                      onChange(option.value);
                      setOpen(false);
                    }}
                  >
                    {option.icon}
                    <span className="flex min-w-0 flex-1 flex-col">
                      <span className="truncate">{option.label}</span>
                      {option.description && (
                        <span className="text-muted-foreground truncate text-xs">
                          {option.description}
                        </span>
                      )}
                    </span>
                    {option.value === value && <CheckIcon className="size-4 shrink-0" />}
                  </CommandItem>
                ))}
              </CommandGroup>
            ))}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}
