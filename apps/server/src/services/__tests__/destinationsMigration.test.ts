import { beforeEach, describe, expect, it, vi } from 'vitest';

const warnings: string[] = [];
vi.mock('../../utils/logger.js', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: (msg: string) => warnings.push(msg),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));
vi.mock('../../db/client.js', () => ({ db: { transaction: vi.fn() } }));
vi.mock('../../db/schema.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
}));
vi.mock('../../jobs/poller/database.js', () => ({ invalidateAutomationsCache: vi.fn() }));
vi.mock('../settings.js', () => ({ resetSettingsCache: vi.fn() }));
vi.mock('../notifications/destinationStore.js', () => ({
  invalidateDestinationsCache: vi.fn(),
  listDestinations: vi.fn(),
  markReencrypt: vi.fn(),
  publishDestinationsChanged: vi.fn(() => Promise.resolve()),
  readConfig: vi.fn(),
  rewrapConfig: vi.fn(),
}));

import { db } from '../../db/client.js';
import { destinations, automations, settings } from '../../db/schema.js';
import { invalidateAutomationsCache } from '../../jobs/poller/database.js';
import {
  initDestinationCrypto,
  resetDestinationCryptoForTests,
} from '../notifications/destinationCrypto.js';
import {
  invalidateDestinationsCache,
  listDestinations,
  markReencrypt,
  publishDestinationsChanged,
  readConfig,
  rewrapConfig,
  type DestinationRow,
} from '../notifications/destinationStore.js';
import {
  planDestinationsMigration,
  runDestinationsMigration,
  SEVEN_KEYS,
  sweepDestinationConfigs,
  type PlanInput,
  type RoutingRow,
  type SevenKey,
} from '../notifications/destinationsMigration.js';
import { resetSettingsCache } from '../settings.js';

const seven = (
  o: Partial<Record<SevenKey, string | null>> = {}
): Record<SevenKey, string | null> => ({
  discordWebhookUrl: null,
  customWebhookUrl: null,
  webhookFormat: null,
  ntfyTopic: null,
  ntfyAuthToken: null,
  pushoverUserKey: null,
  pushoverApiToken: null,
  ...o,
});

const routing = (rows: Array<Partial<RoutingRow> & { eventType: string }>): RoutingRow[] =>
  rows.map((r) => ({
    discordEnabled: true,
    webhookEnabled: true,
    pushEnabled: true,
    webToastEnabled: true,
    ...r,
  }));

const builtins = { pushId: 'push-row', webToastId: 'toast-row' };

const plan = (o: Partial<PlanInput> = {}) =>
  planDestinationsMigration({
    settings: seven(),
    routing: null,
    rules: [],
    builtins,
    ...o,
  });

const notifyRule = (
  id: string,
  channels: Array<'push' | 'discord' | 'email' | 'webhook'>,
  extra: { isActive?: boolean; cooldown?: number; name?: string } = {}
): PlanInput['rules'][number] => ({
  id,
  name: extra.name ?? id,
  isActive: extra.isActive ?? true,
  actions: {
    actions: [
      {
        type: 'notify',
        channels,
        ...(extra.cooldown !== undefined ? { cooldown_minutes: extra.cooldown } : {}),
      },
    ],
  },
});

