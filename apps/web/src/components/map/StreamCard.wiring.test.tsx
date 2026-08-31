import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { StrictMode } from 'react';
import { MemoryRouter } from 'react-router';

const markerEls: HTMLElement[] = [];
const popupInstances: Array<{ container?: HTMLElement }> = [];

vi.mock('maplibre-gl', () => {
  class FakeMap {
    handlers: Record<string, ((...a: unknown[]) => void)[]> = {};
    on(ev: string, fn: (...a: unknown[]) => void) {
      (this.handlers[ev] ??= []).push(fn);
      return this;
    }
    off() {
      return this;
    }
    once() {
      return this;
    }
    addControl() {
      return this;
    }
    setStyle() {
      return this;
    }
    remove() {
      return this;
    }
    fitBounds() {
      return this;
    }
    getCanvas() {
      return { style: {} };
    }
  }
  class FakeMarker {
    el: HTMLElement;
    constructor(opts: { element: HTMLElement }) {
      this.el = opts.element;
      markerEls.push(this.el);
    }
    setLngLat() {
      return this;
    }
    addTo() {
      document.body.appendChild(this.el);
      return this;
    }
    remove() {
      this.el.remove();
    }
  }
  class FakePopup {
    container?: HTMLElement;
    constructor() {
      popupInstances.push(this);
    }
    setLngLat() {
      return this;
    }
    setDOMContent(c: HTMLElement) {
      this.container = c;
      document.body.appendChild(c);
      return this;
    }
    addTo() {
      return this;
    }
    closeHandlers: (() => void)[] = [];
    on(ev: string, fn: () => void) {
      if (ev === 'close') this.closeHandlers.push(fn);
      return this;
    }
    off(ev: string, fn: () => void) {
      this.closeHandlers = this.closeHandlers.filter((h) => h !== fn);
      return this;
    }
    // Real maplibre fires 'close' from remove(); the first fake missed that
    // and hid a popup closing itself during StrictMode effect teardown.
    remove() {
      this.container?.remove();
      this.closeHandlers.forEach((h) => h());
    }
  }
  return {
    Map: FakeMap,
    Marker: FakeMarker,
    Popup: FakePopup,
    AttributionControl: class {
      onAdd = vi.fn();
    },
    NavigationControl: class {
      onAdd = vi.fn();
    },
    addProtocol: vi.fn(),
    setWorkerUrl: vi.fn(),
  };
});
vi.mock('maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url', () => ({ default: 'worker.js' }));
vi.mock('maplibre-gl/dist/maplibre-gl.css', () => ({}));
vi.mock('pmtiles', () => ({
  PMTiles: class {
    getHeader() {
      return Promise.resolve({});
    }
  },
  Protocol: class {
    tile = vi.fn();
    add = vi.fn();
  },
}));
vi.mock('@protomaps/basemaps', () => ({ layers: () => [], namedFlavor: () => ({}) }));
vi.mock('@/components/theme-provider', () => ({
  useTheme: () => ({ theme: 'dark', accentHue: 187 }),
}));
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (k: string) => k, i18n: { language: 'en' } }),
}));

import { StreamCard } from '@/components/map/StreamCard';

const session = {
  id: 's1',
  serverId: 'srv1',
  state: 'playing',
  mediaType: 'movie',
  mediaTitle: 'Blade Runner',
  grandparentTitle: null,
  seasonNumber: null,
  episodeNumber: null,
  year: 2017,
  geoLat: 40.0,
  geoLon: -75.0,
  geoCity: 'Philadelphia',
  geoRegion: 'PA',
  geoCountry: 'US',
  product: 'Plex Web',
  platform: 'Chrome',
  user: { id: 'u1', username: 'gallapagos', identityName: null, thumbUrl: null },
  server: { id: 'srv1', name: 'Plex' },
} as never;

describe('StreamCard marker popup wiring', () => {
  it('opens the session popup when the dot is clicked', async () => {
    render(
      <StrictMode>
        <MemoryRouter>
          <StreamCard sessions={[session]} />
        </MemoryRouter>
      </StrictMode>
    );
    await waitFor(() => expect(markerEls.length).toBeGreaterThan(0));
    fireEvent.click(markerEls[0]!);
    await waitFor(() => expect(screen.getByText('Blade Runner')).toBeInTheDocument());
    const connected = new Set(popupInstances.map((i) => i.container).filter((c) => c?.isConnected));
    expect(connected.size).toBe(1);
  });
});
