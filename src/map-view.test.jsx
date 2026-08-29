// @vitest-environment jsdom
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render } from '@testing-library/react';

const mapState = vi.hoisted(() => ({ mapOptions: null }));

vi.mock('maplibre-gl', () => {
  class Marker {
    setLngLat() { return this; }
    addTo() { return this; }
    on() { return this; }
    getLngLat() { return { lng: 0, lat: 0 }; }
    remove() {}
  }
  class Map {
    constructor(options) { mapState.mapOptions = options; }
    addControl() { return this; }
    on(event, cb) { if (event === 'load') cb(); return this; }
    off() { return this; }
    addSource() {}
    addLayer() {}
    getSource() { return { setData() {} }; }
    getBounds() { return { getWest: () => 0, getSouth: () => 0, getEast: () => 0, getNorth: () => 0 }; }
    flyTo() {}
    remove() {}
  }
  return { default: { Map, Marker, NavigationControl: class {}, AttributionControl: class {} } };
});

import App, { DEFAULT_MAP_ZOOM } from './main.jsx';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  mapState.mapOptions = null;
});

describe('initial map placement', () => {
  it('centres the initial view on mainland Helsinki instead of the southern city centre', () => {
    vi.stubGlobal('fetch', vi.fn(() => new Promise(() => {})));
    render(<App />);

    // MapLibre uses [lng, lat] order.
    expect(mapState.mapOptions).toMatchObject({
      center: [24.95, 60.2],
      zoom: DEFAULT_MAP_ZOOM,
    });
  });
});
