import { useMemo } from 'react';
import Highcharts from 'highcharts';
import { HighchartsReact } from 'highcharts-react-official';
import type { PlayStats, Server } from '@tracearr/shared';
import { getHour12 } from '@/lib/timeFormat';
import { ChartSkeleton } from '@/components/ui/skeleton';
import { parseChartDate, buildPerServerSeries } from './chartUtils';

interface PlaysChartProps {
  data: PlayStats[] | undefined;
  isLoading?: boolean;
  height?: number;
  period?: 'day' | 'week' | 'month' | 'year' | 'all' | 'custom';
  isMultiServer?: boolean;
  servers?: Pick<Server, 'id' | 'name' | 'color'>[];
}

export function PlaysChart({
  data,
  isLoading,
  height = 200,
  period = 'month',
  isMultiServer = false,
  servers = [],
}: PlaysChartProps) {
  const options = useMemo<Highcharts.Options>(() => {
    if (!data || data.length === 0) {
      return {};
    }

    const xAxisBase: Highcharts.XAxisOptions = {
      type: 'datetime',
      tickPixelInterval: 120,
      dateTimeLabelFormats: {
        hour: { main: getHour12() ? '%l %p' : '%k:%M' },
        day: { main: '%b %e' },
        week: { main: '%b %e' },
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
    };

    const yAxisBase: Highcharts.YAxisOptions = {
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
    };

    const tooltipBase: Highcharts.TooltipOptions = {
      backgroundColor: 'hsl(var(--popover))',
      borderColor: 'hsl(var(--border))',
      style: {
        color: 'hsl(var(--popover-foreground))',
      },
    };

    const responsiveRules: Highcharts.ResponsiveRulesOptions[] = [
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
            labels: {
              style: {
                fontSize: '9px',
              },
            },
          },
        },
      },
    ];

    if (isMultiServer && servers.length > 0) {
      return {
        chart: {
          type: 'area',
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
          enabled: true,
          itemStyle: {
            color: 'hsl(var(--muted-foreground))',
          },
          itemHoverStyle: {
            color: 'hsl(var(--foreground))',
          },
        },
        xAxis: xAxisBase,
        yAxis: yAxisBase,
        plotOptions: {
          area: {
            stacking: 'normal',
            marker: {
              enabled: false,
              states: {
                hover: {
                  enabled: true,
                  radius: 4,
                },
              },
            },
            lineWidth: 2,
          },
        },
        tooltip: {
          ...tooltipBase,
          shared: true,
          formatter: function () {
            const date = new Date(this.x);
            let dateStr = 'Unknown';

            if (period === 'all') {
              dateStr = `Week of ${date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}`;
            } else if (period === 'year' || period === 'month') {
              dateStr = date.toLocaleDateString('en-US', {
                month: 'short',
                day: 'numeric',
                year: 'numeric',
              });
            } else {
              dateStr = `${date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })} ${date.toLocaleTimeString('en-US', { hour: 'numeric', hour12: getHour12() })}`;
            }

            const points = this.points ?? [];
            const rows = points
              .map((p) => `<span style="color:${p.color}">●</span> ${p.series.name}: <b>${p.y}</b>`)
              .join('<br/>');
            return `<b>${dateStr}</b><br/>${rows}`;
          },
        },
        series: buildPerServerSeries(data, servers, (d) => [parseChartDate(d.date), d.count], {
          type: 'area',
          stacking: 'normal',
        }),
        responsive: {
          rules: responsiveRules,
        },
      };
    }

    // Single-server rendering - unchanged from original
    return {
      chart: {
        type: 'area',
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
      xAxis: xAxisBase,
      yAxis: yAxisBase,
      plotOptions: {
        area: {
          fillColor: {
            linearGradient: { x1: 0, y1: 0, x2: 0, y2: 1 },
            stops: [
              [0, 'hsl(var(--primary) / 0.3)'],
              [1, 'hsl(var(--primary) / 0.05)'],
            ],
          },
          marker: {
            enabled: false,
            states: {
              hover: {
                enabled: true,
                radius: 4,
              },
            },
          },
          lineWidth: 2,
          lineColor: 'hsl(var(--primary))',
          states: {
            hover: {
              lineWidth: 2,
            },
          },
          threshold: null,
        },
      },
      tooltip: {
        ...tooltipBase,
        formatter: function () {
          const date = new Date(this.x);
          let dateStr = 'Unknown';

          if (period === 'all') {
            dateStr = `Week of ${date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}`;
          } else if (period === 'year' || period === 'month') {
            dateStr = date.toLocaleDateString('en-US', {
              month: 'short',
              day: 'numeric',
              year: 'numeric',
            });
          } else {
            // day (hourly) or week (6-hour)
            dateStr = `${date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })} ${date.toLocaleTimeString('en-US', { hour: 'numeric', hour12: getHour12() })}`;
          }
          return `<b>${dateStr}</b><br/>Plays: ${this.y}`;
        },
      },
      series: [
        {
          type: 'area',
          name: 'Plays',
          data: data.map((d) => [parseChartDate(d.date), d.count]),
        },
      ],
      responsive: {
        rules: responsiveRules,
      },
    };
  }, [data, height, period, isMultiServer, servers]);

  if (isLoading) {
    return <ChartSkeleton height={height} />;
  }

  if (!data || data.length === 0) {
    return (
      <div
        className="text-muted-foreground flex items-center justify-center rounded-lg border border-dashed"
        style={{ height }}
      >
        No play data available
      </div>
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
