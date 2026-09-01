import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Plus } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from '@/components/ui/command';
import { groupOptions } from '@/components/ui/group-options';
import { Kbd, KbdGroup } from '@/components/ui/kbd';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import type { NodePickerEntry } from '@/lib/automations';

interface NodePickerProps {
  entries: readonly NodePickerEntry[];
  /** Values to lift into a Suggested group while the search box is empty. */
  suggested?: readonly string[];
  onSelect: (value: string) => void;
  label: string;
  /** Drawn as the primary action when it is the one thing an empty step offers. */
  primary?: boolean;
}

/**
 * Plain substring matching rather than cmdk's fuzzy default: on a list this short,
 * a fuzzy hit on scattered letters reads as a bug.
 */
function matchesQuery(value: string, search: string, keywords?: string[]): number {
  const needle = search.trim().toLowerCase();
  if (needle === '') return 1;
  const haystack = [value, ...(keywords ?? [])].join(' ').toLowerCase();
  return haystack.includes(needle) ? 1 : 0;
}

export function NodePicker({
  entries,
  suggested = [],
  onSelect,
  label,
  primary = false,
}: NodePickerProps) {
  const { t } = useTranslation('pages');
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');

  const groups = useMemo<[string, NodePickerEntry[]][]>(() => {
    const lifted = query.trim() === '' ? new Set(suggested) : new Set<string>();
    const lead = entries.filter((entry) => lifted.has(entry.value));
    const rest = entries.filter((entry) => !lifted.has(entry.value));
    const grouped = groupOptions([...rest]);
    if (lead.length === 0) return grouped;
    return [[t('automations.catalog.suggested'), lead], ...grouped];
  }, [entries, suggested, query, t]);

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) setQuery('');
      }}
    >
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant={primary ? 'default' : 'outline'}
          size={primary ? 'default' : 'sm'}
          data-node-picker
        >
          <Plus />
          {label}
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-(--radix-popover-trigger-width) min-w-[22rem] p-0" align="start">
        <Command filter={matchesQuery}>
          <CommandInput
            value={query}
            onValueChange={setQuery}
            placeholder={t('automations.builder.picker.searchPlaceholder')}
          />
          <CommandList>
            <CommandEmpty>{t('automations.builder.picker.empty')}</CommandEmpty>
            {groups.map(([group, groupEntries]) => (
              <CommandGroup key={group} heading={group}>
                {groupEntries.map((entry) => (
                  <CommandItem
                    key={entry.value}
                    value={entry.value}
                    keywords={[entry.label, entry.description, ...entry.synonyms]}
                    onSelect={() => {
                      onSelect(entry.value);
                      setOpen(false);
                    }}
                  >
                    <span className="flex min-w-0 flex-1 flex-col">
                      <span className="truncate">{entry.label}</span>
                      <span className="text-muted-foreground truncate text-xs">
                        {entry.description}
                      </span>
                    </span>
                  </CommandItem>
                ))}
              </CommandGroup>
            ))}
          </CommandList>
          <div className="text-muted-foreground flex items-center gap-3 border-t px-3 py-2 text-xs">
            <span className="flex items-center gap-1">
              <KbdGroup>
                <Kbd>↑</Kbd>
                <Kbd>↓</Kbd>
              </KbdGroup>
              {t('automations.builder.picker.navigate')}
            </span>
            <span className="flex items-center gap-1">
              <Kbd>↵</Kbd>
              {t('automations.builder.picker.select')}
            </span>
            <span className="flex items-center gap-1">
              <Kbd>Esc</Kbd>
              {t('automations.builder.picker.close')}
            </span>
          </div>
        </Command>
      </PopoverContent>
    </Popover>
  );
}
