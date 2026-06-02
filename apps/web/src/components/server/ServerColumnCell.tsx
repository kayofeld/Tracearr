import type { Server } from '@tracearr/shared';
import { ServerBadge } from './ServerBadge';
import { useServerColorMap } from '@/hooks/useServerColorMap';

interface ServerColumnCellProps {
  server: Pick<Server, 'id' | 'name'>;
}

export function ServerColumnCell({ server }: ServerColumnCellProps) {
  const colorMap = useServerColorMap();
  const color = colorMap.get(server.id) ?? null;
  return <ServerBadge server={{ ...server, color }} variant="outlined" />;
}
