import type { Server } from '@tracearr/shared';
import { cn } from '@/lib/utils';

type Variant = 'inline' | 'floating';

interface ServerLegendProps {
  servers: Pick<Server, 'id' | 'name' | 'color'>[];
  variant?: Variant;
  className?: string;
}

export function ServerLegend({ servers, variant = 'inline', className }: ServerLegendProps) {
  if (servers.length < 2) return null;

  const layout =
    variant === 'floating'
      ? 'bg-card/90 border-border absolute right-2 bottom-2 z-10 rounded-md border px-2.5 py-1.5 shadow-sm backdrop-blur-sm'
      : 'inline-flex flex-wrap items-center gap-3';

  return (
    <div role="group" aria-label="Server legend" className={cn(layout, 'text-xs', className)}>
      {servers.map((server) => (
        <div key={server.id} className="flex items-center gap-1.5 py-0.5">
          <span
            aria-hidden="true"
            className="bg-muted-foreground inline-block h-2 w-2 shrink-0 rounded-full"
            style={server.color ? { backgroundColor: server.color } : undefined}
          />
          <span className="text-foreground">{server.name}</span>
        </div>
      ))}
    </div>
  );
}
