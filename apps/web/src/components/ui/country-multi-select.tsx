/**
 * Multi-select combobox for selecting countries.
 * Displays country names but stores ISO 3166-1 alpha-2 codes.
 */

import { useState, useMemo } from 'react';
import { Check, ChevronsUpDown, X } from 'lucide-react';
import { getData, getName } from 'country-list';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from '@/components/ui/command';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';

interface CountryMultiSelectProps {
  value: string[];
  onChange: (codes: string[]) => void;
  placeholder?: string;
  emptyMessage?: string;
  className?: string;
}

interface Country {
  code: string;
  name: string;
}

export function CountryMultiSelect({
  value,
  onChange,
  placeholder = 'Select countries...',
  emptyMessage = 'No country found.',
  className,
}: CountryMultiSelectProps) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState('');

  // Get all countries and memoize
  const countries = useMemo<Country[]>(() => {
    return getData();
  }, []);

  // Filter countries based on search
  const filteredCountries = useMemo(() => {
    if (!search) return countries;
    const lower = search.toLowerCase();
    return countries.filter(
      (c) => c.name.toLowerCase().includes(lower) || c.code.toLowerCase().includes(lower)
    );
  }, [countries, search]);

  const handleSelect = (code: string) => {
    if (value.includes(code)) {
      onChange(value.filter((c) => c !== code));
    } else {
      onChange([...value, code]);
    }
  };

  const handleRemove = (code: string, e: React.MouseEvent) => {
    e.stopPropagation();
    onChange(value.filter((c) => c !== code));
  };

  const handleClear = (e: React.MouseEvent) => {
    e.stopPropagation();
    onChange([]);
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          role="combobox"
          aria-expanded={open}
          className={cn('h-auto min-h-10 w-full justify-between', className)}
        >
          <div className="flex flex-1 flex-wrap gap-1">
            {value.length === 0 ? (
              <span className="text-muted-foreground">{placeholder}</span>
            ) : (
              value.map((code) => {
                const name = getName(code) ?? code;
                return (
                  <Badge key={code} variant="secondary" className="mr-1 mb-1">
                    {name}
                    <button
                      type="button"
                      className="ring-offset-background focus:ring-ring ml-1 rounded-full outline-none focus:ring-2 focus:ring-offset-2"
                      onMouseDown={(e) => e.preventDefault()}
                      onClick={(e) => handleRemove(code, e)}
                    >
                      <X className="h-3 w-3" />
                      <span className="sr-only">Remove {name}</span>
                    </button>
                  </Badge>
                );
              })
            )}
          </div>
          <div className="flex items-center gap-1">
            {value.length > 0 && (
              <button
                type="button"
                className="text-muted-foreground hover:text-foreground rounded p-0.5"
                onMouseDown={(e) => e.preventDefault()}
                onClick={handleClear}
              >
                <X className="h-4 w-4" />
                <span className="sr-only">Clear all</span>
              </button>
            )}
            <ChevronsUpDown className="h-4 w-4 shrink-0 opacity-50" />
          </div>
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-[300px] p-0" align="start">
        <Command shouldFilter={false}>
          <CommandInput
            placeholder="Search countries..."
            value={search}
            onValueChange={setSearch}
          />
          <CommandList>
            <CommandEmpty>{emptyMessage}</CommandEmpty>
            <CommandGroup>
              {filteredCountries.map((country) => (
                <CommandItem
                  key={country.code}
                  value={country.code}
                  onSelect={() => handleSelect(country.code)}
                >
                  <Check
                    className={cn(
                      'mr-2 h-4 w-4',
                      value.includes(country.code) ? 'opacity-100' : 'opacity-0'
                    )}
                  />
                  <span className="flex-1">{country.name}</span>
                  <span className="text-muted-foreground ml-2 text-xs">{country.code}</span>
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}
