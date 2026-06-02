import { useState, useMemo, useCallback } from 'react';
import { useParams, Link } from 'react-router';
import { useTranslation } from 'react-i18next';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { DataTable } from '@/components/ui/data-table';
import { TrustScoreBadge } from '@/components/users/TrustScoreBadge';
import { UserLocationsCard } from '@/components/users/UserLocationsCard';
import { UserDevicesCard } from '@/components/users/UserDevicesCard';
import { EditUserNameDialog } from '@/components/users/EditUserNameDialog';
import { EditTrustScoreDialog } from '@/components/users/EditTrustScoreDialog';
import { SessionDetailSheet } from '@/components/history/SessionDetailSheet';
import { HistoryTable } from '@/components/history/HistoryTable';
import type { ColumnVisibility } from '@/components/history/HistoryFilters';
import { SeverityBadge } from '@/components/violations/SeverityBadge';
import { getAvatarUrl } from '@/components/users/utils';
import { getMediaDisplay } from '@/lib/utils';
import { api } from '@/lib/api';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { Button } from '@/components/ui/button';
import {
  User as UserIcon,
  Crown,
  ArrowLeft,
  Play,
  Clock,
  AlertTriangle,
  XCircle,
  Bot,
  Pencil,
} from 'lucide-react';
import { formatDistanceToNow, format } from 'date-fns';
import type { ColumnDef } from '@tanstack/react-table';
import type {
  SessionWithDetails,
  ViolationSummary,
  ViolationWithDetails,
  TerminationLogWithDetails,
} from '@tracearr/shared';
import { useUserFull, useUserSessions, useViolations, useUserTerminations } from '@/hooks/queries';
import { useServer } from '@/hooks/useServer';
import { useAuth } from '@/hooks/useAuth';

// Union type for violations - aggregate returns ViolationSummary, paginated returns ViolationWithDetails
type ViolationRow = ViolationSummary | ViolationWithDetails;

