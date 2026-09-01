import { ExternalLink } from 'lucide-react';
import { Button } from '@/components/ui/button';

/** The gallery is a docs page and a repository; Tracearr reads neither. */
export const GALLERY_URL = 'https://docs.tracearr.com/templates';
export const REPOSITORY_URL = 'https://github.com/Tracearr/automation-templates';

/** A page outside Tracearr, opened in its own tab. */
export function LinkOut({ href, label }: { href: string; label: string }) {
  return (
    <Button asChild variant="link" size="sm">
      <a href={href} target="_blank" rel="noopener noreferrer">
        {label}
        <ExternalLink />
      </a>
    </Button>
  );
}