describe('planDestinationsMigration', () => {
  beforeEach(() => {
    warnings.length = 0;
  });

  it('creates a discord row from discordWebhookUrl with the routed events', () => {
    const result = plan({
      settings: seven({ discordWebhookUrl: 'https://d/h' }),
      routing: routing([
        { eventType: 'violation_detected', discordEnabled: true },
        { eventType: 'server_down', discordEnabled: false },
      ]),
    });
    expect(result.destinations).toEqual([
      expect.objectContaining({
        type: 'discord',
        name: 'Discord',
        config: { webhookUrl: 'https://d/h' },
        enabled: true,
        events: expect.arrayContaining(['violation_detected']),
      }),
    ]);
    expect(result.destinations[0]?.events).not.toContain('server_down');
  });

  it('customWebhookUrl + webhookFormat picks the type; a null format is json_webhook', () => {
    expect(
      plan({ settings: seven({ customWebhookUrl: 'https://w/h' }) }).destinations[0]
    ).toMatchObject({ type: 'json_webhook', name: 'Webhook', config: { url: 'https://w/h' } });
    expect(
      plan({ settings: seven({ customWebhookUrl: 'https://g/h', webhookFormat: 'gotify' }) })
        .destinations[0]
    ).toMatchObject({ type: 'gotify', name: 'Gotify' });
    expect(
      plan({ settings: seven({ customWebhookUrl: 'https://a/h', webhookFormat: 'apprise' }) })
        .destinations[0]
    ).toMatchObject({ type: 'apprise', name: 'Apprise' });
  });

  it('ntfy carries the topic default and omits an unset token', () => {
    expect(
      plan({ settings: seven({ customWebhookUrl: 'https://ntfy.sh', webhookFormat: 'ntfy' }) })
        .destinations[0]?.config
    ).toEqual({ url: 'https://ntfy.sh', topic: 'tracearr' });
    expect(
      plan({
        settings: seven({
          customWebhookUrl: 'https://ntfy.sh',
          webhookFormat: 'ntfy',
          ntfyTopic: 'mine',
          ntfyAuthToken: 'tk_1',
        }),
      }).destinations[0]?.config
    ).toEqual({ url: 'https://ntfy.sh', topic: 'mine', authToken: 'tk_1' });
  });

  it('customWebhookUrl with webhookFormat pushover creates no row and logs without the url', () => {
    const result = plan({
      settings: seven({ customWebhookUrl: 'https://secret/h', webhookFormat: 'pushover' }),
    });
    expect(result.destinations).toEqual([]);
    expect(result.logs).toHaveLength(1);
    expect(result.logs[0]).toContain('webhookFormat=pushover');
    expect(result.logs[0]).not.toContain('https://secret/h');
  });

  it('pushover keys create a row enabled only when webhookFormat is pushover', () => {
    const off = plan({ settings: seven({ pushoverUserKey: 'u', pushoverApiToken: 'a' }) });
    expect(off.destinations[0]).toMatchObject({
      type: 'pushover',
      name: 'Pushover',
      config: { userKey: 'u', apiToken: 'a' },
      enabled: false,
    });
    const on = plan({
      settings: seven({ pushoverUserKey: 'u', pushoverApiToken: 'a', webhookFormat: 'pushover' }),
    });
    expect(on.destinations[0]?.enabled).toBe(true);
    expect(plan({ settings: seven({ pushoverUserKey: 'u' }) }).destinations).toEqual([]);
  });

  it('routing null falls back to every event but the stream pair and trust, capped by capability', () => {
    const result = plan({
      settings: seven({
        discordWebhookUrl: 'https://d/h',
        pushoverUserKey: 'u',
        pushoverApiToken: 'a',
      }),
      routing: null,
    });
    // A factory-reset install seeds New device and not this one.
    const all = [
      'violation_detected',
      'server_down',
      'server_up',
      'plugin_update_available',
      'new_device',
    ];
    expect(result.destinations[0]?.events).toEqual(all);
    expect(result.destinations[1]?.events).toEqual(all);
    expect(result.builtinEvents.push).toEqual([
      'violation_detected',
      'server_down',
      'server_up',
      'new_device',
    ]);
    expect(result.builtinEvents.webToast).toEqual([
      'violation_detected',
      'server_down',
      'server_up',
      'new_device',
    ]);
  });

  it('built-in events follow the routing toggles when rows exist', () => {
    const result = plan({
      routing: routing([
        { eventType: 'violation_detected', pushEnabled: true, webToastEnabled: false },
        { eventType: 'stream_started', pushEnabled: true, webToastEnabled: true },
        { eventType: 'server_down', pushEnabled: false, webToastEnabled: true },
        { eventType: 'server_up', pushEnabled: false, webToastEnabled: false },
        { eventType: 'plugin_update_available', pushEnabled: true, webToastEnabled: true },
      ]),
    });
    expect(result.builtinEvents.push).toEqual([
      'violation_detected',
      'stream_started',
      'new_device',
    ]);
    expect(result.builtinEvents.webToast).toEqual(['stream_started', 'server_down', 'new_device']);
  });

  it('rewrites notify actions to send across every rule, dropping email and empty actions', () => {
    const result = plan({
      settings: seven({
        discordWebhookUrl: 'https://d/h',
        customWebhookUrl: 'https://w/h',
        pushoverUserKey: 'u',
        pushoverApiToken: 'a',
      }),
      rules: [
        notifyRule('r1', ['push', 'discord'], { cooldown: 30 }),
        notifyRule('r2', ['webhook']),
        notifyRule('r3', ['email'], { name: 'Email only' }),
        notifyRule('r4', ['push'], { isActive: false }),
        {
          id: 'r5',
          name: 'no notify',
          isActive: true,
          actions: { actions: [{ type: 'kill_stream' }] },
        },
      ],
    });

    expect(result.ruleUpdates.map((u) => u.id)).toEqual(['r1', 'r2', 'r3', 'r4']);
    expect(result.ruleUpdates[0]?.actions.actions).toEqual([
      { type: 'send', to: ['push-row', 'planned:discord'], cooldown_minutes: 30 },
    ]);
    expect(result.ruleUpdates[1]?.actions.actions).toEqual([
      { type: 'send', to: ['planned:webhook', 'planned:pushover'] },
    ]);
    expect(result.ruleUpdates[2]?.actions.actions).toEqual([]);
    expect(result.ruleUpdates[3]?.actions.actions).toEqual([{ type: 'send', to: ['push-row'] }]);
    expect(result.logs).toContain(
      'rule "Email only": notify action had no reachable destination; removed'
    );
  });

  it('drops the discord channel when no discord url was configured', () => {
    const result = plan({ rules: [notifyRule('r1', ['discord', 'push'])] });
    expect(result.ruleUpdates[0]?.actions.actions).toEqual([{ type: 'send', to: ['push-row'] }]);
  });

  it('is a no-op plan when nothing is set and no rule has notify', () => {
    const result = plan();
    expect(result.destinations).toEqual([]);
    expect(result.ruleUpdates).toEqual([]);
    expect(result.logs).toEqual([]);
  });
});

