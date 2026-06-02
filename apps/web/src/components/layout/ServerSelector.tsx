import { useServer } from '@/hooks/useServer';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Checkbox } from '@/components/ui/checkbox';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { MediaServerIcon } from '@/components/icons/MediaServerIcon';
import { ChevronsUpDown } from 'lucide-react';

export function ServerSelector() {
  const {
    servers,
    selectedServerIds,
    isAllServersSelected,
    toggleServer,
    selectAllServers,
    deselectAllExcept,
    isLoading,
    isFetching,
  } = useServer();

  // Show skeleton while loading initially or refetching with no cached data
  if (isLoading || (servers.length === 0 && isFetching)) {
    return (
      <div className="px-4 py-2">
        <Skeleton className="h-9 w-full" />
      </div>
    );
  }

  // No servers available
  if (servers.length === 0) {
    return null;
  }

  // Only one server — show static label
  if (servers.length === 1) {
    const server = servers[0]!;
    return (
      <div className="text-muted-foreground flex items-center gap-2 px-4 py-2 text-sm">
        <MediaServerIcon type={server.type} className="h-4 w-4" />
        <span className="truncate font-medium">{server.name}</span>
      </div>
    );
  }

  // Resolve single selected server for trigger display
  const singleSelected =
    selectedServerIds.length === 1 ? servers.find((s) => s.id === selectedServerIds[0]) : undefined;

  const triggerLabel = isAllServersSelected
    ? 'All servers'
    : singleSelected
      ? singleSelected.name
      : `${selectedServerIds.length} of ${servers.length} servers`;

  return (
    <div className="px-4 py-2">
      <Popover>
        <PopoverTrigger asChild>
          <Button
            variant="outline"
            role="combobox"
            className="h-9 w-full justify-between border-l-2 text-sm font-normal"
            style={{ borderLeftColor: singleSelected?.color ?? 'transparent' }}
          >
            <span className="flex items-center gap-2 truncate">
              {singleSelected && (
                <MediaServerIcon type={singleSelected.type} className="h-4 w-4 shrink-0" />
              )}
              {triggerLabel}
            </span>
            <ChevronsUpDown className="text-muted-foreground ml-2 h-4 w-4 shrink-0" />
          </Button>
        </PopoverTrigger>
        <PopoverContent className="w-[var(--radix-popover-trigger-width)] p-2" align="start">
          <button
            type="button"
            className="text-muted-foreground hover:text-foreground w-full px-2 py-1.5 text-left text-xs"
            onClick={() => {
              if (isAllServersSelected) {
                // Selection can't be empty, so collapse to the first server
                deselectAllExcept(servers[0]!.id);
              } else {
                selectAllServers();
              }
            }}
          >
            {isAllServersSelected ? 'Deselect all' : 'Select all'}
          </button>
          <div className="my-1 border-t" />
          {servers.map((server) => {
            const isSelected = selectedServerIds.includes(server.id);
            return (
              <label
                key={server.id}
                className="hover:bg-accent flex cursor-pointer items-center gap-2.5 rounded-sm border-l-2 px-2 py-1.5"
                style={{ borderLeftColor: server.color ?? 'transparent' }}
              >
                <Checkbox checked={isSelected} onCheckedChange={() => toggleServer(server.id)} />
                <MediaServerIcon type={server.type} className="h-4 w-4 shrink-0" />
                <span className="truncate text-sm">{server.name}</span>
              </label>
            );
          })}
        </PopoverContent>
      </Popover>
    </div>
  );
}
