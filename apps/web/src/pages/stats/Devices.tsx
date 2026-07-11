import { useTranslation } from 'react-i18next';
import { Smartphone, Monitor, CheckCircle2, ArrowRightLeft, Users } from 'lucide-react';
import { formatMediaTech } from '@tracearr/shared';
import type { DeviceCompatibilityMatrix } from '@tracearr/shared';
import { Link } from 'react-router';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { StatCard } from '@/components/ui/stat-card';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { TimeRangePicker } from '@/components/ui/time-range-picker';
import { Skeleton } from '@/components/ui/skeleton';
import { Badge } from '@/components/ui/badge';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { InlineErrorState } from '@/components/library/ErrorState';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import {
  useDeviceCompatibility,
  useDeviceCompatibilityMatrix,
  useDeviceHealth,
  useTranscodeHotspots,
  useTopTranscodingUsers,
} from '@/hooks/queries';
import { useServer } from '@/hooks/useServer';
import { useTimeRange } from '@/hooks/useTimeRange';
import { cn } from '@/lib/utils';
import { getAvatarUrl } from '@/components/users/utils';
import { PerServerCardGrid, ServerColumnCell } from '@/components/server';
import type { Server } from '@tracearr/shared';

// Color coding for direct play percentage
function getDirectPlayColor(pct: number): string {
  if (pct >= 80) return 'text-green-600 dark:text-green-400';
  if (pct >= 50) return 'text-yellow-600 dark:text-yellow-400';
  return 'text-red-600 dark:text-red-400';
}

function getDirectPlayBg(pct: number): string {
  if (pct >= 80) return 'bg-green-500/10';
  if (pct >= 50) return 'bg-yellow-500/10';
  return 'bg-red-500/10';
}

function getProgressColor(pct: number): string {
  if (pct >= 80) return 'bg-green-500';
  if (pct >= 50) return 'bg-yellow-500';
  return 'bg-red-500';
}

function getProgressTextColor(pct: number): string {
  if (pct >= 80) return 'text-green-600 dark:text-green-400';
  if (pct >= 50) return 'text-yellow-600 dark:text-yellow-400';
  return 'text-red-600 dark:text-red-400';
}

// Inline matrix renderer driven by pre-fetched data (used by both single and per-server views).
interface MatrixViewProps {
  data: DeviceCompatibilityMatrix | undefined;
  isLoading: boolean;
  error?: Error | null;
  onRetry?: () => void;
}

function MatrixView({ data, isLoading, error, onRetry }: MatrixViewProps) {
  const { t } = useTranslation(['pages', 'common']);

  const sortedMatrixDevices = data?.devices
    ? [...data.devices].sort((a, b) => {
        const aSessions = Object.values(a.codecs).reduce((sum, c) => sum + c.sessions, 0);
        const bSessions = Object.values(b.codecs).reduce((sum, c) => sum + c.sessions, 0);
        return bSessions - aSessions;
      })
    : [];

  const activeCodecs =
    data?.codecs.filter((codec) => sortedMatrixDevices.some((device) => device.codecs[codec])) ??
    [];

  if (error) {
    return (
      <InlineErrorState
        message={error.message ?? t('common:errors.unexpectedError')}
        onRetry={() => onRetry?.()}
      />
    );
  }

  if (isLoading) {
    return (
      <div className="space-y-2">
        {Array.from({ length: 5 }).map((_, i) => (
          <Skeleton key={i} className="h-10 w-full" />
        ))}
      </div>
    );
  }

  if (!data || sortedMatrixDevices.length === 0) {
    return (
      <div className="rounded-xl border border-dashed p-8 text-center">
        <Monitor className="text-muted-foreground/50 mx-auto h-12 w-12" />
        <p className="text-muted-foreground mt-2">{t('devices.noDeviceDataPeriod')}</p>
      </div>
    );
  }

  return (
    <>
      <Table>
        <TableHeader>
          <TableRow className="hover:bg-transparent">
            <TableHead className="bg-background sticky left-0 z-10">
              {t('common:labels.device')}
            </TableHead>
            {activeCodecs.map((codec) => (
              <TableHead key={codec} className="min-w-[80px] text-center">
                {formatMediaTech(codec)}
              </TableHead>
            ))}
          </TableRow>
        </TableHeader>
        <TableBody>
          {sortedMatrixDevices.map((device) => {
            const totalSessions = Object.values(device.codecs).reduce(
              (sum, c) => sum + c.sessions,
              0
            );
            return (
              <TableRow key={device.device} className="hover:bg-transparent">
                <TableCell className="bg-background sticky left-0 z-10 font-medium">
                  <div>{device.device}</div>
                  <div className="text-muted-foreground text-xs">
                    {totalSessions.toLocaleString()} {t('common:labels.sessions').toLowerCase()}
                  </div>
                </TableCell>
                {activeCodecs.map((codec) => {
                  const cell = device.codecs[codec];
                  if (!cell) {
                    return (
                      <TableCell key={codec} className="text-center">
                        <span className="text-muted-foreground/50">-</span>
                      </TableCell>
                    );
                  }
                  return (
                    <TableCell
                      key={codec}
                      className={cn('text-center', getDirectPlayBg(cell.directPct))}
                    >
                      <div className={cn('font-medium', getDirectPlayColor(cell.directPct))}>
                        {cell.directPct}%
                      </div>
                      <div className="text-muted-foreground text-xs">{cell.sessions}</div>
                    </TableCell>
                  );
                })}
              </TableRow>
            );
          })}
        </TableBody>
      </Table>

      {/* Legend */}
      <div className="mt-4 flex items-center gap-4 text-sm">
        <span className="text-muted-foreground">{t('devices.legend')}</span>
        <Badge
          variant="outline"
          className="border-transparent bg-green-500/20 text-green-600 dark:text-green-400"
        >
          {t('devices.directPlayHigh')}
        </Badge>
        <Badge
          variant="outline"
          className="border-transparent bg-yellow-500/20 text-yellow-600 dark:text-yellow-400"
        >
          {t('devices.directPlayMid')}
        </Badge>
        <Badge
          variant="outline"
          className="border-transparent bg-red-500/20 text-red-600 dark:text-red-400"
        >
          {t('devices.directPlayLow')}
        </Badge>
      </div>
    </>
  );
}

