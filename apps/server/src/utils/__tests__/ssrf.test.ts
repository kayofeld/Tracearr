import { describe, it, expect } from 'vitest';
import { assertSafeProbeUrl, SsrfBlockedError } from '../ssrf.js';

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
});
