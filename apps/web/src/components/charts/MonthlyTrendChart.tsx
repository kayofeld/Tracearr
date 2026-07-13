import { useMemo } from 'react';
import Highcharts from 'highcharts';
import { HighchartsReact } from 'highcharts-react-official';
import type { MonthlyTrend } from '@tracearr/shared';
import { ChartSkeleton } from '@/components/ui/skeleton';
import { EmptyState } from '@/components/library';
import { TrendingUp } from 'lucide-react';

interface MonthlyTrendChartProps {
  data: MonthlyTrend[] | undefined;
  isLoading?: boolean;
  height?: number;
}

function parseMonth(monthStr: string): number {
  const parts = monthStr.split('-');
  const year = parseInt(parts[0] ?? '2020');
  const month = parseInt(parts[1] ?? '1') - 1;
  return new Date(year, month, 1).getTime();
}

const formatMonth = (monthStr: string): string => {
  const parts = monthStr.split('-');
  const year = parts[0] ?? '2020';
  const month = parts[1] ?? '01';
  const date = new Date(parseInt(year), parseInt(month) - 1);
  return date.toLocaleDateString(undefined, { month: 'short', year: '2-digit' });
};

export function MonthlyTrendChart({ data, isLoading, height = 250 }: MonthlyTrendChartProps) {
  const options = useMemo<Highcharts.Options>(() => {
    if (!data || data.length === 0) {
      return {};
    }

    return {
      chart: {
        type: 'line',
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
      legend: {
        enabled: false,
      },
      xAxis: {
        type: 'datetime',
        tickPixelInterval: 100,
        dateTimeLabelFormats: {
          month: { main: `%b '%y` },
          year: { main: '%Y' },
        },
        labels: {
          style: {
            color: 'hsl(var(--muted-foreground))',
          },
        },
        lineColor: 'hsl(var(--border))',
        tickColor: 'hsl(var(--border))',
        startOnTick: false,
        endOnTick: false,
      },
      yAxis: {
        title: {
          text: 'Watch Count',
          style: {
            color: 'hsl(var(--muted-foreground))',
          },
        },
        labels: {
          style: {
            color: 'hsl(var(--muted-foreground))',
          },
        },
        gridLineColor: 'hsl(var(--border))',
        min: 0,
      },
      plotOptions: {
        line: {
          marker: {
            enabled: true,
            radius: 3,
          },
          color: 'hsl(var(--primary))',
          states: {
            hover: {
              lineWidth: 3,
            },
          },
        },
      },
      tooltip: {
        backgroundColor: 'hsl(var(--popover))',
        borderColor: 'hsl(var(--border))',
        style: {
          color: 'hsl(var(--popover-foreground))',
        },
        formatter: function () {
          const date = new Date(this.x);
          const monthStr = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
          const item = data.find((d) => d.month === monthStr);
          const monthLabel = item ? formatMonth(item.month) : formatMonth(monthStr);
          const uniqueItems = item?.uniqueItems ?? 0;
          return `<b>${monthLabel}</b><br/>Watches: ${this.y}<br/>Unique Items: ${uniqueItems}`;
        },
      },
      series: [
        {
          type: 'line',
          name: 'Watch Count',
          data: data.map((d) => [parseMonth(d.month), d.watchCount]),
        },
      ],
      responsive: {
        rules: [
          {
            condition: {
              maxWidth: 400,
            },
            chartOptions: {
              xAxis: {
                labels: {
                  style: {
                    fontSize: '9px',
                  },
                },
              },
              yAxis: {
                title: {
                  text: undefined,
                },
                labels: {
                  style: {
                    fontSize: '9px',
                  },
                },
              },
            },
          },
        ],
      },
    };
  }, [data, height]);

  if (isLoading) {
    return <ChartSkeleton height={height} />;
  }

  if (!data || data.length === 0) {
    return (
      <EmptyState
        icon={TrendingUp}
        title="No monthly data"
        description="Monthly watch trends will appear here once data is available"
      />
    );
  }

  return (
    <HighchartsReact
      highcharts={Highcharts}
      options={options}
      containerProps={{ style: { width: '100%', height: '100%' } }}
    />
  );
}
