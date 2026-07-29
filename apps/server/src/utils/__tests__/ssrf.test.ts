import { describe, it, expect } from 'vitest';
import { assertSafeProbeUrl, isDeniedProbeAddress, SsrfBlockedError } from '../ssrf.js';

describe('assertSafeProbeUrl', () => {
  describe('blocks disallowed schemes', () => {
    it('rejects file: scheme', () => {
      expect(() => assertSafeProbeUrl('file:///etc/passwd')).toThrow(SsrfBlockedError);
      expect(() => assertSafeProbeUrl('file:///etc/passwd')).toThrow(/not permitted/);
    });

    it('rejects gopher: scheme', () => {
      expect(() => assertSafeProbeUrl('gopher://evil.com/payload')).toThrow(SsrfBlockedError);
    });

    it('rejects ftp: scheme', () => {
      expect(() => assertSafeProbeUrl('ftp://192.168.1.1/')).toThrow(SsrfBlockedError);
    });
  });

  describe('blocks link-local IPv4 (169.254.0.0/16)', () => {
    it('rejects 169.254.169.254 (cloud metadata endpoint)', () => {
      expect(() => assertSafeProbeUrl('http://169.254.169.254/latest/meta-data')).toThrow(
        SsrfBlockedError
      );
    });

    it('rejects 169.254.0.1', () => {
      expect(() => assertSafeProbeUrl('http://169.254.0.1/')).toThrow(SsrfBlockedError);
    });

    it('rejects 169.254.255.254', () => {
      expect(() => assertSafeProbeUrl('http://169.254.255.254:8080/')).toThrow(SsrfBlockedError);
    });
  });

  describe('blocks link-local IPv6 (fe80::/10)', () => {
    it('rejects fe80::1', () => {
      expect(() => assertSafeProbeUrl('http://[fe80::1]/')).toThrow(SsrfBlockedError);
    });

    it('rejects febf::ffff (upper edge of fe80::/10)', () => {
      expect(() => assertSafeProbeUrl('http://[febf::ffff]/')).toThrow(SsrfBlockedError);
    });
  });

  describe('blocks IPv4-mapped IPv6 embedding link-local (bypass vector)', () => {
    it('rejects ::ffff:169.254.169.254 (WHATWG URL normalizes to ::ffff:a9fe:a9fe)', () => {
      // Without this fix the hostname normalizes to ::ffff:a9fe:a9fe which
      // does not start with "fe" and slips past the fe80::/10 check.
      expect(() => assertSafeProbeUrl('http://[::ffff:169.254.169.254]/')).toThrow(
        SsrfBlockedError
      );
    });

    it('rejects ::ffff:169.254.0.1', () => {
      expect(() => assertSafeProbeUrl('http://[::ffff:169.254.0.1]/')).toThrow(SsrfBlockedError);
    });

    it('allows ::ffff:192.168.1.50 (LAN address in mapped form is still allowed)', () => {
      expect(() => assertSafeProbeUrl('http://[::ffff:192.168.1.50]:32400')).not.toThrow();
    });

    it('allows ::ffff:127.0.0.1 (loopback in mapped form is still allowed)', () => {
      expect(() => assertSafeProbeUrl('http://[::ffff:127.0.0.1]:32400')).not.toThrow();
    });
  });

  describe('allows RFC 1918 private ranges (LAN media servers)', () => {
    it('allows 192.168.x.x', () => {
      expect(() => assertSafeProbeUrl('http://192.168.1.50:32400')).not.toThrow();
    });

    it('allows 10.x.x.x', () => {
      expect(() => assertSafeProbeUrl('http://10.0.0.5:8096')).not.toThrow();
    });

    it('allows 172.16.x.x', () => {
      expect(() => assertSafeProbeUrl('http://172.16.1.1:32400')).not.toThrow();
    });
  });

  describe('allows CGNAT / Tailscale (100.64.0.0/10)', () => {
    it('allows 100.64.0.1', () => {
      expect(() => assertSafeProbeUrl('http://100.64.0.1:32400')).not.toThrow();
    });

    it('allows 100.127.255.255 (upper edge of CGNAT)', () => {
      expect(() => assertSafeProbeUrl('http://100.127.255.255:32400')).not.toThrow();
    });
  });

  describe('allows loopback', () => {
    it('allows 127.0.0.1', () => {
      expect(() => assertSafeProbeUrl('http://127.0.0.1:32400')).not.toThrow();
    });

    it('allows ::1 (IPv6 loopback)', () => {
      expect(() => assertSafeProbeUrl('http://[::1]:32400')).not.toThrow();
    });
  });

  describe('allows normal http/https', () => {
    it('allows https://plex.example.com:32400', () => {
      expect(() => assertSafeProbeUrl('https://plex.example.com:32400')).not.toThrow();
    });
  });

  // Widened deny list (SEC-03 fix, emby-native-setup.md §8.3): '0.0.0.0/8',
  // multicast, broadcast, and the Oracle/AWS cloud metadata literals, applied
  // to literals here and, via isDeniedProbeAddress, to resolved addresses in
  // safeProbe.ts.
  describe('blocks 0.0.0.0/8 ("this network" / unspecified)', () => {
    it('rejects http://0.0.0.0', () => {
      expect(() => assertSafeProbeUrl('http://0.0.0.0')).toThrow(SsrfBlockedError);
    });

    it('rejects http://0.1.2.3', () => {
      expect(() => assertSafeProbeUrl('http://0.1.2.3')).toThrow(SsrfBlockedError);
    });

    it('rejects the IPv6 unspecified address ::', () => {
      expect(() => assertSafeProbeUrl('http://[::]:8096')).toThrow(SsrfBlockedError);
    });
  });

  describe('blocks multicast', () => {
    it('rejects http://224.0.0.1 (IPv4 multicast)', () => {
      expect(() => assertSafeProbeUrl('http://224.0.0.1')).toThrow(SsrfBlockedError);
    });

    it('rejects http://239.255.255.255 (upper edge of 224.0.0.0/4)', () => {
      expect(() => assertSafeProbeUrl('http://239.255.255.255')).toThrow(SsrfBlockedError);
    });

    it('rejects http://[ff02::1] (IPv6 multicast)', () => {
      expect(() => assertSafeProbeUrl('http://[ff02::1]')).toThrow(SsrfBlockedError);
    });
  });

  describe('blocks the broadcast address', () => {
    it('rejects http://255.255.255.255', () => {
      expect(() => assertSafeProbeUrl('http://255.255.255.255')).toThrow(SsrfBlockedError);
    });
  });

  describe('blocks cloud metadata literals outside the link-local range', () => {
    it('rejects http://192.0.0.192 (Oracle Cloud metadata)', () => {
      expect(() => assertSafeProbeUrl('http://192.0.0.192')).toThrow(SsrfBlockedError);
    });

    it('rejects http://[fd00:ec2::254] (AWS IPv6 metadata)', () => {
      expect(() => assertSafeProbeUrl('http://[fd00:ec2::254]')).toThrow(SsrfBlockedError);
    });
  });

  describe('still allows CGNAT/Tailscale including the Alibaba metadata carve-out', () => {
    // Documented residual (design §8.3): 100.100.100.200 sits inside
    // 100.64.0.0/10, so it stays reachable - denying it would break the
    // Tailscale range the tests above explicitly allow.
    it('allows 100.100.100.200', () => {
      expect(() => assertSafeProbeUrl('http://100.100.100.200:8096')).not.toThrow();
    });
  });

  describe("userinfo (SEC-09) is out of this function's scope", () => {
    it('does not itself reject http://user:pass@host:8096 - that is address/scheme-only here', () => {
      // Userinfo/query/fragment rejection is enforced by the setup plugin's
      // canonicalization step (canonicalizeSetupUrl in embySetupPlugin.ts)
      // BEFORE this function ever runs. Documented here so the two controls
      // are not confused with one another.
      expect(() => assertSafeProbeUrl('http://user:pass@192.168.1.10:8096')).not.toThrow();
    });
  });
});

