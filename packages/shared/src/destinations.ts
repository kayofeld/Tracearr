import { z } from 'zod';
import type { NotificationEventType, ViolationSeverity } from './types.js';

export const DESTINATION_KINDS = [
  'discord',
  'json_webhook',
  'ntfy',
  'gotify',
  'apprise',
  'pushover',
  'push',
  'web_toast',
  'telegram',
] as const;
export type DestinationKind = (typeof DESTINATION_KINDS)[number];

export const NOTIFICATION_EVENT_TYPES = [
  'violation_detected',
  'stream_started',
  'stream_stopped',
  'server_down',
  'server_up',
  'plugin_update_available',
  'server_update_available',
  'tracearr_update_available',
  'media_added',
  'media_upgraded',
  'new_device',
  'trust_score_changed',
] as const satisfies readonly NotificationEventType[];

/** What a destination may subscribe to on its own; every other event reaches it through an automation. */
export const SUBSCRIBABLE_EVENTS = [
  'violation_detected',
] as const satisfies readonly NotificationEventType[];
export type SubscribableEvent = (typeof SUBSCRIBABLE_EVENTS)[number];

const ALL_EVENTS = NOTIFICATION_EVENT_TYPES;
/** Push has no plugin-update method and the browser has no toast for it. */
const EVENTS_WITHOUT_PLUGIN = Object.freeze(
  NOTIFICATION_EVENT_TYPES.filter((e) => e !== 'plugin_update_available')
);

export interface DestinationFieldDescriptor {
  key: string;
  /** i18n key under pages:settings.destinations.fields */
  label: string;
  input: 'text' | 'url' | 'secret';
  required: boolean;
  /** Masked on read, kept on omit; every url is secret because webhook urls embed credentials */
  secret: boolean;
  placeholder?: string;
  /** i18n key under pages:settings.destinations.hints, rendered as the field description */
  hint?: string;
  default?: string;
}

export interface DestinationDescriptor {
  kind: DestinationKind;
  /** i18n key under pages:settings.destinations.types */
  label: string;
  /** lucide icon name; the web falls back to a generic icon for unknown names */
  icon: string;
  builtin: boolean;
  events: readonly NotificationEventType[];
  fields: readonly DestinationFieldDescriptor[];
}

const url = (key: string, label: string, placeholder: string): DestinationFieldDescriptor => ({
  key,
  label,
  input: 'url',
  required: true,
  secret: true,
  placeholder,
});
const secret = (
  key: string,
  label: string,
  required: boolean,
  hint?: string
): DestinationFieldDescriptor => ({
  key,
  label,
  input: 'secret',
  required,
  secret: true,
  hint,
});
const text = (
  key: string,
  label: string,
  required: boolean,
  placeholder?: string,
  def?: string
): DestinationFieldDescriptor => ({
  key,
  label,
  input: 'text',
  required,
  secret: false,
  placeholder,
  default: def,
});

