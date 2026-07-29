import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { NotificationEventType } from '@tracearr/shared';
import { Plus } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useSettings, useUpdateSettings } from '@/hooks/queries/useSettings';
import { useChannelRouting, useUpdateChannelRouting } from '@/hooks/queries/useChannelRouting';
import type { RoutingChannel, NotificationAgentType } from './types';
import { useActiveAgents, useAddableAgents } from './useActiveAgents';
import { AgentCard } from './AgentCard';
import { AddAgentDialog } from './AddAgentDialog';
import { EditAgentDialog } from './EditAgentDialog';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { AGENT_CONFIGS, CUSTOM_WEBHOOK_AGENTS } from './agent-config';
import { api } from '@/lib/api';
import { toast } from 'sonner';

export function NotificationAgentsManager() {
  const { t } = useTranslation(['notifications', 'pages', 'common']);
  const { data: settings, isLoading: settingsLoading } = useSettings();
  const { data: routingData, isLoading: routingLoading } = useChannelRouting();
  const updateSettings = useUpdateSettings({ silent: true });
  const updateRouting = useUpdateChannelRouting();

  // Dialog states
  const [addDialogOpen, setAddDialogOpen] = useState(false);
  const [editingAgent, setEditingAgent] = useState<NotificationAgentType | null>(null);
  const [removingAgent, setRemovingAgent] = useState<NotificationAgentType | null>(null);
  const [testingAgent, setTestingAgent] = useState<NotificationAgentType | null>(null);

  // Derive agents from settings
  const activeAgents = useActiveAgents(settings);
  const { discord, webhookAgents, activeWebhookAgent } = useAddableAgents(activeAgents);
  const hasAddableAgents = discord !== null || webhookAgents.length > 0;

  const isLoading = settingsLoading || routingLoading;

  // Map routing channel to the appropriate update field
  const handleToggleEvent = (
    eventType: NotificationEventType,
    channel: RoutingChannel,
    enabled: boolean
  ) => {
    const updateData: Parameters<typeof updateRouting.mutate>[0] = { eventType };

    switch (channel) {
      case 'webToast':
        updateData.webToastEnabled = enabled;
        break;
      case 'discord':
        updateData.discordEnabled = enabled;
        break;
      case 'webhook':
        updateData.webhookEnabled = enabled;
        break;
      case 'push':
        updateData.pushEnabled = enabled;
        break;
    }

    updateRouting.mutate(updateData);
  };

  const handleRemoveAgent = async () => {
    if (!removingAgent) return;

    const config = AGENT_CONFIGS[removingAgent];
    if (!config) return;

    // Build update to clear this agent's settings
    const clearData: Record<string, null> = {};

    if (removingAgent === 'discord') {
      clearData.discordWebhookUrl = null;
    } else if (CUSTOM_WEBHOOK_AGENTS.includes(removingAgent)) {
      // Clear custom webhook settings
      clearData.customWebhookUrl = null;
      clearData.webhookFormat = null;

      // Clear agent-specific fields
      if (removingAgent === 'ntfy') {
        clearData.ntfyTopic = null;
        clearData.ntfyAuthToken = null;
      } else if (removingAgent === 'pushover') {
        clearData.pushoverUserKey = null;
        clearData.pushoverApiToken = null;
      } else if (removingAgent === 'telegram') {
        // Telegram doesn't use customWebhookUrl - clear its own secret + chat id
        // so removing the agent doesn't leave the bot token lingering in settings.
        clearData.telegramBotToken = null;
        clearData.telegramChatId = null;
      }
    }

    try {
      await updateSettings.mutateAsync(clearData);
      toast.success(t('toast.success.agentRemoved.title'), {
        description: t('toast.success.agentRemoved.message'),
      });
    } catch {
      toast.error(t('toast.error.agentRemoveFailed'));
    } finally {
      setRemovingAgent(null);
    }
  };

  const handleTestAgent = async (agentType: NotificationAgentType) => {
    if (!settings) return;

    setTestingAgent(agentType);

    try {
      let result: { success: boolean; error?: string };

      if (agentType === 'discord') {
        result = await api.settings.testWebhook({
          type: 'discord',
        });
      } else if (CUSTOM_WEBHOOK_AGENTS.includes(agentType)) {
        result = await api.settings.testWebhook({
          type: 'custom',
          format: settings.webhookFormat ?? undefined,
        });
      } else {
        throw new Error('Test not supported for this agent type');
      }

      if (result.success) {
        toast.success(t('toast.success.webhookTest.title'), {
          description: t('toast.success.webhookTest.message'),
        });
      } else {
        toast.error(t('toast.error.agentTestFailed'), {
          description: result.error,
        });
      }
    } catch (err) {
      toast.error(t('toast.error.agentTestFailed'), {
        description: err instanceof Error ? err.message : undefined,
      });
    } finally {
      setTestingAgent(null);
    }
  };

  if (isLoading) {
    return (
      <div className="flex h-32 items-center justify-center">
        <div className="text-muted-foreground">
          {t('pages:settings.notifications.loadingSettings')}
        </div>
      </div>
    );
  }

  const removingConfig = removingAgent ? AGENT_CONFIGS[removingAgent] : null;

  return (
    <div className="space-y-4">
      {/* Agent grid */}
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {activeAgents.map((agent) => (
          <AgentCard
            key={agent.type}
            agent={agent}
            routingData={routingData ?? []}
            onToggleEvent={handleToggleEvent}
            onEdit={() => setEditingAgent(agent.type)}
            onRemove={() => setRemovingAgent(agent.type)}
            onTest={() => handleTestAgent(agent.type)}
            isTesting={testingAgent === agent.type}
          />
        ))}
      </div>

      {/* Add agent button */}
      {hasAddableAgents && (
        <Button variant="outline" onClick={() => setAddDialogOpen(true)}>
          <Plus className="mr-2 h-4 w-4" />
          {t('pages:settings.notifications.addAgent')}
        </Button>
      )}

      {/* Add agent dialog */}
      <AddAgentDialog
        open={addDialogOpen}
        onOpenChange={setAddDialogOpen}
        discord={discord}
        webhookAgents={webhookAgents}
        activeWebhookAgent={activeWebhookAgent}
        settings={settings}
      />

      {/* Edit agent dialog */}
      {editingAgent && (
        <EditAgentDialog
          open={!!editingAgent}
          onOpenChange={(open: boolean) => !open && setEditingAgent(null)}
          agentType={editingAgent}
          settings={settings}
        />
      )}

      {/* Remove confirmation dialog */}
      <ConfirmDialog
        open={!!removingAgent}
        onOpenChange={(open: boolean) => !open && setRemovingAgent(null)}
        title={t('pages:settings.notifications.removeAgentTitle', {
          name: removingConfig?.name ?? 'Agent',
        })}
        description={t('pages:settings.notifications.removeAgentDesc', {
          name: removingConfig?.name ?? 'notification agent',
        })}
        confirmLabel={t('common:actions.remove')}
        variant="destructive"
        onConfirm={handleRemoveAgent}
        isLoading={updateSettings.isPending}
      />
    </div>
  );
}
