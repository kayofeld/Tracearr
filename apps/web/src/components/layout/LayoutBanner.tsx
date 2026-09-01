import type { ReactNode } from 'react';
import { AlertTriangle } from 'lucide-react';
import { Alert, AlertDescription } from '@/components/ui/alert';

interface LayoutBannerProps {
  variant: 'destructive' | 'warning';
  children: ReactNode;
}

/**
 * Full-width strip under the header. The Alert's own grid keeps the icon on
 * the first line of the copy, so nothing here overrides its layout; the
 * description stretches because callers put their own flex rows inside it.
 */
export function LayoutBanner({ variant, children }: LayoutBannerProps) {
  return (
    <Alert variant={variant} className="rounded-none border-x-0 border-t-0">
      <AlertTriangle />
      <AlertDescription className="justify-items-stretch">{children}</AlertDescription>
    </Alert>
  );
}