export const DESTINATION_TYPES = {
  discord: {
    kind: 'discord',
    label: 'discord',
    icon: 'MessageSquare',
    builtin: false,
    events: ALL_EVENTS,
    fields: [url('webhookUrl', 'webhookUrl', 'https://discord.com/api/webhooks/...')],
  },
  json_webhook: {
    kind: 'json_webhook',
    label: 'jsonWebhook',
    icon: 'Webhook',
    builtin: false,
    events: ALL_EVENTS,
    fields: [url('url', 'url', 'https://example.com/webhook')],
  },
  ntfy: {
    kind: 'ntfy',
    label: 'ntfy',
    icon: 'Bell',
    builtin: false,
    events: ALL_EVENTS,
    fields: [
      url('url', 'serverUrl', 'https://ntfy.sh/'),
      text('topic', 'topic', true, 'tracearr', 'tracearr'),
      secret('authToken', 'authToken', false, 'authTokenOptional'),
    ],
  },
  gotify: {
    kind: 'gotify',
    label: 'gotify',
    icon: 'Bell',
    builtin: false,
    events: ALL_EVENTS,
    fields: [url('url', 'serverUrl', 'https://gotify.example.com/message?token=...')],
  },
  apprise: {
    kind: 'apprise',
    label: 'apprise',
    icon: 'Share2',
    builtin: false,
    events: ALL_EVENTS,
    fields: [url('url', 'apiUrl', 'https://apprise.example.com/notify/apprise')],
  },
  telegram: {
    kind: 'telegram',
    label: 'telegram',
    icon: 'Send',
    builtin: false,
    events: ALL_EVENTS,
    // chatId is normally filled by the pairing wizard rather than typed in,
    // but it stays an editable field so a known chat id can be pasted.
    fields: [secret('botToken', 'botToken', true), secret('chatId', 'chatId', true)],
  },
  pushover: {
    kind: 'pushover',
    label: 'pushover',
    icon: 'Smartphone',
    builtin: false,
    events: ALL_EVENTS,
    fields: [secret('userKey', 'userKey', true), secret('apiToken', 'apiToken', true)],
  },
  push: {
    kind: 'push',
    label: 'push',
    icon: 'Smartphone',
    builtin: true,
    events: EVENTS_WITHOUT_PLUGIN,
    fields: [],
  },
  web_toast: {
    kind: 'web_toast',
    label: 'webToast',
    icon: 'Globe',
    builtin: true,
    events: EVENTS_WITHOUT_PLUGIN,
    fields: [],
  },
} as const satisfies Record<DestinationKind, DestinationDescriptor>;

const httpUrl = z
  .string()
  .trim()
  .refine((v) => /^https?:\/\/\S+$/i.test(v), 'Must be an http(s) URL');

/** Zod object for one kind's config, built from its descriptor; unknown keys rejected. */
export function destinationConfigSchema(kind: DestinationKind): z.ZodObject<z.ZodRawShape> {
  const shape: Record<string, z.ZodType> = {};
  for (const f of DESTINATION_TYPES[kind].fields) {
    let s: z.ZodString = f.input === 'url' ? httpUrl : z.string().trim().max(2000);
    if (f.required) s = s.min(1);
    shape[f.key] =
      f.default !== undefined ? s.default(f.default) : f.required ? s : s.optional().nullable();
  }
  return z.strictObject(shape);
}

export const notificationEventTypeSchema = z.enum(NOTIFICATION_EVENT_TYPES);
const subscribableEventSchema = z.enum(SUBSCRIBABLE_EVENTS);
const nonBuiltinKind = z.enum(DESTINATION_KINDS.filter((k) => !DESTINATION_TYPES[k].builtin));

export const createDestinationSchema = z.strictObject({
  name: z.string().trim().min(1).max(100),
  type: nonBuiltinKind,
  config: z.record(z.string(), z.unknown()),
  events: z.array(subscribableEventSchema).default([]),
  enabled: z.boolean().default(true),
});

/** Secrets: omitted keeps the stored value, null clears, a string replaces. */
export const updateDestinationSchema = z.strictObject({
  name: z.string().trim().min(1).max(100).optional(),
  config: z.record(z.string(), z.union([z.string(), z.null()])).optional(),
  events: z.array(subscribableEventSchema).optional(),
  enabled: z.boolean().optional(),
});

export type CreateDestinationInput = z.infer<typeof createDestinationSchema>;
export type UpdateDestinationInput = z.infer<typeof updateDestinationSchema>;

/** API shape. `config` carries non-secret values; secret fields are null and listed in `secretsSet` when stored. */
export interface Destination {
  id: string;
  name: string;
  type: DestinationKind;
  enabled: boolean;
  builtin: boolean;
  events: NotificationEventType[];
  configStatus: 'ok' | 'reencrypt';
  config: Record<string, string | null> | null;
  secretsSet: string[];
  referencedByAutomationCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface NotificationToast {
  title: string;
  message: string;
  automationId: string;
  automationName: string;
  severity: ViolationSeverity;
}
