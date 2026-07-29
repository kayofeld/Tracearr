import { isIP } from 'node:net';

export class SsrfBlockedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SsrfBlockedError';
  }
}

function isLinkLocalIPv4(addr: string): boolean {
  const parts = addr.split('.').map(Number);
  return parts[0] === 169 && parts[1] === 254;
}

// fe80::/10 covers fe80:: through febf:: (upper 10 bits fixed)
function isLinkLocalIPv6(addr: string): boolean {
  const normalized = normalizeIPv6(addr);
  if (!normalized.startsWith('fe')) return false;
  const secondByte = parseInt(normalized.slice(2, 4), 16);
  return !isNaN(secondByte) && secondByte >= 0x80 && secondByte <= 0xbf;
}

function normalizeIPv6(addr: string): string {
  return (
    addr
      .replace(/^\[|\]$/g, '')
      .split('%')[0]
      ?.toLowerCase() ?? ''
  );
}

/**
 * The value of the first 16-bit hextet of a (already-normalized, bracket- and
 * zone-id-stripped) IPv6 address, or null if it can't be parsed. Handles
 * WHATWG URL's leading-zero-stripped canonical form: an address written with
 * a leading `::` (compressed leading zero groups) has an effective first
 * hextet of 0, which is what `::1`, `::ffff:...` etc. all report - correct,
 * since none of those forms should ever match a top-byte-based deny rule.
 */
function firstIPv6Hextet(normalized: string): number | null {
  if (normalized === '::' || normalized.startsWith('::')) return 0;
  const firstGroup = normalized.split(':')[0];
  if (!firstGroup) return null;
  const parsed = parseInt(firstGroup, 16);
  return Number.isNaN(parsed) ? null : parsed;
}

/** ff00::/8 - IPv6 multicast: top byte of the first hextet is 0xff. */
function isMulticastIPv6(addr: string): boolean {
  const normalized = normalizeIPv6(addr);
  const hextet = firstIPv6Hextet(normalized);
  if (hextet === null) return false;
  return hextet >> 8 === 0xff;
}

/** The unspecified IPv6 address, written canonically as `::`. */
function isUnspecifiedIPv6(addr: string): boolean {
  return normalizeIPv6(addr) === '::';
}

/** AWS's IPv6 metadata address, a single literal rather than a range. */
function isAwsIPv6Metadata(addr: string): boolean {
  return normalizeIPv6(addr) === 'fd00:ec2::254';
}

/** 0.0.0.0/8 - "this network" and the unspecified IPv4 address. */
function isThisNetworkIPv4(addr: string): boolean {
  const parts = addr.split('.').map(Number);
  return parts[0] === 0;
}

/** 224.0.0.0/4 - IPv4 multicast. */
function isMulticastIPv4(addr: string): boolean {
  const parts = addr.split('.').map(Number);
  return parts[0] !== undefined && parts[0] >= 224 && parts[0] <= 239;
}

/** The limited broadcast address. */
function isBroadcastIPv4(addr: string): boolean {
  return addr === '255.255.255.255';
}

/** Oracle Cloud's metadata address, a single literal. */
function isOracleMetadata(addr: string): boolean {
  return addr === '192.0.0.192';
}

/**
 * Extract the embedded IPv4 address from an IPv4-mapped IPv6 address.
 *
 * WHATWG URL normalizes [::ffff:169.254.169.254] to [::ffff:a9fe:a9fe] before
 * we ever see the hostname, so we handle both the hex-group form that URL
 * normalization produces and the dotted-quad form that may appear in tests
 * or direct calls.
 *
 * Returns null if the address is not IPv4-mapped.
 */
export function extractIPv4FromMapped(ipv6: string): string | null {
  const lower = ipv6.toLowerCase();

  // WHATWG-normalized hex-group form produced by the URL parser: ::ffff:xxxx:xxxx
  const hexMatch = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(lower);
  if (hexMatch) {
    const hi = parseInt(hexMatch[1] ?? '0', 16);
    const lo = parseInt(hexMatch[2] ?? '0', 16);
    return [(hi >> 8) & 0xff, hi & 0xff, (lo >> 8) & 0xff, lo & 0xff].join('.');
  }

  // Dotted-quad form (e.g. from direct callers, not from URL normalization)
  const dottedMatch = /^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/.exec(lower);
  if (dottedMatch) {
    return dottedMatch[1] ?? null;
  }

  return null;
}

