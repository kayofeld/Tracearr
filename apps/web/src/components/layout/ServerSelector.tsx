import { useTranslation } from 'react-i18next';
import { ChevronsUpDown, Server } from 'lucide-react';
import { useServer } from '@/hooks/useServer';
import { Button } from '@/components/ui/button';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Skeleton } from '@/components/ui/skeleton';
import { MultiSelectList, type MultiSelectOption } from '@/components/ui/multi-select';
import { SidebarMenu, SidebarMenuButton, SidebarMenuItem } from '@/components/ui/sidebar';
import { MediaServerIcon } from '@/components/icons/MediaServerIcon';

export function ServerSelector() {
  const { t } = useTranslation('common');
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

  if (isLoading || (servers.length === 0 && isFetching)) {
    return (
      <div className="px-2 pb-2">
        <Skeleton className="h-8 w-full" />
      </div>
    );
  }

  const [firstServer] = servers;
  if (!firstServer) {
    return null;
  }

  if (servers.length === 1) {
    const server = firstServer;
    return (
      <div className="px-2 pb-2">
        <div className="text-muted-foreground flex items-center gap-2 overflow-hidden p-2 text-sm group-data-[collapsible=icon]:justify-center">
          <MediaServerIcon type={server.type} className="size-4 shrink-0" />
          <span className="truncate font-medium group-data-[collapsible=icon]:hidden">
            {server.name}
          </span>
        </div>
      </div>
    );
  }

  const singleSelected =
    selectedServerIds.length === 1 ? servers.find((s) => s.id === selectedServerIds[0]) : undefined;

  const triggerLabel = isAllServersSelected
    ? t('serverSelector.all')
    : (singleSelected?.name ??
      t('serverSelector.some', { count: selectedServerIds.length, total: servers.length }));

  const options: MultiSelectOption[] = servers.map((server) => ({
    value: server.id,
    label: server.name,
    accentColor: server.color,
    icon: <MediaServerIcon type={server.type} className="size-4 shrink-0" />,
  }));

  const selectAllRow = (
    <div className="border-b p-1">
      <Button
        type="button"
        variant="ghost"
        size="sm"
        className="text-muted-foreground h-7 w-full justify-start text-xs font-normal"
        onClick={() => {
          // Selection can't be empty, so clearing collapses to the first server
          if (isAllServersSelected) deselectAllExcept(firstServer.id);
          else selectAllServers();
        }}
      >
        {isAllServersSelected ? t('actions.deselectAll') : t('actions.selectAll')}
      </Button>
    </div>
  );

  return (
    <div className="px-2 pb-2">
      <SidebarMenu>
        <SidebarMenuItem>
          <Popover>
            <PopoverTrigger asChild>
              <SidebarMenuButton
                className="border-l-2 group-data-[collapsible=icon]:border-l-0"
                style={{ borderLeftColor: singleSelected?.color ?? 'transparent' }}
                tooltip={triggerLabel}
              >
                {/* MediaServerIcon renders an <img>, which SidebarMenuButton's
                    [&>svg]:size-4 rule cannot reach, so it must size itself. */}
                {singleSelected ? (
                  <MediaServerIcon type={singleSelected.type} className="size-4 shrink-0" />
                ) : (
                  <Server />
                )}
                <span className="truncate">{triggerLabel}</span>
                <ChevronsUpDown className="ml-auto opacity-50 group-data-[collapsible=icon]:hidden" />
              </SidebarMenuButton>
            </PopoverTrigger>
            <PopoverContent className="w-64 p-0" align="start" side="right" sideOffset={8}>
              <MultiSelectList
                options={options}
                value={selectedServerIds}
                onToggle={toggleServer}
                searchPlaceholder={t('serverSelector.search')}
                emptyMessage={t('serverSelector.noMatches')}
                header={selectAllRow}
              />
            </PopoverContent>
          </Popover>
        </SidebarMenuItem>
      </SidebarMenu>
    </div>
  );
}
