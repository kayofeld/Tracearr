import { useEffect, useState } from 'react';
import { Search, X } from 'lucide-react';

import { cn } from '@/lib/utils';
import { Input } from '@/components/ui/input';
import { useDebouncedValue } from '@/hooks/useDebouncedValue';

export interface SearchFieldProps {
  value: string | undefined;
  onChange: (value: string | undefined) => void;
  placeholder: string;
  clearLabel: string;
  debounceMs?: number;
  id?: string;
  className?: string;
  'aria-label'?: string;
  'aria-labelledby'?: string;
}

export function SearchField({
  value,
  onChange,
  placeholder,
  clearLabel,
  debounceMs = 300,
  id,
  className,
  'aria-label': ariaLabel,
  'aria-labelledby': ariaLabelledBy,
}: SearchFieldProps) {
  const [input, setInput] = useState(value ?? '');

  useEffect(() => {
    setInput(value ?? '');
  }, [value]);

  useDebouncedValue(input, debounceMs, (settled) => {
    const next = settled.trim() || undefined;
    if (next !== value) onChange(next);
  });

  return (
    <div className={cn('relative', className)}>
      <Search className="text-muted-foreground pointer-events-none absolute top-1/2 left-2.5 h-4 w-4 -translate-y-1/2" />
      <Input
        id={id}
        value={input}
        onChange={(e) => setInput(e.target.value)}
        placeholder={placeholder}
        aria-label={ariaLabel}
        aria-labelledby={ariaLabelledBy}
        className="pr-8 pl-8"
      />
      {input.length > 0 && (
        <button
          type="button"
          aria-label={clearLabel}
          className="text-muted-foreground hover:text-foreground absolute top-1/2 right-2 -translate-y-1/2"
          onClick={() => {
            setInput('');
            onChange(undefined);
          }}
        >
          <X className="h-4 w-4" />
        </button>
      )}
    </div>
  );
}