describe('isDeniedProbeAddress', () => {
  it('allows loopback, RFC1918 and CGNAT addresses', () => {
    expect(isDeniedProbeAddress('127.0.0.1')).toBeNull();
    expect(isDeniedProbeAddress('192.168.1.10')).toBeNull();
    expect(isDeniedProbeAddress('10.0.0.5')).toBeNull();
    expect(isDeniedProbeAddress('172.16.1.1')).toBeNull();
    expect(isDeniedProbeAddress('100.64.0.1')).toBeNull();
    expect(isDeniedProbeAddress('::1')).toBeNull();
  });

  it('denies link-local, this-network, multicast, broadcast and metadata addresses', () => {
    expect(isDeniedProbeAddress('169.254.169.254')).not.toBeNull();
    expect(isDeniedProbeAddress('0.0.0.0')).not.toBeNull();
    expect(isDeniedProbeAddress('224.0.0.1')).not.toBeNull();
    expect(isDeniedProbeAddress('255.255.255.255')).not.toBeNull();
    expect(isDeniedProbeAddress('192.0.0.192')).not.toBeNull();
    expect(isDeniedProbeAddress('fe80::1')).not.toBeNull();
    expect(isDeniedProbeAddress('fd00:ec2::254')).not.toBeNull();
  });

  it('returns null for a non-IP hostname (defers to DNS resolution elsewhere)', () => {
    expect(isDeniedProbeAddress('emby.example.com')).toBeNull();
  });
});
