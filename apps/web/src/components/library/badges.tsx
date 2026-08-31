import { Film, Tv, Music } from 'lucide-react';
import { Badge } from '@/components/ui/badge';

/**
 * Get binge score badge based on score thresholds.
 */
export function getBingeScoreBadge(score: number) {
  if (score >= 80) return <Badge variant="danger">Highly Addictive</Badge>;
  if (score >= 60) return <Badge variant="warning">Addictive</Badge>;
  if (score >= 40) return <Badge variant="secondary">Bingeable</Badge>;
  return <Badge variant="outline">Casual Watch</Badge>;
}

/**
 * Get completion rate badge based on percentage.
 */
export function getCompletionBadge(rate: number) {
  if (rate >= 80) return <Badge variant="success">{rate.toFixed(0)}%</Badge>;
  if (rate >= 50) return <Badge variant="secondary">{rate.toFixed(0)}%</Badge>;
  if (rate >= 20) return <Badge variant="warning">{rate.toFixed(0)}%</Badge>;
  return <Badge variant="outline">{rate.toFixed(0)}%</Badge>;
}

/**
 * Badge component for media type (Movie, TV, Music)
 */
export function MediaTypeBadge({ mediaType }: { mediaType: string }) {
  switch (mediaType) {
    case 'movie':
      return (
        <Badge variant="secondary" className="gap-1">
          <Film className="h-3 w-3" />
          Movie
        </Badge>
      );
    case 'show':
      return (
        <Badge variant="secondary" className="gap-1 bg-blue-500/10 text-blue-500">
          <Tv className="h-3 w-3" />
          TV
        </Badge>
      );
    case 'artist':
      return (
        <Badge variant="secondary" className="gap-1 bg-purple-500/10 text-purple-500">
          <Music className="h-3 w-3" />
          Music
        </Badge>
      );
    default:
      return null;
  }
}
