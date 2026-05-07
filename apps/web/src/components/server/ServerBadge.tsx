import type { Server } from '@tracearr/shared';
import { cn } from '@/lib/utils';

type Variant = 'default' | 'compact' | 'outlined';

interface ServerBadgeProps {
  server: Pick<Server, 'id' | 'name' | 'color'>;
  variant?: Variant;
  className?: string;
}

export function ServerBadge({ server, variant = 'default', className }: ServerBadgeProps) {
  const dotStyle = server.color ? { backgroundColor: server.color } : undefined;

  if (variant === 'compact') {
    return (
      <span
        aria-label={server.name}
        title={server.name}
        className={cn('bg-muted-foreground inline-block h-2 w-2 shrink-0 rounded-full', className)}
        style={dotStyle}
      />
    );
  }

  const containerClass =
    variant === 'outlined'
      ? 'inline-flex items-center gap-1.5 rounded-full border border-border px-2 py-0.5 text-xs text-muted-foreground'
      : 'inline-flex items-center gap-1.5 rounded-full bg-muted px-2 py-0.5 text-xs';

  return (
    <span className={cn(containerClass, className)}>
      <span
        aria-label={server.name}
        className="bg-muted-foreground inline-block h-2 w-2 shrink-0 rounded-full"
        style={dotStyle}
      />
      <span className="truncate">{server.name}</span>
    </span>
  );
}
