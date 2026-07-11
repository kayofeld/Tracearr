import type { Server } from '@tracearr/shared';
import { cn } from '@/lib/utils';

type Variant = 'default' | 'compact' | 'outlined';

interface ServerBadgeProps {
  server: Pick<Server, 'id' | 'name' | 'color'>;
  variant?: Variant;
  className?: string;
}

const baseContainer =
  'inline-flex max-w-full items-center gap-1.5 rounded-full px-2 py-0.5 text-xs';

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
      ? cn(baseContainer, 'border-border text-muted-foreground border')
      : cn(baseContainer, 'bg-muted');

  return (
    <span className={cn(containerClass, className)}>
      <span
        aria-hidden="true"
        className="bg-muted-foreground inline-block h-2 w-2 shrink-0 rounded-full"
        style={dotStyle}
      />
      <span className="truncate" title={server.name}>
        {server.name}
      </span>
    </span>
  );
}
