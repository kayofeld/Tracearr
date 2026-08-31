import { useMemo } from 'react';
import Highcharts from 'highcharts';
import { HighchartsReact } from 'highcharts-react-official';
import { getHour12 } from '@/lib/timeFormat';
import { ChartSkeleton } from '@/components/ui/skeleton';
import { ChartEmpty } from './ChartEmpty';

interface HourOfDayData {
  hour: number;
  count: number;
}

interface HourOfDayChartProps {
  data: HourOfDayData[] | undefined;
  isLoading?: boolean;
  height?: number;
}

export function HourOfDayChart({ data, isLoading, height = 250 }: HourOfDayChartProps) {
  const options = useMemo<Highcharts.Options>(() => {
    if (!data || data.length === 0) {
      return {};
    }

    // Format hour labels based on time format preference
    const formatHour = (hour: number): string => {
      if (!getHour12()) {
        return `${hour.toString().padStart(2, '0')}:00`;
      }
      if (hour === 0) return '12am';
      if (hour === 12) return '12pm';
      return hour < 12 ? `${hour}am` : `${hour - 12}pm`;
    };

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
        categories: data.map((d) => formatHour(d.hour)),
        labels: {
          style: {
            color: 'hsl(var(--muted-foreground))',
            fontSize: '10px',
          },
          rotation: -45,
        },
        lineColor: 'hsl(var(--border))',
        tickColor: 'hsl(var(--border))',
      },
      yAxis: {
        title: {
          text: undefined,
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
        column: {
          borderRadius: 2,
          color: 'hsl(var(--chart-2))',
          pointPadding: 0.1,
          groupPadding: 0.1,
          states: {
            hover: {
              color: 'hsl(var(--chart-2) / 0.8)',
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
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const label = (this as any).point?.category || this.x;
          return `<b>${label}</b><br/>Plays: ${this.y}`;
        },
      },
      series: [
        {
          type: 'column',
          name: 'Plays',
          data: data.map((d) => d.count),
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
                    fontSize: '8px',
                  },
                  rotation: -60,
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
    return <ChartEmpty height={height} message="No data available" />;
  }

  return (
    <HighchartsReact
      highcharts={Highcharts}
      options={options}
      containerProps={{ style: { width: '100%', height: '100%' } }}
    />
  );
}
