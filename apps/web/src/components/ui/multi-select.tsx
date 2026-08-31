import { useMemo, useState, type ReactNode } from 'react';
import { ChevronsUpDown, X } from 'lucide-react';
import { cn } from '@/lib/utils';
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from '@/components/ui/command';
import { Checkbox } from '@/components/ui/checkbox';
import { groupOptions } from '@/components/ui/group-options';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { selectTriggerClasses } from '@/components/ui/select';

export interface MultiSelectOption {
  value: string;
  label: string;
  group?: string;
  icon?: ReactNode;
  /** Painted as a left border on the row, e.g. a server's assigned colour. */
  accentColor?: string | null;
}

interface MultiSelectListProps {
  options: MultiSelectOption[];
  value: string[];
  onToggle: (optionValue: string) => void;
  searchPlaceholder: string;
  emptyMessage: string;
  /** Rendered between the search box and the options, e.g. a select-all row. */
  header?: ReactNode;
  /** Set when the caller resolves matches itself; disables local filtering. */
  onSearchChange?: (search: string) => void;
  isLoading?: boolean;
  isError?: boolean;
  loadingMessage?: string;
  errorMessage?: string;
}

export function MultiSelectList({
  options,
  value,
  onToggle,
  searchPlaceholder,
  emptyMessage,
  header,
  onSearchChange,
  isLoading = false,
  isError = false,
  loadingMessage,
  errorMessage,
}: MultiSelectListProps) {
  const [search, setSearch] = useState('');

  const grouped = useMemo(() => {
    const needle = onSearchChange ? '' : search.toLowerCase();
    const matches = needle
      ? options.filter((option) => option.label.toLowerCase().includes(needle))
      : options;

    return groupOptions(matches);
  }, [options, search, onSearchChange]);

  return (
    <Command shouldFilter={false}>
      <CommandInput
        placeholder={searchPlaceholder}
        value={search}
        onValueChange={(next) => {
          setSearch(next);
          onSearchChange?.(next);
        }}
      />
      {header}
      <CommandList>
        {isLoading && (
          <div className="text-muted-foreground py-6 text-center text-sm">{loadingMessage}</div>
        )}
        {isError && !isLoading && (
          <div className="text-destructive py-6 text-center text-sm">{errorMessage}</div>
        )}
        {!isLoading && !isError && <CommandEmpty>{emptyMessage}</CommandEmpty>}
        {!isLoading &&
          !isError &&
          grouped.map(([group, items]) => (
            <CommandGroup key={group} heading={group || undefined}>
              {items.map((option) => (
                <CommandItem
                  key={option.value}
                  value={option.value}
                  onSelect={() => onToggle(option.value)}
                  className={cn(option.accentColor && 'border-l-2')}
                  style={option.accentColor ? { borderLeftColor: option.accentColor } : undefined}
                >
                  <Checkbox checked={value.includes(option.value)} tabIndex={-1} />
                  {option.icon}
                  <span className="flex-1 truncate">{option.label}</span>
                </CommandItem>
              ))}
            </CommandGroup>
          ))}
      </CommandList>
    </Command>
  );
}

interface MultiSelectProps {
  options: MultiSelectOption[];
  value: string[];
  onChange: (value: string[]) => void;
  placeholder: string;
  searchPlaceholder: string;
  emptyMessage: string;
  clearLabel: string;
  countLabel: (count: number) => string;
  id?: string;
  className?: string;
  contentClassName?: string;
  'aria-labelledby'?: string;
}

export function MultiSelect({
  options,
  value,
  onChange,
  placeholder,
  searchPlaceholder,
  emptyMessage,
  clearLabel,
  countLabel,
  id,
  className,
  contentClassName,
  'aria-labelledby': ariaLabelledBy,
}: MultiSelectProps) {
  const [open, setOpen] = useState(false);

  const [first] = value;
  const summary =
    value.length === 0 || first === undefined
      ? placeholder
      : value.length === 1
        ? (options.find((option) => option.value === first)?.label ?? first)
        : countLabel(value.length);

  const toggle = (optionValue: string) => {
    onChange(
      value.includes(optionValue) ? value.filter((v) => v !== optionValue) : [...value, optionValue]
    );
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          id={id}
          role="combobox"
          aria-expanded={open}
          aria-labelledby={ariaLabelledBy}
          className={cn(selectTriggerClasses, 'w-full', className)}
        >
          <span className={cn('truncate', value.length === 0 && 'text-muted-foreground')}>
            {summary}
          </span>
          <span className="ml-2 flex shrink-0 items-center gap-1">
            {value.length > 0 && (
              <span
                role="button"
                tabIndex={-1}
                aria-label={clearLabel}
                className="text-muted-foreground hover:text-foreground rounded p-0.5"
                onMouseDown={(e) => e.preventDefault()}
                onClick={(e) => {
                  e.stopPropagation();
                  onChange([]);
                }}
              >
                <X className="h-3.5 w-3.5" />
              </span>
            )}
            <ChevronsUpDown className="h-4 w-4 opacity-50" />
          </span>
        </button>
      </PopoverTrigger>
      <PopoverContent className={cn('w-[260px] p-0', contentClassName)} align="start">
        <MultiSelectList
          options={options}
          value={value}
          onToggle={toggle}
          searchPlaceholder={searchPlaceholder}
          emptyMessage={emptyMessage}
        />
      </PopoverContent>
    </Popover>
  );
}
