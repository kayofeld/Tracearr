interface ChartEmptyProps {
  /** Matches the chart's own height so the card does not collapse when data arrives. */
  height: number | string;
  message: string;
}

export function ChartEmpty({ height, message }: ChartEmptyProps) {
  return (
    <div
      className="text-muted-foreground flex items-center justify-center text-sm"
      style={{ height }}
    >
      {message}
    </div>
  );
}
