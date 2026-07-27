import { useMemo } from 'react';
import Highcharts from 'highcharts';
import { HighchartsReact } from 'highcharts-react-official';
import type { NeverWatchedAgeDistribution, NeverWatchedAgeBucket } from '@tracearr/shared';
import { ChartSkeleton } from '@/components/ui/skeleton';
import { EmptyState } from '@/components/library';
import { Clock } from 'lucide-react';

// Fixed left-to-right ordering; the backend always returns all five buckets.
const BUCKET_ORDER: NeverWatchedAgeBucket[] = ['lt30', 'd30to90', 'd90to180', 'd180to365', 'gt365'];

const BUCKET_COLORS: Record<NeverWatchedAgeBucket, string> = {
  lt30: 'hsl(var(--chart-1))',
  d30to90: 'hsl(var(--chart-2))',
  d90to180: 'hsl(var(--chart-3))',
  d180to365: 'hsl(var(--chart-4))',
  gt365: 'hsl(var(--chart-5))',
};

interface NeverWatchedAgeChartProps {
  data: NeverWatchedAgeDistribution[] | undefined;
  isLoading?: boolean;
  height?: number;
  /** Human-readable label per bucket, sourced from i18n by the caller. */
  bucketLabels: Record<NeverWatchedAgeBucket, string>;
  /** Y-axis / series name, e.g. "Items" - sourced from i18n by the caller. */
  seriesName: string;
  emptyTitle: string;
  emptyDescription: string;
}

export function NeverWatchedAgeChart({
  data,
  isLoading,
  height = 250,
  bucketLabels,
  seriesName,
  emptyTitle,
  emptyDescription,
}: NeverWatchedAgeChartProps) {
  const chartData = useMemo(() => {
    if (!data || data.length === 0) return [];
    const byBucket = new Map(data.map((d) => [d.bucket, d]));
    return BUCKET_ORDER.map((bucket) => ({
      bucket,
      count: byBucket.get(bucket)?.count ?? 0,
      sizeBytes: byBucket.get(bucket)?.sizeBytes ?? 0,
    }));
  }, [data]);

  const hasAnyItems = chartData.some((d) => d.count > 0);

  const options = useMemo<Highcharts.Options>(() => {
    if (chartData.length === 0) {
      return {};
    }

    return {
      chart: {
        type: 'column',
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
        categories: chartData.map((d) => bucketLabels[d.bucket]),
        labels: {
          style: {
            color: 'hsl(var(--muted-foreground))',
            fontSize: '11px',
          },
        },
        lineColor: 'hsl(var(--border))',
        tickColor: 'hsl(var(--border))',
      },
      yAxis: {
        title: {
          text: seriesName,
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
        allowDecimals: false,
      },
      plotOptions: {
        column: {
          borderRadius: 2,
          colorByPoint: true,
          colors: chartData.map((d) => BUCKET_COLORS[d.bucket]),
        },
      },
      tooltip: {
        backgroundColor: 'hsl(var(--popover))',
        borderColor: 'hsl(var(--border))',
        style: {
          color: 'hsl(var(--popover-foreground))',
        },
        formatter: function () {
          // Find item by matching the x-axis category label shown for this point
          const xValue = String(this.x);
          const point = chartData.find((d) => bucketLabels[d.bucket] === xValue);
          return `<b>${xValue}</b><br/>${seriesName}: ${point?.count ?? this.y}`;
        },
      },
      series: [
        {
          type: 'column',
          name: seriesName,
          data: chartData.map((d) => d.count),
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
  }, [chartData, height, bucketLabels, seriesName]);

  if (isLoading) {
    return <ChartSkeleton height={height} />;
  }

  if (chartData.length === 0 || !hasAnyItems) {
    return <EmptyState icon={Clock} title={emptyTitle} description={emptyDescription} />;
  }

  return (
    <HighchartsReact
      highcharts={Highcharts}
      options={options}
      containerProps={{ style: { width: '100%', height: '100%' } }}
    />
  );
}