/**
 * Applies every IPv4 deny rule to a literal dotted-quad address, returning a
 * human-readable reason string if denied, or null if allowed. Shared between
 * the literal check in `assertSafeProbeUrl` and, via `isDeniedProbeAddress`,
 * the resolved-address re-check in `safeProbe.ts` (SEC-03 fix,
 * docs/architecture/emby-native-setup.md §8.3) - both need the identical
 * rule set applied to whatever address they're looking at, whether it came
 * straight off the URL or out of a DNS answer.
 */
function deniedIPv4Reason(addr: string): string | null {
  if (isLinkLocalIPv4(addr)) {
    return `${addr} is in the link-local range (169.254.0.0/16) and cannot be probed`;
  }
  if (isThisNetworkIPv4(addr)) {
    return `${addr} is in the "this network" range (0.0.0.0/8) and cannot be probed`;
  }
  if (isMulticastIPv4(addr)) {
    return `${addr} is in the multicast range (224.0.0.0/4) and cannot be probed`;
  }
  if (isBroadcastIPv4(addr)) {
    return `${addr} is the broadcast address and cannot be probed`;
  }
  if (isOracleMetadata(addr)) {
    return `${addr} is Oracle Cloud's metadata address and cannot be probed`;
  }
  return null;
}

/** Same as `deniedIPv4Reason`, for an IPv6 literal (or an IPv4-mapped IPv6 literal). */
function deniedIPv6Reason(addr: string): string | null {
  if (isLinkLocalIPv6(addr)) {
    return `${addr} is in the link-local range (fe80::/10) and cannot be probed`;
  }
  if (isMulticastIPv6(addr)) {
    return `${addr} is in the multicast range (ff00::/8) and cannot be probed`;
  }
  if (isUnspecifiedIPv6(addr)) {
    return `${addr} is the unspecified address and cannot be probed`;
  }
  if (isAwsIPv6Metadata(addr)) {
    return `${addr} is AWS's IPv6 metadata address and cannot be probed`;
  }
  // IPv4-mapped IPv6 addresses embedding a denied IPv4 address (the same
  // bypass vector as the link-local case, generalized to every IPv4 rule).
  const embedded = extractIPv4FromMapped(addr);
  if (embedded) {
    const embeddedReason = deniedIPv4Reason(embedded);
    if (embeddedReason) {
      return `${addr} is an IPv4-mapped IPv6 address embedding a denied range (${embeddedReason})`;
    }
  }
  return null;
}

/**
 * Applies the full address deny list (§8.3) to a single IP literal (as
 * returned by `node:net`'s `isIP`, so version is 4 or 6, or 0/undefined for
 * a non-IP hostname, which this function does not vet). Returns a reason
 * string if the address must be rejected, or null if it is allowed.
 *
 * Deliberately allowed and NOT checked here: loopback (127.0.0.0/8, ::1),
 * RFC1918 (10/8, 172.16/12, 192.168/16), and CGNAT/Tailscale
 * (100.64.0.0/10) - self-hosted Tracearr probes servers at exactly those
 * addresses.
 */
export function isDeniedProbeAddress(hostname: string): string | null {
  const stripped = hostname.replace(/^\[|\]$/g, '');
  const version = isIP(stripped);
  if (version === 4) return deniedIPv4Reason(stripped);
  if (version === 6) return deniedIPv6Reason(stripped);
  return null;
}

/**
 * Reject URL schemes other than http/https, and every address in the §8.3
 * deny list (link-local, "this network", multicast, broadcast, and the
 * AWS/Oracle cloud metadata literals) applied to the URL's own hostname
 * literal. RFC 1918, CGNAT/Tailscale, and loopback are deliberately allowed
 * -- Tracearr probes servers at those addresses.
 *
 * Hostname-based URLs are not DNS-resolved here; this is defense-in-depth
 * only for a plain literal check. `safeProbe.ts`'s `safeProbeJson` is the
 * primary control for a path that must survive a deliberate attacker
 * (SEC-03, docs/architecture/emby-native-setup.md §8): it resolves the
 * hostname and re-applies `isDeniedProbeAddress` to every resolved address
 * before connecting, and again at connect time.
 */
export function assertSafeProbeUrl(rawUrl: string): void {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new SsrfBlockedError(`Malformed URL: ${rawUrl}`);
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new SsrfBlockedError(
      `Scheme '${parsed.protocol.replace(':', '')}' not permitted; only http and https are allowed`
    );
  }

  // URL.hostname wraps IPv6 literals in brackets; strip them
  const hostname = parsed.hostname.replace(/^\[|\]$/g, '');

  const reason = isDeniedProbeAddress(hostname);
  if (reason) {
    throw new SsrfBlockedError(reason);
  }
}
