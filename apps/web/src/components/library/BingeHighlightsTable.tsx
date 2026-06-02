import { Zap } from 'lucide-react';
import type { BingeShow } from '@tracearr/shared';
import type { Server } from '@tracearr/shared';
import { Badge } from '@/components/ui/badge';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { ServerBadge } from '@/components/server';
import { EmptyState } from '@/components/library';

interface BingeHighlightsTableProps {
  data: BingeShow[] | undefined;
  isLoading?: boolean;
  selectedServers?: Server[];
  isMultiServer?: boolean;
}

/**
 * Get binge score badge based on score thresholds.
 */
function getBingeScoreBadge(score: number) {
  if (score >= 80) return <Badge variant="danger">Highly Addictive</Badge>;
  if (score >= 60) return <Badge variant="warning">Addictive</Badge>;
  if (score >= 40) return <Badge variant="secondary">Bingeable</Badge>;
  return <Badge variant="outline">Casual Watch</Badge>;
}

/**
 * Table displaying binge-watched shows with scores and episode stats.
 * Shows shows where users watched multiple episodes consecutively.
 * In multi-server mode adds a Server column showing all involved servers and applies a
 * per-row left-border accent using the primaryServerId color.
 */
export function BingeHighlightsTable({
  data,
  isLoading,
  selectedServers = [],
  isMultiServer = false,
}: BingeHighlightsTableProps) {
  if (isLoading) {
    return (
      <div className="flex h-48 items-center justify-center">
        <div className="text-muted-foreground">Loading...</div>
      </div>
    );
  }

  if (!data?.length) {
    return (
      <EmptyState
        icon={Zap}
        title="No binge patterns detected"
        description="Watch multiple episodes in a row to see binge patterns."
      />
    );
  }

  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Show</TableHead>
          {isMultiServer && <TableHead>Servers</TableHead>}
          <TableHead>Episodes</TableHead>
          <TableHead>Consecutive</TableHead>
          <TableHead>Binge Score</TableHead>
          <TableHead>Max/Day</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {data.map((show) => {
          const primaryColor = isMultiServer
            ? (selectedServers.find((s) => s.id === show.primaryServerId)?.color ?? null)
            : null;
          const accentStyle = primaryColor
            ? { boxShadow: `inset 3px 0 0 0 ${primaryColor}` }
            : undefined;

          return (
            <TableRow key={show.showTitle} style={accentStyle}>
              <TableCell>
                <span className="font-medium">{show.showTitle}</span>
              </TableCell>
              {isMultiServer && (
                <TableCell>
                  <div className="flex flex-wrap gap-1">
                    {show.serverIds.map((sid) => {
                      const server = selectedServers.find((s) => s.id === sid);
                      if (!server) return null;
                      return <ServerBadge key={sid} server={server} variant="compact" />;
                    })}
                  </div>
                </TableCell>
              )}
              <TableCell>{show.totalEpisodeWatches}</TableCell>
              <TableCell>
                <div className="flex items-center gap-2">
                  <span>{show.consecutiveEpisodes}</span>
                  <span className="text-muted-foreground text-xs">
                    ({show.consecutivePct.toFixed(0)}%)
                  </span>
                </div>
              </TableCell>
              <TableCell>
                <div className="flex items-center gap-2">
                  <span className="font-medium">{show.bingeScore.toFixed(0)}</span>
                  {getBingeScoreBadge(show.bingeScore)}
                </div>
              </TableCell>
              <TableCell className="text-muted-foreground">{show.maxEpisodesInOneDay}</TableCell>
            </TableRow>
          );
        })}
      </TableBody>
    </Table>
  );
}
