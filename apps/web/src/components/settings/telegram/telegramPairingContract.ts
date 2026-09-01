/**
 * Telegram pairing contract - types.
 *
 * These landed in `@tracearr/shared` (backend-engineer's
 * apps/server/src/routes/telegramPairing.ts + services/telegramPairing.ts)
 * partway through this increment. This file used to mirror them locally
 * (gap-in-frozen-contract) - now that the real exports exist, it just
 * re-exports them so every consumer (api.ts, the pairing wizard, its tests)
 * keeps importing from this one module rather than `@tracearr/shared`
 * directly, in case of future churn.
 *
 * Routes (see apps/server/src/routes/telegramPairing.ts, mounted under the
 * `/notifications` prefix in apps/server/src/index.ts):
 *   POST   /notifications/telegram/pairing              -> TelegramPairingStart
 *   GET    /notifications/telegram/pairing/:pairingId    -> TelegramPairingStatus
 *   DELETE /notifications/telegram/pairing/:pairingId    -> { success: boolean }
 *
 * Note: `TelegramPairingStart.expiresAt` is typed `Date` in @tracearr/shared
 * but travels the wire as a JSON string (fetch().json() never revives Date
 * instances) - the wizard passes it through `new Date(...)`, which accepts
 * either, so this is safe without a cast.
 */
export type {
  TelegramPairingState,
  TelegramPairingStart,
  TelegramPairingStatus,
} from '@tracearr/shared';
