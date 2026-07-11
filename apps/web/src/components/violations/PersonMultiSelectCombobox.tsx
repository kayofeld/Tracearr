/**
 * Multi-select searchable combobox for filtering violations by person
 * (identity). Follows the Command + Popover checkbox-item recipe used by
 * CountryMultiSelect, but the trigger reuses SelectTrigger's own classes
 * (border/background/height/radius) so it sits flush with the severity and
 * status Select filters beside it on the Violations page.
 *
 * Search is server-side (see useUsers `search` param) rather than filtering
 * only the loaded page of options, since the roster can exceed the page size
 * fetched for the picker. Typing is debounced before it's forwarded via
 * `onSearchChange` so it doesn't fire a request per keystroke; the debounce
 * only delays a callback prop, it does not perform data fetching itself.
 */

import { useEffect, useMemo, useState } from 'react';
import { ChevronsUpDown, X } from 'lucide-react';
import type { ServerUserWithIdentity } from '@tracearr/shared';
import { cn } from '@/lib/utils';
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from '@/components/ui/command';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { Checkbox } from '@/components/ui/checkbox';
import { getAvatarUrl } from '@/components/users/utils';
import { summarizePersonSelection } from './personFilterSummary';

const SEARCH_DEBOUNCE_MS = 300;

interface PersonMultiSelectComboboxProps {
  value: string[];
  onChange: (userIds: string[]) => void;
  options: ServerUserWithIdentity[];
  onSearchChange?: (search: string) => void;
  isLoading?: boolean;
  isError?: boolean;
  allLabel: string;
  countLabel: (count: number) => string;
  searchPlaceholder: string;
  emptyMessage: string;
  errorMessage: string;
  loadingMessage: string;
  triggerId?: string;
  className?: string;
  // Resolves a display name for a selected id that isn't in the currently
  // loaded (search-scoped) options page, so the trigger summary can still
  // show a real name instead of falling back to the count label.
  resolveExtraName?: (id: string) => string | undefined;
}

// Same visual treatment as SelectTrigger (see components/ui/select.tsx) so
// this button-based combobox matches the severity/status Select filters.
const TRIGGER_CLASSES =
  'border-input bg-background ring-offset-background flex h-10 w-48 items-center justify-between rounded-md border px-3 py-2 text-sm focus:ring-2 focus:ring-ring focus:ring-offset-2 focus:outline-none disabled:cursor-not-allowed disabled:opacity-50';

export function PersonMultiSelectCombobox({
  value,
  onChange,
  options,
  onSearchChange,
  isLoading = false,
  isError = false,
  allLabel,
  countLabel,
  searchPlaceholder,
  emptyMessage,
  errorMessage,
  loadingMessage,
  triggerId,
  className,
  resolveExtraName,
}: PersonMultiSelectComboboxProps) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState('');

  useEffect(() => {
    if (!onSearchChange) return;
    const handle = setTimeout(() => onSearchChange(search), SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(handle);
  }, [search, onSearchChange]);

  const nameById = useMemo(() => {
    const map = new Map<string, string>();
    for (const option of options) {
      map.set(option.userId, option.identityName ?? option.username);
    }
    return map;
  }, [options]);

  const summary = summarizePersonSelection(
    value,
    (id) => nameById.get(id) ?? resolveExtraName?.(id),
    allLabel,
    countLabel
  );

  const toggle = (userId: string) => {
    onChange(value.includes(userId) ? value.filter((id) => id !== userId) : [...value, userId]);
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          id={triggerId}
          role="combobox"
          aria-expanded={open}
          className={cn(TRIGGER_CLASSES, className)}
        >
          <span className="truncate">{summary}</span>
          <div className="flex items-center gap-1">
            {value.length > 0 && (
              <span
                role="button"
                tabIndex={-1}
                className="text-muted-foreground hover:text-foreground rounded p-0.5"
                onMouseDown={(e) => e.preventDefault()}
                onClick={(e) => {
                  e.stopPropagation();
                  onChange([]);
                }}
              >
                <X className="h-3.5 w-3.5" />
                <span className="sr-only">Clear</span>
              </span>
            )}
            <ChevronsUpDown className="h-4 w-4 shrink-0 opacity-50" />
          </div>
        </button>
      </PopoverTrigger>
      <PopoverContent className="w-[280px] p-0" align="start">
        <Command shouldFilter={false}>
          <CommandInput placeholder={searchPlaceholder} value={search} onValueChange={setSearch} />
          <CommandList>
            {isLoading ? (
              <div className="text-muted-foreground py-6 text-center text-sm">{loadingMessage}</div>
            ) : isError ? (
              <div className="text-destructive py-6 text-center text-sm">{errorMessage}</div>
            ) : (
              <>
                <CommandEmpty>{emptyMessage}</CommandEmpty>
                <CommandGroup>
                  {options.map((option) => {
                    const checked = value.includes(option.userId);
                    return (
                      <CommandItem
                        key={option.userId}
                        value={option.userId}
                        onSelect={() => toggle(option.userId)}
                      >
                        <Checkbox checked={checked} tabIndex={-1} />
                        <Avatar className="h-5 w-5">
                          <AvatarImage
                            src={getAvatarUrl(option.serverId, option.thumbUrl, 40) ?? undefined}
                          />
                          <AvatarFallback className="text-[8px]">
                            {(option.identityName ?? option.username)[0]?.toUpperCase() ?? '?'}
                          </AvatarFallback>
                        </Avatar>
                        <span className="flex-1 truncate">
                          {option.identityName ?? option.username}
                        </span>
                      </CommandItem>
                    );
                  })}
                </CommandGroup>
              </>
            )}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}
