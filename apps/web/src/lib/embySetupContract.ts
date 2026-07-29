/**
 * Web-only helpers layered on top of the frozen Emby-native first-run setup contract
 * (`EMBY_SETUP_PATH`, `EmbySetupResult`, `EmbySetupErrorCode` from `@tracearr/shared`,
 * see docs/architecture/emby-native-setup.md section 14). Nothing here is part of the
 * contract itself - it is presentation-only logic for the setup form in `Login.tsx`.
 */
import {
  EMBY_SETUP_PATH,
  EMBY_SETUP_ERROR_CODES,
  type EmbySetupResult,
  type EmbySetupErrorCode,
} from '@tracearr/shared';

export { EMBY_SETUP_PATH, type EmbySetupResult, type EmbySetupErrorCode };

/**
 * Narrows an unknown value (the `code` field better-auth's error body may or may not carry) to
 * `EmbySetupErrorCode`. Anything else - a missing code, a network-level failure with no body, or
 * a future code this client doesn't know about yet - falls through to the generic fallback so the
 * UI never crashes on an unrecognized error shape.
 */
export function toEmbySetupErrorCode(code: unknown): EmbySetupErrorCode | undefined {
  return typeof code === 'string' && (EMBY_SETUP_ERROR_CODES as readonly string[]).includes(code)
    ? (code as EmbySetupErrorCode)
    : undefined;
}

/**
 * Which field group a given error code is about, per the design doc's failure taxonomy (section
 * 6.4): "URL and key for URL_REJECTED, SERVER_UNREACHABLE, KEY_REJECTED, KEY_NOT_ADMIN; username
 * and password for BAD_CREDENTIALS and NOT_EMBY_ADMIN; the form as a whole for the rest."
 */
export type EmbySetupErrorGroup = 'server' | 'credentials' | 'form';

export const EMBY_SETUP_ERROR_GROUP: Record<EmbySetupErrorCode, EmbySetupErrorGroup> = {
  URL_REJECTED: 'server',
  SERVER_UNREACHABLE: 'server',
  KEY_REJECTED: 'server',
  KEY_NOT_ADMIN: 'server',
  BAD_CREDENTIALS: 'credentials',
  NOT_EMBY_ADMIN: 'credentials',
  CLAIM_CODE: 'form',
  INSTANCE_OWNED: 'form',
  INSTANCE_RECOVERY: 'form',
  BUSY: 'form',
  SETUP_FAILED: 'form',
};
