import { useMemo } from 'react';
import { Film, Tv, PieChart } from 'lucide-react';
import Highcharts from 'highcharts';
import { HighchartsReact } from 'highcharts-react-official';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { ChartSkeleton } from '@/components/ui/skeleton';
import { EmptyState } from '@/components/library';
import { PerServerCardGrid } from '@/components/server';
import { useLibraryResolution } from '@/hooks/queries';
import type { Server } from '@tracearr/shared';
import type { ResolutionBreakdown } from '@tracearr/shared';

interface ResolutionDistributionSectionProps {
  serverId?: string | null;
  selectedServers?: Server[];
  isMultiServer?: boolean;
}

const QUALITY_COLORS = {
  '4K': '#10b981',
  '1080p': '#3b82f6',
  '720p': '#f59e0b',
  SD: '#ef4444',
};

interface ResolutionDonutProps {
  data: ResolutionBreakdown | undefined;
  isLoading?: boolean;
  height?: number;
  title: string;
  icon?: React.ReactNode;
  showHeader?: boolean;
}

function ResolutionDonut({
  data,
  isLoading,
  height = 220,
  title,
  icon,
  showHeader = true,
}: ResolutionDonutProps) {
  const chartData = useMemo(() => {
    if (!data) return [];
    return [
      { name: '4K', y: data.count4k, color: QUALITY_COLORS['4K'] },
      { name: '1080p', y: data.count1080p, color: QUALITY_COLORS['1080p'] },
      { name: '720p', y: data.count720p, color: QUALITY_COLORS['720p'] },
      { name: 'SD', y: data.countSd, color: QUALITY_COLORS['SD'] },
    ].filter((d) => d.y > 0);
  }, [data]);

  const options = useMemo<Highcharts.Options>(() => {
    if (chartData.length === 0) {
      return {};
    }

    return {
      chart: {
        type: 'pie',
        height,
        backgroundColor: 'transparent',
        style: {
          fontFamily: 'inherit',
        },
        reflow: true,
      },
      title: {
        text: undefined,
      },
      credits: {
        enabled: false,
      },
      tooltip: {
        backgroundColor: 'hsl(var(--popover))',
        borderColor: 'hsl(var(--border))',
        style: {
          color: 'hsl(var(--popover-foreground))',
        },
        pointFormat: '<b>{point.y}</b> items ({point.percentage:.1f}%)',
      },
      plotOptions: {
        pie: {
          innerSize: '60%',
          borderWidth: 0,
          dataLabels: {
            enabled: false,
          },
          showInLegend: true,
        },
      },
      legend: {
        align: 'right',
        verticalAlign: 'middle',
        layout: 'vertical',
        itemStyle: {
          color: 'hsl(var(--foreground))',
          fontSize: '11px',
        },
        itemHoverStyle: {
          color: 'hsl(var(--primary))',
        },
      },
      series: [
        {
          type: 'pie',
          name: 'Quality',
          data: chartData,
        },
      ],
      responsive: {
        rules: [
          {
            condition: {
              maxWidth: 300,
            },
            chartOptions: {
              legend: {
                align: 'center',
                verticalAlign: 'bottom',
                layout: 'horizontal',
                itemStyle: {
                  fontSize: '10px',
                },
              },
            },
          },
        ],
      },
    };
  }, [chartData, height]);

  if (isLoading) {
    return (
      <div>
        {showHeader && (
          <div className="mb-2 flex items-center gap-2">
            {icon}
            <h4 className="text-sm font-medium">{title}</h4>
          </div>
        )}
        <ChartSkeleton height={height} />
      </div>
    );
  }

  if (chartData.length === 0) {
    return (
      <div>
        {showHeader && (
          <div className="mb-2 flex items-center gap-2">
            {icon}
            <h4 className="text-sm font-medium">{title}</h4>
          </div>
        )}
        <EmptyState
          icon={PieChart}
          title="No data"
          description={`No ${title.toLowerCase()} quality data available`}
        />
      </div>
    );
  }

  return (
    <div>
      {showHeader && (
        <div className="mb-2 flex items-center justify-between">
          <div className="flex items-center gap-2">
            {icon}
            <h4 className="text-sm font-medium">{title}</h4>
          </div>
          <span className="text-muted-foreground text-sm">
            {data?.total.toLocaleString()} items
          </span>
        </div>
      )}
      <HighchartsReact
        highcharts={Highcharts}
        options={options}
        containerProps={{ style: { width: '100%', height: '100%' } }}
      />
    </div>
  );
}

