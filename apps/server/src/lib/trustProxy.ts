/**
 * Resolves the `TRUST_PROXY` env var into a Fastify `trustProxy` option.
 *
 * SECURITY (security review F3): a bare boolean `true` trusts EVERY hop in
 * `X-Forwarded-For`, so `request.ip` resolves to the LEFTMOST value in that
 * header - which is entirely client-supplied. An attacker rotates it and
 * lands in a fresh rate-limit bucket on every request, defeating both the
 * built-in Better Auth sign-in limiter and the Emby-login rate limit
 * (embyPlugin.ts), which both key on this resolved IP via
 * betterAuthRequest.ts's CLIENT_IP_HEADER stamp.
 *
 * Prefer a hop count (`TRUST_PROXY=1` for a single reverse proxy in front of
 * Tracearr) or a comma-separated list of trusted proxy IPs/CIDRs
 * (`TRUST_PROXY=10.0.0.5,192.168.1.0/24`) - Fastify then walks in from the
 * socket peer and only trusts that many hops / those specific addresses,
 * so a client-forged extra hop is ignored. `TRUST_PROXY=true` keeps working
 * as a documented but discouraged fallback for existing deployments that
 * already rely on the old any-hop behavior; new setups should use a hop
 * count or an explicit proxy list instead.
 */
export function resolveTrustProxy(raw: string | undefined): boolean | number | string[] {
  if (!raw) return false;
  const trimmed = raw.trim();
  if (trimmed === '') return false;
  const lower = trimmed.toLowerCase();
  if (lower === 'true') return true;
  if (lower === 'false') return false;

  // A purely numeric value is a hop count, never an IP/CIDR list entry -
  // "0" or a negative number is an invalid hop count (fails closed to
  // false) rather than being treated as a one-entry proxy list.
  if (/^-?\d+$/.test(trimmed)) {
    const hops = Number(trimmed);
    return hops > 0 ? hops : false;
  }

  // Comma-separated list of trusted proxy IPs/CIDRs.
  const list = trimmed
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  return list.length > 0 ? list : false;
}