function sqlText(query: unknown): string {
  const chunks = (query as { queryChunks?: unknown[] }).queryChunks ?? [];
  return chunks
    .map((c) => {
      if (c && typeof c === 'object' && 'value' in c) {
        const v = c.value;
        return Array.isArray(v) ? v.join('') : String(v);
      }
      return String(c);
    })
    .join('');
}

interface TxState {
  builtinRows: Array<{ id: string; type: string; name?: string }>;
  settingRows: Array<{ name: string; value: unknown }>;
  ruleRows: PlanInput['rules'];
  routingRows: Array<Record<string, unknown>>;
  routingExists: boolean;
  failInsert?: boolean;
  builtinsInserted?: boolean;
}

function buildTx(state: TxState) {
  const log: string[] = [];
  const inserted: Array<Record<string, unknown>> = [];
  const seeded: Array<Record<string, unknown>> = [];
  const updates: Array<{ table: unknown; patch: Record<string, unknown> }> = [];
  const deletes: Array<unknown> = [];
  let nextId = 0;

  const rowsFor = (table: unknown) => {
    if (table === destinations) return state.builtinRows;
    if (table === settings) return state.settingRows;
    return state.ruleRows;
  };
  const nameFor = (table: unknown) =>
    table === destinations ? 'destinations' : table === settings ? 'settings' : 'rules';

  const tx = {
    execute: vi.fn((query: unknown) => {
      const text = sqlText(query);
      log.push(`execute:${text}`);
      if (text.includes('to_regclass')) {
        return Promise.resolve({ rows: state.routingExists ? [{ r: 42 }] : [{ r: null }] });
      }
      if (text.includes('SELECT event_type')) return Promise.resolve({ rows: state.routingRows });
      return Promise.resolve({ rows: [] });
    }),
    select: vi.fn(() => ({
      from: (table: unknown) => {
        log.push(`select:${nameFor(table)}`);
        const rows = rowsFor(table);
        return Object.assign(Promise.resolve(rows), { where: () => Promise.resolve(rows) });
      },
    })),
    insert: vi.fn((table: unknown) => ({
      values: (values: Record<string, unknown> | Array<Record<string, unknown>>) => {
        if (Array.isArray(values)) {
          log.push(`insert:${nameFor(table)}:builtins`);
          seeded.push(...values);
        } else {
          log.push(`insert:${nameFor(table)}:${String(values.name)}`);
          inserted.push(values);
        }
        return {
          onConflictDoNothing: () => ({
            returning: () =>
              Promise.resolve(state.builtinsInserted ? [{ id: 'p' }, { id: 'w' }] : []),
          }),
          returning: () => {
            if (state.failInsert) return Promise.reject(new Error('insert exploded'));
            nextId += 1;
            return Promise.resolve([{ id: `new-${nextId}` }]);
          },
        };
      },
    })),
    update: vi.fn((table: unknown) => ({
      set: (patch: Record<string, unknown>) => {
        log.push(`update:${nameFor(table)}`);
        updates.push({ table, patch });
        return { where: () => Promise.resolve(undefined) };
      },
    })),
    delete: vi.fn((table: unknown) => {
      log.push(`delete:${nameFor(table)}`);
      deletes.push(table);
      return { where: (clause: unknown) => Promise.resolve(clause) };
    }),
  };

  return { tx, log, inserted, seeded, updates, deletes };
}

