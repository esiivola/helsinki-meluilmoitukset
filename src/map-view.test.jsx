// @vitest-environment jsdom
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render } from '@testing-library/react';

const leafletState = vi.hoisted(() => ({ mapOptions: null }));

vi.mock('leaflet', () => {
  const layer = () => ({
    addLayer: vi.fn(),
    addTo: vi.fn(function addTo() { return this; }),
    clearLayers: vi.fn(),
  });
  const map = { off: vi.fn(), on: vi.fn() };
  return {
    default: {
      control: { zoom: vi.fn(() => layer()) },
      layerGroup: vi.fn(() => layer()),
      map: vi.fn((node, options) => {
        leafletState.mapOptions = options;
        return map;
      }),
      tileLayer: vi.fn(() => layer()),
    },
  };
});

import App, { DEFAULT_MAP_ZOOM } from './main.jsx';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  leafletState.mapOptions = null;
});

describe('initial map placement', () => {
  it('centres the initial view on mainland Helsinki instead of the southern city centre', () => {
    vi.stubGlobal('fetch', vi.fn(() => new Promise(() => {})));
    render(<App />);

    expect(leafletState.mapOptions).toMatchObject({
      center: [60.2, 24.95],
      zoom: DEFAULT_MAP_ZOOM,
    });
  });
});