/** Per-server resolution content rendered inside PerServerCardGrid (no outer Card). */
function ServerResolutionCard({ serverId }: { serverId: string }) {
  const resolution = useLibraryResolution(serverId);

  return (
    <div className="grid gap-4 sm:grid-cols-2">
      <div>
        <div className="mb-2 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Film className="text-muted-foreground h-4 w-4" />
            <h4 className="text-sm font-medium">Movies</h4>
          </div>
          {resolution.data?.movies?.total !== undefined && (
            <span className="text-muted-foreground text-sm">
              {resolution.data.movies.total.toLocaleString()} items
            </span>
          )}
        </div>
        <ResolutionDonut
          data={resolution.data?.movies}
          isLoading={resolution.isLoading}
          title="Movies"
          showHeader={false}
        />
      </div>

      <div>
        <div className="mb-2 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Tv className="text-muted-foreground h-4 w-4" />
            <h4 className="text-sm font-medium">TV Shows</h4>
          </div>
          {resolution.data?.tv?.total !== undefined && (
            <span className="text-muted-foreground text-sm">
              {resolution.data.tv.total.toLocaleString()} items
            </span>
          )}
        </div>
        <ResolutionDonut
          data={resolution.data?.tv}
          isLoading={resolution.isLoading}
          title="TV Shows"
          showHeader={false}
        />
      </div>
    </div>
  );
}

/** Single-server layout — two side-by-side cards as the original design. */
function SingleServerResolutionSection({ serverId }: { serverId?: string | null }) {
  const resolution = useLibraryResolution(serverId);

  return (
    <div className="grid gap-6 md:grid-cols-2">
      <Card>
        <CardHeader className="pb-2">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <Film className="text-muted-foreground h-4 w-4" />
              <CardTitle className="text-base font-medium">Movies</CardTitle>
            </div>
            {resolution.data?.movies?.total !== undefined && (
              <span className="text-muted-foreground text-sm">
                {resolution.data.movies.total.toLocaleString()} items
              </span>
            )}
          </div>
        </CardHeader>
        <CardContent>
          <ResolutionDonut
            data={resolution.data?.movies}
            isLoading={resolution.isLoading}
            title="Movies"
            icon={null}
            showHeader={false}
          />
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-2">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <Tv className="text-muted-foreground h-4 w-4" />
              <CardTitle className="text-base font-medium">TV Shows</CardTitle>
            </div>
            {resolution.data?.tv?.total !== undefined && (
              <span className="text-muted-foreground text-sm">
                {resolution.data.tv.total.toLocaleString()} items
              </span>
            )}
          </div>
        </CardHeader>
        <CardContent>
          <ResolutionDonut
            data={resolution.data?.tv}
            isLoading={resolution.isLoading}
            title="TV Shows"
            icon={null}
            showHeader={false}
          />
        </CardContent>
      </Card>
    </div>
  );
}

/**
 * Resolution Distribution Section
 *
 * Single-server: two side-by-side cards (Movies + TV) as today.
 * Multi-server: one PerServerCardGrid card per server, each containing Movies + TV donuts.
 */
export function ResolutionDistributionSection({
  serverId,
  selectedServers,
  isMultiServer,
}: ResolutionDistributionSectionProps) {
  if (isMultiServer && selectedServers && selectedServers.length > 0) {
    return (
      <PerServerCardGrid
        servers={selectedServers}
        renderServer={(server) => <ServerResolutionCard serverId={server.id} />}
      />
    );
  }

  return <SingleServerResolutionSection serverId={serverId} />;
}