describe('runDestinationsMigration', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    warnings.length = 0;
    resetDestinationCryptoForTests();
    delete process.env.ENCRYPTION_KEY;
    process.env.JWT_SECRET = 'jwt-for-tests';
    initDestinationCrypto();
  });

  const runWith = async (state: TxState) => {
    const harness = buildTx(state);
    vi.mocked(db.transaction).mockImplementation((async (cb: (tx: unknown) => unknown) =>
      cb(harness.tx)) as unknown as typeof db.transaction);
    await runDestinationsMigration();
    return harness;
  };

  it('locks, seeds, plans, writes, and drops the routing table in order', async () => {
    const harness = await runWith({
      builtinRows: [
        { id: 'push-row', type: 'push' },
        { id: 'toast-row', type: 'web_toast' },
      ],
      settingRows: [{ name: 'discordWebhookUrl', value: 'https://d/h' }],
      ruleRows: [notifyRule('r1', ['discord', 'push'])],
      routingRows: [
        {
          event_type: 'violation_detected',
          discord_enabled: true,
          webhook_enabled: true,
          push_enabled: true,
          web_toast_enabled: false,
        },
      ],
      routingExists: true,
    });

    expect(harness.log[0]).toContain('pg_advisory_xact_lock');
    expect(harness.log[0]).toContain('875100003');
    expect(harness.log.slice(1)).toEqual([
      'insert:destinations:builtins',
      'select:destinations',
      'select:settings',
      'select:rules',
      expect.stringContaining('to_regclass'),
      expect.stringContaining('SELECT event_type'),
      'select:destinations',
      'insert:destinations:Discord',
      'update:destinations',
      'update:destinations',
      'update:rules',
      'delete:settings',
      expect.stringContaining('DROP TABLE IF EXISTS notification_channel_routing'),
    ]);

    expect(harness.inserted[0]).toMatchObject({ name: 'Discord', type: 'discord' });
    expect(String(harness.inserted[0]?.config)).toMatch(/^v1:/);

    // the single routing row wins for its event; the rest fall back to on
    const builtinPatches = harness.updates.filter((u) => u.table === destinations);
    expect(builtinPatches[0]?.patch.events).toEqual([
      'violation_detected',
      'server_down',
      'server_up',
      'new_device',
    ]);
    expect(builtinPatches[1]?.patch.events).toEqual(['server_down', 'server_up', 'new_device']);

    const ruleUpdate = harness.updates.find((u) => u.table === automations);
    expect(ruleUpdate?.patch.actions).toEqual({
      actions: [{ type: 'send', to: ['new-1', 'push-row'] }],
    });

    expect(harness.deletes).toEqual([settings]);
    expect(invalidateAutomationsCache).toHaveBeenCalledTimes(1);
    expect(invalidateDestinationsCache).toHaveBeenCalledTimes(1);
    expect(resetSettingsCache).toHaveBeenCalledTimes(1);
    expect(publishDestinationsChanged).toHaveBeenCalledTimes(1);
  });

  it('leaves the four events that post-date the routing table off every row it writes', async () => {
    const harness = await runWith({
      builtinRows: [
        { id: 'push-row', type: 'push' },
        { id: 'toast-row', type: 'web_toast' },
      ],
      settingRows: [{ name: 'discordWebhookUrl', value: 'https://d/h' }],
      ruleRows: [],
      routingRows: [],
      routingExists: false,
      builtinsInserted: true,
    });

    const written = [...harness.seeded, ...harness.inserted];
    expect(written).toHaveLength(3);
    for (const row of written) {
      expect(row.events).toContain('violation_detected');
      expect(row.events).toEqual(
        expect.not.arrayContaining([
          'server_update_available',
          'tracearr_update_available',
          'media_added',
          'media_upgraded',
        ])
      );
    }
  });

  it('deletes exactly the seven legacy setting names', async () => {
    let deleteClause: unknown;
    const harness = buildTx({
      builtinRows: [
        { id: 'push-row', type: 'push' },
        { id: 'toast-row', type: 'web_toast' },
      ],
      settingRows: [{ name: 'ntfyTopic', value: 'topic' }],
      ruleRows: [],
      routingRows: [],
      routingExists: false,
    });
    const originalDelete = harness.tx.delete;
    harness.tx.delete = vi.fn((table: unknown) => {
      const built = originalDelete(table);
      return {
        where: (clause: unknown) => {
          deleteClause = clause;
          return built.where(clause);
        },
      };
    });
    vi.mocked(db.transaction).mockImplementation((async (cb: (tx: unknown) => unknown) =>
      cb(harness.tx)) as unknown as typeof db.transaction);

    await runDestinationsMigration();

    const names = ((deleteClause as { queryChunks?: unknown[] }).queryChunks ?? [])
      .flatMap((c) => (Array.isArray(c) ? c : []))
      .map((p) => (p && typeof p === 'object' && 'value' in p ? p.value : p));
    expect(names).toEqual([...SEVEN_KEYS]);
  });

  it('only locks and seeds when there is nothing to migrate', async () => {
    const harness = await runWith({
      builtinRows: [
        { id: 'push-row', type: 'push' },
        { id: 'toast-row', type: 'web_toast' },
      ],
      settingRows: [],
      ruleRows: [],
      routingRows: [],
      routingExists: false,
    });

    expect(harness.log.filter((l) => l.startsWith('insert:'))).toEqual([
      'insert:destinations:builtins',
    ]);
    expect(harness.log.some((l) => l.startsWith('update:'))).toBe(false);
    expect(harness.log.some((l) => l.startsWith('delete:'))).toBe(false);
    expect(harness.log.some((l) => l.includes('DROP TABLE'))).toBe(false);
    expect(warnings).not.toContain(
      'notification_channel_routing absent; applying the fallback for every event'
    );
    expect(publishDestinationsChanged).not.toHaveBeenCalled();
  });

  it('writes the built-in events and drops the table when only routing toggles exist', async () => {
    const harness = await runWith({
      builtinRows: [
        { id: 'push-row', type: 'push' },
        { id: 'toast-row', type: 'web_toast' },
      ],
      settingRows: [],
      ruleRows: [],
      routingRows: [
        {
          event_type: 'server_up',
          discord_enabled: true,
          webhook_enabled: true,
          push_enabled: false,
          web_toast_enabled: true,
        },
      ],
      routingExists: true,
    });

    expect(harness.log[0]).toContain('875100003');
    expect(harness.updates.filter((u) => u.table === destinations)).toHaveLength(2);
    expect(
      harness.log.some((l) => l.includes('DROP TABLE IF EXISTS notification_channel_routing'))
    ).toBe(true);
    expect(publishDestinationsChanged).toHaveBeenCalledTimes(1);
  });

  it('counts up the suffix until the planned name is free', async () => {
    const harness = await runWith({
      builtinRows: [
        { id: 'push-row', type: 'push', name: 'Mobile push' },
        { id: 'toast-row', type: 'web_toast', name: 'Browser toasts' },
        { id: 'u1', type: 'discord', name: 'Discord' },
        { id: 'u2', type: 'discord', name: 'Discord (migrated)' },
      ],
      settingRows: [{ name: 'discordWebhookUrl', value: 'https://d/h' }],
      ruleRows: [],
      routingRows: [],
      routingExists: false,
    });

    expect(harness.inserted[0]).toMatchObject({ name: 'Discord (migrated 2)' });
  });

  it('propagates a failed insert instead of swallowing it', async () => {
    const harness = buildTx({
      builtinRows: [
        { id: 'push-row', type: 'push' },
        { id: 'toast-row', type: 'web_toast' },
      ],
      settingRows: [{ name: 'discordWebhookUrl', value: 'https://d/h' }],
      ruleRows: [],
      routingRows: [],
      routingExists: false,
      failInsert: true,
    });
    vi.mocked(db.transaction).mockImplementation((async (cb: (tx: unknown) => unknown) =>
      cb(harness.tx)) as unknown as typeof db.transaction);

    await expect(runDestinationsMigration()).rejects.toThrow('insert exploded');
    expect(invalidateAutomationsCache).not.toHaveBeenCalled();
  });

  it('throws when the built-in rows are missing after seeding', async () => {
    const harness = buildTx({
      builtinRows: [{ id: 'push-row', type: 'push' }],
      settingRows: [],
      ruleRows: [],
      routingRows: [],
      routingExists: false,
    });
    vi.mocked(db.transaction).mockImplementation((async (cb: (tx: unknown) => unknown) =>
      cb(harness.tx)) as unknown as typeof db.transaction);

    await expect(runDestinationsMigration()).rejects.toThrow('built-in destinations are missing');
  });
});