export function UserDetail() {
  const { t } = useTranslation(['pages', 'common']);
  const { id } = useParams<{ id: string }>();
  const [sessionsPage, setSessionsPage] = useState(1);
  const [violationsPage, setViolationsPage] = useState(1);
  const [terminationsPage, setTerminationsPage] = useState(1);
  const [isEditNameOpen, setIsEditNameOpen] = useState(false);
  const [isEditTrustOpen, setIsEditTrustOpen] = useState(false);
  const [selectedSession, setSelectedSession] = useState<SessionWithDetails | null>(null);
  const pageSize = 10;
  const { selectedServerId, servers } = useServer();
  const { user: authUser } = useAuth();
  const isOwner = authUser?.role === 'owner';

  // Column visibility for the sessions HistoryTable (hide user since we're scoped to one)
  const sessionColumnVisibility: ColumnVisibility = useMemo(
    () => ({
      date: true,
      user: false,
      content: true,
      server: false,
      platform: true,
      location: true,
      ip: false,
      quality: true,
      duration: true,
      progress: true,
    }),
    []
  );

  const handleSessionClick = useCallback(async (session: SessionWithDetails) => {
    try {
      const full = await api.sessions.get(session.id);
      setSelectedSession(full);
    } catch {
      setSelectedSession(session);
    }
  }, []);

  const violationColumns: ColumnDef<ViolationRow>[] = useMemo(
    () => [
      {
        accessorKey: 'rule.name',
        header: t('common:labels.rule'),
        cell: ({ row }) => (
          <div>
            <p className="font-medium">{row.original.rule.name}</p>
            <p className="text-muted-foreground text-xs capitalize">
              {row.original.rule.type?.replace(/_/g, ' ') ?? t('rules.customRule')}
            </p>
          </div>
        ),
      },
      {
        accessorKey: 'severity',
        header: t('common:labels.severity'),
        cell: ({ row }) => (
          <SeverityBadge severity={row.original.severity as 'low' | 'warning' | 'high'} />
        ),
      },
      {
        accessorKey: 'createdAt',
        header: t('common:labels.when'),
        cell: ({ row }) => (
          <span className="text-muted-foreground text-sm">
            {formatDistanceToNow(new Date(row.original.createdAt), { addSuffix: true })}
          </span>
        ),
      },
      {
        accessorKey: 'acknowledgedAt',
        header: t('common:labels.status'),
        cell: ({ row }) => (
          <span
            className={
              row.original.acknowledgedAt ? 'text-muted-foreground' : 'font-medium text-yellow-500'
            }
          >
            {row.original.acknowledgedAt
              ? t('common:states.acknowledged')
              : t('common:states.pending')}
          </span>
        ),
      },
    ],
    [t]
  );

  const terminationColumns: ColumnDef<TerminationLogWithDetails>[] = useMemo(
    () => [
      {
        accessorKey: 'trigger',
        header: t('common:labels.type'),
        cell: ({ row }) => (
          <Badge variant={row.original.trigger === 'manual' ? 'default' : 'secondary'}>
            {row.original.trigger === 'manual' ? (
              <>
                <UserIcon className="mr-1 h-3 w-3" />
                {t('pages:userDetail.manual')}
              </>
            ) : (
              <>
                <Bot className="mr-1 h-3 w-3" />
                {t('common:labels.rule')}
              </>
            )}
          </Badge>
        ),
      },
      {
        accessorKey: 'mediaTitle',
        header: t('common:labels.media'),
        cell: ({ row }) => {
          const { title, subtitle } = getMediaDisplay(row.original);
          return (
            <div className="max-w-[200px]">
              <p className="truncate font-medium">{title || '—'}</p>
              {subtitle ? (
                <p className="text-muted-foreground text-xs">{subtitle}</p>
              ) : (
                <p className="text-muted-foreground text-xs capitalize">
                  {row.original.mediaType ?? t('common:labels.unknown').toLowerCase()}
                </p>
              )}
            </div>
          );
        },
      },
      {
        accessorKey: 'createdAt',
        header: t('common:labels.when'),
        cell: ({ row }) => (
          <span className="text-muted-foreground text-sm">
            {formatDistanceToNow(new Date(row.original.createdAt), { addSuffix: true })}
          </span>
        ),
      },
      {
        accessorKey: 'triggeredByUsername',
        header: t('pages:userDetail.byRule'),
        cell: ({ row }) => {
          const log = row.original;
          if (log.trigger === 'manual') {
            return (
              <span className="text-sm">
                @{log.triggeredByUsername ?? t('common:labels.unknown')}
              </span>
            );
          }
          return (
            <span className="text-muted-foreground text-sm">
              {log.ruleName ?? t('pages:userDetail.unknownRule')}
            </span>
          );
        },
      },
      {
        accessorKey: 'reason',
        header: t('common:labels.reason'),
        cell: ({ row }) => (
          <span className="text-muted-foreground block max-w-[150px] truncate text-sm">
            {row.original.reason ?? '—'}
          </span>
        ),
      },
      {
        accessorKey: 'success',
        header: t('common:labels.status'),
        cell: ({ row }) => (
          <span className={row.original.success ? 'text-green-500' : 'font-medium text-red-500'}>
            {row.original.success ? t('common:states.success') : t('common:states.failed')}
          </span>
        ),
      },
    ],
    [t]
  );

  // Use the aggregate endpoint for initial load (1 request instead of 6)
  const { data: fullData, isLoading } = useUserFull(id!);

  // Only fetch paginated data when user navigates beyond first page
  const { data: paginatedSessions, isLoading: paginatedSessionsLoading } = useUserSessions(
    id!,
    { page: sessionsPage, pageSize }
    // Only enable when on page > 1 (first page data comes from aggregate)
  );
  const needsPaginatedSessions = sessionsPage > 1;

  const { data: paginatedViolations, isLoading: paginatedViolationsLoading } = useViolations({
    userId: id,
    page: violationsPage,
    pageSize,
    serverId: selectedServerId ?? undefined,
  });
  const needsPaginatedViolations = violationsPage > 1;

  const { data: paginatedTerminations, isLoading: paginatedTerminationsLoading } =
    useUserTerminations(id!, { page: terminationsPage, pageSize });
  const needsPaginatedTerminations = terminationsPage > 1;

  // Extract data from aggregate or paginated sources
  const user = fullData?.user;
  const locations = fullData?.locations ?? [];
  const devices = fullData?.devices ?? [];

  // Sessions: use paginated data if on page > 1, otherwise use aggregate
  const rawSessions = needsPaginatedSessions
    ? (paginatedSessions?.data ?? [])
    : (fullData?.sessions.data ?? []);

  // Map Session → SessionWithDetails for HistoryTable compatibility
  const sessions: SessionWithDetails[] = useMemo(() => {
    if (!user) return [];
    const server = servers.find((s) => s.id === user.serverId);
    return rawSessions.map((s) => ({
      ...s,
      user: {
        id: user.id,
        username: user.username,
        thumbUrl: user.thumbUrl,
        identityName: user.identityName ?? null,
      },
      server: {
        id: user.serverId,
        name: user.serverName ?? '',
        type: server?.type ?? 'plex',
      },
    }));
  }, [rawSessions, user, servers]);

  const sessionsTotal = needsPaginatedSessions
    ? (paginatedSessions?.total ?? fullData?.sessions.total ?? 0)
    : (fullData?.sessions.total ?? 0);
  const sessionsTotalPages = Math.ceil(sessionsTotal / pageSize);
  const sessionsLoading = needsPaginatedSessions ? paginatedSessionsLoading : isLoading;

  // Violations: use paginated data if on page > 1, otherwise use aggregate
  const violations: ViolationRow[] = needsPaginatedViolations
    ? (paginatedViolations?.data ?? [])
    : (fullData?.violations.data ?? []);
  const violationsTotal = needsPaginatedViolations
    ? (paginatedViolations?.total ?? fullData?.violations.total ?? 0)
    : (fullData?.violations.total ?? 0);
  const violationsTotalPages = Math.ceil(violationsTotal / pageSize);
  const violationsLoading = needsPaginatedViolations ? paginatedViolationsLoading : isLoading;

  // Terminations: use paginated data if on page > 1, otherwise use aggregate
  const terminations = needsPaginatedTerminations
    ? (paginatedTerminations?.data ?? [])
    : (fullData?.terminations.data ?? []);
  const terminationsTotal = needsPaginatedTerminations
    ? (paginatedTerminations?.total ?? fullData?.terminations.total ?? 0)
    : (fullData?.terminations.total ?? 0);
  const terminationsTotalPages = Math.ceil(terminationsTotal / pageSize);
  const terminationsLoading = needsPaginatedTerminations ? paginatedTerminationsLoading : isLoading;

  if (isLoading) {
    return (
      <div className="space-y-6">
        <Skeleton className="h-8 w-48" />
        <div className="grid gap-6 lg:grid-cols-2">
          <Card>
            <CardContent className="pt-6">
              <div className="flex items-center gap-4">
                <Skeleton className="h-16 w-16 rounded-full" />
                <div className="space-y-2">
                  <Skeleton className="h-6 w-32" />
                  <Skeleton className="h-4 w-24" />
                </div>
              </div>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="pt-6">
              <div className="grid grid-cols-2 gap-4">
                {[...Array(4)].map((_, i) => (
                  <Skeleton key={i} className="h-16" />
                ))}
              </div>
            </CardContent>
          </Card>
        </div>
      </div>
    );
  }

  if (!user) {
    return (
      <div className="space-y-6">
        <Link to="/users">
          <Button variant="ghost" size="sm">
            <ArrowLeft className="mr-2 h-4 w-4" />
            {t('userDetail.backToUsers')}
          </Button>
        </Link>
        <Card>
          <CardContent className="flex h-32 items-center justify-center">
            <p className="text-muted-foreground">{t('userDetail.userNotFound')}</p>
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-4">
        <Link to="/users">
          <Button variant="ghost" size="sm">
            <ArrowLeft className="mr-2 h-4 w-4" />
            {t('common:actions.back')}
          </Button>
        </Link>
        <h1 className="text-3xl font-bold">{user.identityName ?? user.username}</h1>
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        {/* User Info Card */}
        <Card>
          <CardHeader>
            <CardTitle>{t('userDetail.userInfo')}</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="flex items-start gap-4">
              <div className="bg-muted flex h-16 w-16 items-center justify-center rounded-full">
                {(() => {
                  const avatarUrl = getAvatarUrl(user.serverId, user.thumbUrl, 64);
                  return avatarUrl ? (
                    <img
                      src={avatarUrl}
                      alt={user.username}
                      className="h-16 w-16 rounded-full object-cover"
                    />
                  ) : (
                    <UserIcon className="text-muted-foreground h-8 w-8" />
                  );
                })()}
              </div>
              <div className="flex flex-1 items-start justify-between gap-6">
                <div className="space-y-2">
                  <div className="flex items-center gap-2">
                    <h2 className="text-xl font-semibold">{user.identityName ?? user.username}</h2>
                    {isOwner && (
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-7 w-7"
                        onClick={() => setIsEditNameOpen(true)}
                      >
                        <Pencil className="h-4 w-4" />
                      </Button>
                    )}
                    {user.role === 'owner' && (
                      <span title={t('common:labels.serverOwner')}>
                        <Crown className="h-5 w-5 text-yellow-500" />
                      </span>
                    )}
                  </div>
                  <p className="text-muted-foreground text-sm">@{user.username}</p>
                  {user.email && <p className="text-muted-foreground text-sm">{user.email}</p>}
                  <div className="flex items-center gap-4 pt-2">
                    <TrustScoreBadge score={user.trustScore} showLabel />
                  </div>
                  {isOwner && (
                    <Button
                      variant="outline"
                      size="sm"
                      className="mt-3 w-fit"
                      onClick={() => setIsEditTrustOpen(true)}
                    >
                      <Pencil className="mr-2 h-3.5 w-3.5" />
                      {t('userDetail.adjustTrustScore')}
                    </Button>
                  )}
                </div>
                <div className="text-muted-foreground flex flex-col gap-2 text-right text-sm">
                  <div className="flex items-center gap-2">
                    <Clock className="h-4 w-4" />
                    <span className="text-foreground font-medium">{t('common:labels.joined')}</span>
                    <span>{format(new Date(user.joinedAt ?? user.createdAt), 'MMM d, yyyy')}</span>
                  </div>
                  <div className="flex items-center gap-2">
                    <Clock className="h-4 w-4" />
                    <span className="text-foreground font-medium">
                      {t('common:labels.lastActivity')}
                    </span>
                    <span>
                      {user.lastActivityAt
                        ? format(new Date(user.lastActivityAt), 'MMM d, yyyy')
                        : '—'}
                    </span>
                  </div>
                </div>
              </div>
            </div>
          </CardContent>
        </Card>

        {/* Stats Card */}
        <Card>
          <CardHeader>
            <CardTitle>{t('pages:userDetail.statistics')}</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="grid grid-cols-2 gap-4">
              <div className="rounded-lg border p-4">
                <div className="flex items-center gap-2">
                  <Play className="text-muted-foreground h-4 w-4" />
                  <span className="text-muted-foreground text-sm">
                    {t('pages:userDetail.sessions')}
                  </span>
                </div>
                <p className="mt-1 text-2xl font-bold">{user.stats.totalSessions}</p>
              </div>
              <div className="rounded-lg border p-4">
                <div className="flex items-center gap-2">
                  <AlertTriangle className="text-muted-foreground h-4 w-4" />
                  <span className="text-muted-foreground text-sm">
                    {t('pages:userDetail.violations')}
                  </span>
                </div>
                <p className="mt-1 text-2xl font-bold">{violationsTotal}</p>
              </div>
              <div className="rounded-lg border p-4">
                <div className="flex items-center gap-2">
                  <span className="text-muted-foreground text-sm">
                    {t('common:labels.trustScore')}
                  </span>
                </div>
                <div className="mt-1 flex items-center gap-2">
                  <span className="text-2xl font-bold">{user.trustScore}</span>
                  <span className="text-muted-foreground text-sm">/ 100</span>
                </div>
              </div>
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Locations and Devices */}
      <div className="grid gap-6 lg:grid-cols-2">
        <UserLocationsCard
          locations={locations}
          isLoading={isLoading}
          totalSessions={sessionsTotal}
        />
        <UserDevicesCard devices={devices} isLoading={isLoading} totalSessions={sessionsTotal} />
      </div>

      {/* Recent Sessions */}
      <Card>
        <CardHeader>
          <CardTitle>{t('common:labels.recentSessions')}</CardTitle>
        </CardHeader>
        <CardContent>
          <HistoryTable
            sessions={sessions}
            isLoading={sessionsLoading}
            onSessionClick={handleSessionClick}
            columnVisibility={sessionColumnVisibility}
          />
          {sessionsTotalPages > 1 && (
            <div className="mt-4 flex items-center justify-end gap-2">
              <Button
                variant="outline"
                size="sm"
                onClick={() => setSessionsPage((p) => Math.max(1, p - 1))}
                disabled={sessionsPage <= 1}
              >
                {t('common:actions.previous')}
              </Button>
              <span className="text-muted-foreground text-sm">
                {sessionsPage} / {sessionsTotalPages}
              </span>
              <Button
                variant="outline"
                size="sm"
                onClick={() => setSessionsPage((p) => Math.min(sessionsTotalPages, p + 1))}
                disabled={sessionsPage >= sessionsTotalPages}
              >
                {t('common:actions.next')}
              </Button>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Violations */}
      <Card>
        <CardHeader>
          <CardTitle>{t('userDetail.violations')}</CardTitle>
        </CardHeader>
        <CardContent>
          <DataTable
            columns={violationColumns}
            data={violations}
            pageSize={pageSize}
            pageCount={violationsTotalPages}
            page={violationsPage}
            onPageChange={setViolationsPage}
            isLoading={violationsLoading}
            isServerFiltered
            emptyMessage={t('userDetail.noViolationsFound')}
          />
        </CardContent>
      </Card>

      {/* Termination History */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <XCircle className="h-5 w-5" />
            {t('userDetail.terminationHistory')}
          </CardTitle>
        </CardHeader>
        <CardContent>
          <DataTable
            columns={terminationColumns}
            data={terminations}
            pageSize={pageSize}
            pageCount={terminationsTotalPages}
            page={terminationsPage}
            onPageChange={setTerminationsPage}
            isLoading={terminationsLoading}
            isServerFiltered
            emptyMessage={t('userDetail.noTerminationsFound')}
          />
        </CardContent>
      </Card>

      {/* Edit Display Name Dialog */}
      <EditUserNameDialog
        open={isEditNameOpen}
        onOpenChange={setIsEditNameOpen}
        userId={id!}
        currentName={user.identityName}
        username={user.username}
      />

      {/* Edit Trust Score Dialog */}
      <EditTrustScoreDialog
        open={isEditTrustOpen}
        onOpenChange={setIsEditTrustOpen}
        userId={id!}
        currentScore={user.trustScore}
        username={user.username}
      />

      {/* Session Detail Sheet */}
      <SessionDetailSheet
        session={selectedSession}
        open={!!selectedSession}
        onOpenChange={(open) => {
          if (!open) setSelectedSession(null);
        }}
      />
    </div>
  );
}
