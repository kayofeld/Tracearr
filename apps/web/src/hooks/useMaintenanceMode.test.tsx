import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { onlineManager } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { MaintenanceProvider, useMaintenanceMode, MAINTENANCE_EVENT } from './useMaintenanceMode';

const fetchMock = vi.fn<typeof fetch>();

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function html(status = 200) {
  return new Response('<html>Bad Gateway</html>', {
    status,
    headers: { 'content-type': 'text/html' },
  });
}

const ready = () => json({ status: 'ok', mode: 'ready', db: true, redis: true });

function wrapper({ children }: { children: ReactNode }) {
  return <MaintenanceProvider>{children}</MaintenanceProvider>;
}

function mount() {
  return renderHook(() => useMaintenanceMode(), { wrapper });
}

async function tick(ms = 0) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

function setVisibility(state: 'visible' | 'hidden') {
  Object.defineProperty(document, 'visibilityState', { value: state, configurable: true });
  document.dispatchEvent(new Event('visibilitychange'));
}

describe('useMaintenanceMode', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal('fetch', fetchMock);
    fetchMock.mockReset();
    onlineManager.setOnline(true);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
    onlineManager.setOnline(true);
    setVisibility('visible');
  });

  it('reports ready on a healthy response and never caches the probe', async () => {
    fetchMock.mockResolvedValue(ready());
    const { result } = mount();
    await tick();

    expect(result.current.isInMaintenance).toBe(false);
    expect(result.current.isUnreachable).toBe(false);
    expect(onlineManager.isOnline()).toBe(true);
    expect(fetchMock).toHaveBeenCalledWith(
      '/health',
      expect.objectContaining({ cache: 'no-store', signal: expect.any(AbortSignal) })
    );
  });

  it('enters maintenance as soon as the server reports it', async () => {
    fetchMock.mockResolvedValue(
      json({ status: 'maintenance', mode: 'maintenance', wasReady: true, db: true, redis: false })
    );
    const { result } = mount();
    await tick();

    expect(result.current.isInMaintenance).toBe(true);
    expect(result.current.wasReady).toBe(true);
    expect(result.current.redis).toBe(false);
  });

  it('treats starting mode as maintenance', async () => {
    fetchMock.mockResolvedValue(
      json({
        status: 'maintenance',
        mode: 'starting',
        db: true,
        redis: true,
        initStep: 'migrations',
      })
    );
    const { result } = mount();
    await tick();

    expect(result.current.isInMaintenance).toBe(true);
    expect(result.current.initStep).toBe('migrations');
  });

  it('does not enter maintenance or unreachable on a single failed probe', async () => {
    fetchMock.mockRejectedValue(new TypeError('Failed to fetch'));
    const { result } = mount();
    await tick();

    expect(result.current.isInMaintenance).toBe(false);
    expect(result.current.isUnreachable).toBe(false);
  });

  it('takes queries offline on the first failed probe', async () => {
    fetchMock.mockRejectedValue(new TypeError('Failed to fetch'));
    mount();
    await tick();

    expect(onlineManager.isOnline()).toBe(false);
  });

  it('polls every 5s after a failure instead of every 60s', async () => {
    fetchMock.mockRejectedValue(new TypeError('Failed to fetch'));
    mount();
    await tick();
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await tick(5000);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('keeps the 60s cadence while healthy', async () => {
    fetchMock.mockResolvedValue(ready());
    mount();
    await tick();
    await tick(59_000);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await tick(1000);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('flags unreachable after three consecutive failed probes', async () => {
    fetchMock.mockRejectedValue(new TypeError('Failed to fetch'));
    const { result } = mount();
    await tick();
    await tick(5000);
    expect(result.current.isUnreachable).toBe(false);

    await tick(5000);
    expect(result.current.isUnreachable).toBe(true);
    expect(result.current.isInMaintenance).toBe(false);
  });

  it('counts a non-JSON 200 as a failed probe', async () => {
    fetchMock.mockResolvedValue(html());
    const { result } = mount();
    await tick();
    await tick(5000);
    await tick(5000);

    expect(result.current.isUnreachable).toBe(true);
    expect(result.current.isInMaintenance).toBe(false);
  });

  it('counts a non-2xx response as a failed probe', async () => {
    fetchMock.mockResolvedValue(html(502));
    const { result } = mount();
    await tick();
    await tick(5000);
    await tick(5000);

    expect(result.current.isUnreachable).toBe(true);
  });

  it('recovers on the first healthy probe and returns to the slow cadence', async () => {
    fetchMock
      .mockRejectedValueOnce(new TypeError('Failed to fetch'))
      .mockRejectedValueOnce(new TypeError('Failed to fetch'))
      .mockRejectedValueOnce(new TypeError('Failed to fetch'))
      .mockResolvedValue(ready());
    const { result } = mount();
    await tick();
    await tick(5000);
    await tick(5000);
    expect(result.current.isUnreachable).toBe(true);

    await tick(5000);
    expect(result.current.isUnreachable).toBe(false);
    expect(onlineManager.isOnline()).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(4);

    await tick(5000);
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it('stops reporting a dead process as mid-migration with healthy services', async () => {
    fetchMock
      .mockResolvedValueOnce(
        json({
          status: 'maintenance',
          mode: 'starting',
          db: true,
          redis: true,
          initStep: 'migrations',
        })
      )
      .mockRejectedValue(new TypeError('Failed to fetch'));
    const { result } = mount();
    await tick();
    expect(result.current.initStep).toBe('migrations');

    await tick(5000);
    await tick(5000);
    expect(result.current.initStep).toBe('migrations');
    expect(result.current.db).toBe(true);

    await tick(5000);
    expect(result.current.isUnreachable).toBe(true);
    expect(result.current.initStep).toBeNull();
    expect(result.current.db).toBe(false);
    expect(result.current.redis).toBe(false);
  });

  it('stops showing restore progress from a process that has gone away', async () => {
    const restore = { phase: 'restoring', progress: 40 };
    fetchMock
      .mockResolvedValueOnce(json({ status: 'maintenance', mode: 'maintenance', restore }))
      .mockRejectedValue(new TypeError('Failed to fetch'));
    const { result } = mount();
    await tick();
    expect(result.current.restore).toEqual(restore);

    await tick(5000);
    await tick(5000);
    await tick(5000);
    expect(result.current.isUnreachable).toBe(true);
    expect(result.current.restore).toBeNull();
    expect(result.current.isInMaintenance).toBe(true);
  });

  it('keeps queries paused when the server comes back still starting up', async () => {
    fetchMock
      .mockRejectedValueOnce(new TypeError('Failed to fetch'))
      .mockRejectedValueOnce(new TypeError('Failed to fetch'))
      .mockResolvedValueOnce(
        json({ status: 'maintenance', mode: 'starting', db: true, redis: true })
      )
      .mockResolvedValue(ready());
    const { result } = mount();
    await tick();
    await tick(5000);
    expect(onlineManager.isOnline()).toBe(false);

    await tick(5000);
    expect(result.current.isInMaintenance).toBe(true);
    expect(onlineManager.isOnline()).toBe(false);

    await tick(5000);
    expect(result.current.isInMaintenance).toBe(false);
    expect(onlineManager.isOnline()).toBe(true);
  });

  it('enters maintenance immediately on the API 503 event and re-probes', async () => {
    fetchMock.mockResolvedValue(ready());
    const { result } = mount();
    await tick();
    expect(fetchMock).toHaveBeenCalledTimes(1);

    fetchMock.mockResolvedValue(
      json({ status: 'maintenance', mode: 'maintenance', wasReady: true, db: false, redis: true })
    );
    await act(async () => {
      globalThis.dispatchEvent(new Event(MAINTENANCE_EVENT));
    });

    expect(result.current.isInMaintenance).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('stays in maintenance after the 503 event even if the next probe fails', async () => {
    fetchMock.mockResolvedValue(ready());
    const { result } = mount();
    await tick();

    fetchMock.mockRejectedValue(new TypeError('Failed to fetch'));
    await act(async () => {
      globalThis.dispatchEvent(new Event(MAINTENANCE_EVENT));
    });

    expect(result.current.isInMaintenance).toBe(true);
  });

  it('reloads the page once a restore has finished and the server is ready again', async () => {
    const reload = vi.fn();
    const original = window.location;
    Object.defineProperty(window, 'location', {
      value: { ...original, reload },
      writable: true,
      configurable: true,
    });
    fetchMock
      .mockResolvedValueOnce(
        json({ status: 'maintenance', mode: 'maintenance', restore: { phase: 'restoring' } })
      )
      .mockResolvedValue(ready());
    mount();
    await tick();
    expect(reload).not.toHaveBeenCalled();

    await tick(5000);
    expect(reload).toHaveBeenCalledTimes(1);
    Object.defineProperty(window, 'location', {
      value: original,
      writable: true,
      configurable: true,
    });
  });

  it('stops probing once unmounted', async () => {
    fetchMock.mockRejectedValue(new TypeError('Failed to fetch'));
    const { unmount } = mount();
    await tick();
    unmount();

    await tick(60_000);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('skips probes while the tab is hidden and probes at once when it is shown', async () => {
    fetchMock.mockResolvedValue(ready());
    mount();
    await tick();
    expect(fetchMock).toHaveBeenCalledTimes(1);

    act(() => setVisibility('hidden'));
    await tick(120_000);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await act(async () => setVisibility('visible'));
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