describe('sweepDestinationConfigs', () => {
  const at = new Date();
  const row = (o: Partial<DestinationRow>): DestinationRow => ({
    id: 'x',
    name: 'x',
    type: 'discord',
    config: 'v1:blob',
    events: [],
    enabled: true,
    builtin: false,
    configStatus: 'ok',
    createdAt: at,
    updatedAt: at,
    ...o,
  });

  beforeEach(() => {
    vi.clearAllMocks();
    warnings.length = 0;
  });

  it('marks only the row that fails on a rotated key', async () => {
    vi.mocked(listDestinations).mockResolvedValue([
      row({ id: 'builtin', builtin: true, config: null }),
      row({ id: 'stale', configStatus: 'reencrypt' }),
      row({ id: 'good', name: 'Good' }),
      row({ id: 'bad', name: 'Bad' }),
    ]);
    vi.mocked(readConfig).mockImplementation((r: DestinationRow) =>
      r.id === 'bad'
        ? { ok: false, reason: 'bad_key' }
        : { ok: true, config: { url: 'https://x' }, rewrap: false }
    );

    await sweepDestinationConfigs();

    expect(markReencrypt).toHaveBeenCalledTimes(1);
    expect(markReencrypt).toHaveBeenCalledWith('bad');
    expect(rewrapConfig).not.toHaveBeenCalled();
    expect(warnings).toEqual([
      'destination "Bad" was encrypted under another key; marking for re-entry',
    ]);
  });

  it('rewraps a row that opened under the secondary key', async () => {
    vi.mocked(listDestinations).mockResolvedValue([row({ id: 'old', name: 'Old' })]);
    vi.mocked(readConfig).mockReturnValue({
      ok: true,
      config: { url: 'https://x' },
      rewrap: true,
    });

    await sweepDestinationConfigs();

    expect(rewrapConfig).toHaveBeenCalledWith('old', { url: 'https://x' });
    expect(markReencrypt).not.toHaveBeenCalled();
  });

  it('warns but does not mark a malformed blob', async () => {
    vi.mocked(listDestinations).mockResolvedValue([row({ id: 'junk', name: 'Junk' })]);
    vi.mocked(readConfig).mockReturnValue({ ok: false, reason: 'malformed' });

    await sweepDestinationConfigs();

    expect(markReencrypt).not.toHaveBeenCalled();
    expect(warnings[0]).toContain('malformed');
  });
});
