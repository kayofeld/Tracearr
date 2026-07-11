import { useTranslation } from 'react-i18next';
import { Users as UsersIcon, Merge } from 'lucide-react';
import type { MergeSuggestion } from '@tracearr/shared';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { ServerColumnCell } from '@/components/server';
import { RemovedBadge } from './RemovedBadge';
import { useMergeSuggestions } from '@/hooks/queries';

type SuggestionIdentity = MergeSuggestion['users'][number];

function IdentityGroup({ identity }: { identity: SuggestionIdentity }) {
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <span className="truncate text-sm font-medium">{identity.name ?? identity.username}</span>
      <div className="flex flex-wrap items-center gap-1">
        {identity.serverUsers.map((serverUser) => (
          <span key={serverUser.id} className="flex items-center gap-1">
            <ServerColumnCell server={{ id: serverUser.serverId, name: serverUser.serverName }} />
            {serverUser.removedAt && <RemovedBadge removedAt={serverUser.removedAt} />}
          </span>
        ))}
      </div>
    </div>
  );
}

interface MergeSuggestionsBannerProps {
  onReview: (suggestion: MergeSuggestion) => void;
}

const HEADING_ID = 'merge-suggestions-heading';

export function MergeSuggestionsBanner({ onReview }: MergeSuggestionsBannerProps) {
  const { t } = useTranslation(['pages']);
  const { data, isLoading, isError } = useMergeSuggestions(true);

  if (isLoading) return null;
  if (isError) {
    return <p className="text-muted-foreground text-sm">{t('pages:users.suggestionsError')}</p>;
  }
  if (!data || data.length === 0) return null;

  return (
    <Card role="region" aria-labelledby={HEADING_ID}>
      <CardHeader>
        <CardTitle id={HEADING_ID} className="flex items-center gap-2 text-base">
          <UsersIcon className="h-4 w-4" aria-hidden="true" />
          {t('pages:users.suggestionsTitle')}
        </CardTitle>
        <CardDescription>{t('pages:users.suggestionsDescription')}</CardDescription>
      </CardHeader>
      <CardContent>
        <ul aria-labelledby={HEADING_ID} className="list-none space-y-2" role="list">
          {data.map((suggestion) => {
            const [firstUser, secondUser] = suggestion.users;
            const reasonLabel =
              suggestion.matchType === 'email'
                ? t('pages:users.suggestionsMatchEmail')
                : t('pages:users.suggestionsMatchUsername');
            return (
              <li
                key={`${firstUser.userId}:${secondUser.userId}`}
                role="listitem"
                className="flex flex-col gap-3 rounded-md border p-3 sm:flex-row sm:items-center sm:justify-between"
              >
                <div className="flex flex-1 flex-col gap-2 sm:flex-row sm:items-center sm:gap-4">
                  <p className="text-muted-foreground shrink-0 text-xs">
                    {reasonLabel}:{' '}
                    <span className="text-foreground font-medium">{suggestion.matchValue}</span>
                  </p>
                  <div className="flex flex-1 flex-wrap items-center gap-2 sm:gap-3">
                    <IdentityGroup identity={firstUser} />
                    <Merge
                      className="text-muted-foreground h-4 w-4 shrink-0 rotate-90 sm:rotate-0"
                      aria-hidden="true"
                    />
                    <IdentityGroup identity={secondUser} />
                  </div>
                </div>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => onReview(suggestion)}
                  className="shrink-0"
                >
                  {t('pages:users.suggestionsReview')}
                </Button>
              </li>
            );
          })}
        </ul>
      </CardContent>
    </Card>
  );
}