export function StatsDevices() {
  const { t } = useTranslation(['pages', 'common']);
  const { value: timeRange, setValue: setTimeRange, apiParams } = useTimeRange();
  const { selectedServerIds, selectedServers, isMultiServer } = useServer();

  const compatibility = useDeviceCompatibility(apiParams, selectedServerIds);
  const matrixResult = useDeviceCompatibilityMatrix(selectedServerIds, apiParams);
  const deviceHealth = useDeviceHealth(apiParams, selectedServerIds);
  const hotspots = useTranscodeHotspots(apiParams, selectedServerIds);
  const topTranscodingUsers = useTopTranscodingUsers(apiParams, selectedServerIds);

  const summary = compatibility.data?.summary;

  // Resolve a Server object by id from selectedServers; returns undefined when id is unknown.
  const resolveServer = (serverId: string): Server | undefined =>
    selectedServers.find((s) => s.id === serverId);

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">{t('devices.title')}</h1>
          <p className="text-muted-foreground text-sm">{t('devices.description')}</p>
        </div>
        <TimeRangePicker value={timeRange} onChange={setTimeRange} />
      </div>

      {/* Summary Cards */}
      {compatibility.isError ? (
        <InlineErrorState
          message={compatibility.error?.message ?? t('common:errors.unexpectedError')}
          onRetry={() => void compatibility.refetch()}
        />
      ) : (
        <div className="grid gap-4 md:grid-cols-4">
          <Tooltip>
            <TooltipTrigger asChild>
              <div tabIndex={0} className="cursor-help">
                <StatCard
                  icon={Smartphone}
                  label={t('devices.analyzedSessions')}
                  value={summary?.totalSessions.toLocaleString() ?? 0}
                  isLoading={compatibility.isLoading}
                />
              </div>
            </TooltipTrigger>
            <TooltipContent>{t('devices.analyzedSessionsTooltip', { count: 5 })}</TooltipContent>
          </Tooltip>
          <StatCard
            icon={CheckCircle2}
            label={t('devices.directPlayRate')}
            value={`${summary?.directPlayPct ?? 0}%`}
            subValue={t('devices.videoAndAudio')}
            isLoading={compatibility.isLoading}
          />
          <StatCard
            icon={Monitor}
            label={t('devices.uniqueDevices')}
            value={summary?.uniqueDevices ?? 0}
            isLoading={compatibility.isLoading}
          />
          <StatCard
            icon={ArrowRightLeft}
            label={t('devices.uniqueCodecs')}
            value={summary?.uniqueCodecs ?? 0}
            isLoading={compatibility.isLoading}
          />
        </div>
      )}

      {/* Device Health + Transcode Hotspots */}
      <div className="grid gap-6 lg:grid-cols-2">
        {/* Device Health Rankings */}
        <Card>
          <CardHeader>
            <CardTitle>{t('devices.deviceHealth')}</CardTitle>
            <CardDescription>{t('devices.deviceHealthDesc')}</CardDescription>
          </CardHeader>
          <CardContent>
            {deviceHealth.isError ? (
              <InlineErrorState
                message={deviceHealth.error?.message ?? t('common:errors.unexpectedError')}
                onRetry={() => void deviceHealth.refetch()}
              />
            ) : deviceHealth.isLoading ? (
              <div className="space-y-4">
                {Array.from({ length: 5 }).map((_, i) => (
                  <Skeleton key={i} className="h-8 w-full" />
                ))}
              </div>
            ) : deviceHealth.data && deviceHealth.data.data.length > 0 ? (
              <div className="space-y-4">
                {deviceHealth.data.data.slice(0, 8).map((device, idx) => {
                  const deviceServer = resolveServer(device.serverId);
                  return (
                    <div key={`${device.device}-${idx}`} className="space-y-1">
                      <div className="flex items-center justify-between text-sm">
                        <div className="flex min-w-0 flex-1 items-center gap-2">
                          <span
                            className="max-w-[150px] truncate font-medium"
                            title={device.device}
                          >
                            {device.device}
                          </span>
                          {isMultiServer && deviceServer && (
                            <ServerColumnCell server={deviceServer} />
                          )}
                        </div>
                        <div className="flex items-center gap-2">
                          <span className="text-muted-foreground text-xs">
                            {device.sessions.toLocaleString()}{' '}
                            {t('common:labels.sessions').toLowerCase()}
                          </span>
                          <span
                            className={cn(
                              'font-semibold',
                              getProgressTextColor(device.directPlayPct)
                            )}
                          >
                            {device.directPlayPct}%
                          </span>
                        </div>
                      </div>
                      <div className="bg-muted relative h-2 w-full overflow-hidden rounded-full">
                        <div
                          className={cn(
                            'absolute inset-y-0 left-0 rounded-full',
                            getProgressColor(device.directPlayPct)
                          )}
                          style={{ width: `${device.directPlayPct}%` }}
                        />
                      </div>
                    </div>
                  );
                })}
              </div>
            ) : (
              <div className="rounded-xl border border-dashed p-8 text-center">
                <Monitor className="text-muted-foreground/50 mx-auto h-12 w-12" />
                <p className="text-muted-foreground mt-2">{t('common:empty.noDeviceData')}</p>
              </div>
            )}
          </CardContent>
        </Card>

        {/* Transcode Hotspots */}
        <Card>
          <CardHeader>
            <CardTitle>{t('devices.transcodeHotspots')}</CardTitle>
            <CardDescription>{t('devices.transcodeHotspotsDesc')}</CardDescription>
          </CardHeader>
          <CardContent>
            {hotspots.isError ? (
              <InlineErrorState
                message={hotspots.error?.message ?? t('common:errors.unexpectedError')}
                onRetry={() => void hotspots.refetch()}
              />
            ) : hotspots.isLoading ? (
              <div className="space-y-2">
                {Array.from({ length: 5 }).map((_, i) => (
                  <Skeleton key={i} className="h-12 w-full" />
                ))}
              </div>
            ) : hotspots.data && hotspots.data.data.length > 0 ? (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>{t('devices.deviceAndCodec')}</TableHead>
                    {isMultiServer && <TableHead>{t('common:labels.server')}</TableHead>}
                    <TableHead className="text-right">{t('devices.transcodes')}</TableHead>
                    <TableHead className="text-right">{t('devices.pctOfTotal')}</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {hotspots.data.data.slice(0, 5).map((hotspot, idx) => {
                    const hotspotServer = resolveServer(hotspot.serverId);
                    return (
                      <TableRow
                        key={`${hotspot.device}-${hotspot.videoCodec}-${hotspot.audioCodec}-${idx}`}
                      >
                        <TableCell>
                          <div className="font-medium">{hotspot.device}</div>
                          <div className="text-muted-foreground text-xs">
                            {formatMediaTech(hotspot.videoCodec)} +{' '}
                            {formatMediaTech(hotspot.audioCodec)}
                          </div>
                        </TableCell>
                        {isMultiServer && (
                          <TableCell>
                            {hotspotServer && <ServerColumnCell server={hotspotServer} />}
                          </TableCell>
                        )}
                        <TableCell className="text-right font-mono">
                          {hotspot.transcodeCount.toLocaleString()}
                        </TableCell>
                        <TableCell className="text-right">
                          <Badge
                            variant="destructive"
                            className="border-orange-500/30 bg-orange-500/20 text-orange-600 dark:text-orange-400"
                          >
                            {hotspot.pctOfTotalTranscodes}%
                          </Badge>
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            ) : (
              <div className="rounded-xl border border-dashed p-8 text-center">
                <CheckCircle2 className="mx-auto h-12 w-12 text-green-500/50" />
                <p className="text-muted-foreground mt-2">{t('devices.noTranscodeHotspots')}</p>
              </div>
            )}
          </CardContent>
        </Card>
      </div>

      {/* Matrix View */}
      <Card>
        <CardHeader>
          <CardTitle>{t('devices.compatibilityMatrix')}</CardTitle>
          <CardDescription>{t('devices.compatibilityMatrixDesc')}</CardDescription>
        </CardHeader>
        <CardContent>
          {isMultiServer ? (
            <PerServerCardGrid
              servers={selectedServers}
              renderServer={(server) => {
                const result = matrixResult.byServer.get(server.id);
                return (
                  <MatrixView
                    data={result?.data}
                    isLoading={result?.isLoading ?? matrixResult.isLoading}
                    error={result?.error}
                    onRetry={() => void result?.refetch()}
                  />
                );
              }}
            />
          ) : (
            <MatrixView
              data={matrixResult.byServer.get(selectedServerIds[0] ?? '')?.data}
              isLoading={matrixResult.isLoading}
              error={matrixResult.byServer.get(selectedServerIds[0] ?? '')?.error}
              onRetry={() => void matrixResult.byServer.get(selectedServerIds[0] ?? '')?.refetch()}
            />
          )}
        </CardContent>
      </Card>

      {/* Top Transcoding Users */}
      <Card>
        <CardHeader>
          <CardTitle>{t('devices.topTranscodingUsers')}</CardTitle>
          <CardDescription>{t('devices.topTranscodingUsersDesc')}</CardDescription>
        </CardHeader>
        <CardContent>
          {topTranscodingUsers.isError ? (
            <InlineErrorState
              message={topTranscodingUsers.error?.message ?? t('common:errors.unexpectedError')}
              onRetry={() => void topTranscodingUsers.refetch()}
            />
          ) : topTranscodingUsers.isLoading ? (
            <div className="space-y-2">
              {Array.from({ length: 5 }).map((_, i) => (
                <Skeleton key={i} className="h-12 w-full" />
              ))}
            </div>
          ) : topTranscodingUsers.data && topTranscodingUsers.data.data.length > 0 ? (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t('common:labels.user')}</TableHead>
                  {isMultiServer && <TableHead>{t('common:labels.server')}</TableHead>}
                  <TableHead className="text-right">{t('common:labels.sessions')}</TableHead>
                  <TableHead className="text-right">{t('common:playback.directPlay')}</TableHead>
                  <TableHead className="text-right">{t('devices.transcodes')}</TableHead>
                  <TableHead className="text-right">{t('devices.pctOfTotal')}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {topTranscodingUsers.data.data.map((user) => {
                  const userServer = resolveServer(user.serverId);
                  return (
                    <TableRow key={`${user.serverUserId}-${user.serverId}`}>
                      <TableCell>
                        <Link
                          to={`/users/${user.serverUserId}`}
                          className="flex items-center gap-3 hover:underline"
                        >
                          <Avatar className="h-8 w-8">
                            <AvatarImage
                              src={getAvatarUrl(user.serverId, user.avatar, 32) ?? undefined}
                              alt={user.username}
                            />
                            <AvatarFallback>
                              {(user.identityName ?? user.username).slice(0, 2).toUpperCase()}
                            </AvatarFallback>
                          </Avatar>
                          <span className="font-medium">{user.identityName ?? user.username}</span>
                        </Link>
                      </TableCell>
                      {isMultiServer && (
                        <TableCell>
                          {userServer && <ServerColumnCell server={userServer} />}
                        </TableCell>
                      )}
                      <TableCell className="text-muted-foreground text-right">
                        {user.totalSessions.toLocaleString()}
                      </TableCell>
                      <TableCell className="text-right">
                        <Badge
                          variant="outline"
                          className={cn(
                            'border-transparent',
                            user.directPlayPct >= 80
                              ? 'bg-green-500/20 text-green-600 dark:text-green-400'
                              : user.directPlayPct >= 50
                                ? 'bg-yellow-500/20 text-yellow-600 dark:text-yellow-400'
                                : 'bg-red-500/20 text-red-600 dark:text-red-400'
                          )}
                        >
                          {user.directPlayPct}%
                        </Badge>
                      </TableCell>
                      <TableCell className="text-right font-mono text-orange-600 dark:text-orange-400">
                        {user.transcodeCount.toLocaleString()}
                      </TableCell>
                      <TableCell className="text-right">
                        <Badge
                          variant="destructive"
                          className="border-orange-500/30 bg-orange-500/20 text-orange-600 dark:text-orange-400"
                        >
                          {user.pctOfTotalTranscodes}%
                        </Badge>
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          ) : (
            <div className="rounded-xl border border-dashed p-8 text-center">
              <Users className="text-muted-foreground/50 mx-auto h-12 w-12" />
              <p className="text-muted-foreground mt-2">{t('devices.noTranscodingUsers')}</p>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
