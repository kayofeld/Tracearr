import { Globe, MessageSquare, Bell, Share2, Smartphone, Webhook, Send } from 'lucide-react';
import type { AgentConfig, NotificationAgentType } from './types';
import { BASE_URL } from '@/lib/basePath';

/**
 * Static configuration for all notification agent types.
 * Used to render UI and validate settings.
 */
export const AGENT_CONFIGS: Record<NotificationAgentType, AgentConfig> = {
  webToast: {
    type: 'webToast',
    name: 'Web Notifications',
    icon: Globe,
    description: 'Browser toast notifications',
    isDefault: true,
    isRemovable: false,
    routingChannel: 'webToast',
    fields: [],
  },

  discord: {
    type: 'discord',
    name: 'Discord',
    icon: MessageSquare,
    imagePath: `${BASE_URL}images/notification-agents/discord.png`,
    description: 'Send notifications to a Discord channel',
    isRemovable: true,
    routingChannel: 'discord',
    fields: [
      {
        key: 'discordWebhookUrl',
        label: 'Webhook URL',
        type: 'url',
        placeholder: 'https://discord.com/api/webhooks/...',
        required: true,
      },
    ],
  },

  ntfy: {
    type: 'ntfy',
    name: 'ntfy',
    icon: Bell,
    imagePath: `${BASE_URL}images/notification-agents/ntfy.png`,
    description: 'Push notifications via ntfy.sh',
    isRemovable: true,
    webhookFormat: 'ntfy',
    routingChannel: 'webhook',
    fields: [
      {
        key: 'customWebhookUrl',
        label: 'Server URL',
        type: 'url',
        placeholder: 'https://ntfy.sh/',
        required: true,
      },
      {
        key: 'ntfyTopic',
        label: 'Topic',
        type: 'text',
        placeholder: 'tracearr',
        required: true,
      },
      {
        key: 'ntfyAuthToken',
        label: 'Auth Token',
        type: 'secret',
        placeholder: 'Optional for public topics',
        required: false,
      },
    ],
  },

  gotify: {
    type: 'gotify',
    name: 'Gotify',
    icon: Bell,
    imagePath: `${BASE_URL}images/notification-agents/gotify.png`,
    description: 'Push notifications via Gotify',
    isRemovable: true,
    webhookFormat: 'gotify',
    routingChannel: 'webhook',
    fields: [
      {
        key: 'customWebhookUrl',
        label: 'Server URL',
        type: 'url',
        placeholder: 'https://gotify.example.com/message?token=yourtoken',
        required: true,
      },
    ],
  },

  telegram: {
    type: 'telegram',
    name: 'Telegram',
    icon: Send,
    description: 'Send notifications to a Telegram chat via a bot',
    isRemovable: true,
    webhookFormat: 'telegram',
    routingChannel: 'webhook',
    fields: [
      {
        key: 'telegramBotToken',
        label: 'Bot Token',
        type: 'secret',
        placeholder: '123456789:ABCdef...',
        required: true,
      },
      {
        key: 'telegramChatId',
        label: 'Chat ID',
        type: 'text',
        placeholder: 'e.g. 123456789 or -100123456789',
        required: true,
      },
    ],
  },

  apprise: {
    type: 'apprise',
    name: 'Apprise',
    icon: Share2,
    imagePath: `${BASE_URL}images/notification-agents/apprise.png`,
    description: 'Multi-service notifications via Apprise API',
    isRemovable: true,
    webhookFormat: 'apprise',
    routingChannel: 'webhook',
    fields: [
      {
        key: 'customWebhookUrl',
        label: 'Apprise API URL',
        type: 'url',
        placeholder: 'http://apprise:8000/notify/myconfig',
        required: true,
      },
    ],
  },

  pushover: {
    type: 'pushover',
    name: 'Pushover',
    icon: Smartphone,
    imagePath: `${BASE_URL}images/notification-agents/pushover.png`,
    description: 'Push notifications via Pushover',
    isRemovable: true,
    webhookFormat: 'pushover',
    routingChannel: 'webhook',
    fields: [
      {
        key: 'pushoverUserKey',
        label: 'User Key',
        type: 'text',
        placeholder: 'Your Pushover user key',
        required: true,
      },
      {
        key: 'pushoverApiToken',
        label: 'API Token',
        type: 'secret',
        placeholder: 'Your application API token',
        required: true,
      },
    ],
  },

  json: {
    type: 'json',
    name: 'JSON Webhook',
    icon: Webhook,
    description: 'Send raw JSON to a custom endpoint',
    isRemovable: true,
    webhookFormat: 'json',
    routingChannel: 'webhook',
    fields: [
      {
        key: 'customWebhookUrl',
        label: 'Webhook URL',
        type: 'url',
        placeholder: 'https://your-service.com/webhook',
        required: true,
      },
    ],
  },

  push: {
    type: 'push',
    name: 'Mobile Push',
    icon: Smartphone,
    description: 'Push notifications to paired mobile devices',
    isDefault: true,
    isRemovable: false,
    routingChannel: 'push',
    fields: [],
  },
};

/**
 * Agent types that can be added by the user (excludes defaults)
 */
export const ADDABLE_AGENT_TYPES: NotificationAgentType[] = [
  'discord',
  'ntfy',
  'gotify',
  'telegram',
  'apprise',
  'pushover',
  'json',
];

/**
 * Agent types routed via the single webhook channel (only one can be active,
 * selected by webhookFormat). Telegram uses its own bot token / chat id rather
 * than customWebhookUrl, but shares the same one-at-a-time webhook routing slot.
 */
export const CUSTOM_WEBHOOK_AGENTS: NotificationAgentType[] = [
  'ntfy',
  'gotify',
  'telegram',
  'apprise',
  'pushover',
  'json',
];
