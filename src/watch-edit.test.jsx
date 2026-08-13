// @vitest-environment jsdom
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { GUARDS_KEY } from './guards.js';

const leafletState = vi.hoisted(() => ({
  bounds: { south: 60.18, west: 24.96, north: 60.20, east: 25.00 },
  draggableMarkers: [],
  handlers: {},
}));

vi.mock('leaflet', () => {
  const addable = () => ({ addTo() { return this; } });
  const layerGroup = () => ({ ...addable(), addLayer: vi.fn(), clearLayers: vi.fn() });
  const map = {
    getBounds: () => ({
      getSouth: () => leafletState.bounds.south,
      getWest: () => leafletState.bounds.west,
      getNorth: () => leafletState.bounds.north,
      getEast: () => leafletState.bounds.east,
    }),
    on: vi.fn((event, handler) => { leafletState.handlers[event] = handler; }),
    off: vi.fn((event) => { delete leafletState.handlers[event]; }),
  };
  return {
    default: {
      circleMarker: vi.fn((point, options) => ({ point, options })),
      control: { zoom: vi.fn(() => addable()) },
      divIcon: vi.fn((options) => options),
      layerGroup: vi.fn(layerGroup),
      map: vi.fn(() => map),
      marker: vi.fn((point, options = {}) => {
        const handlers = {};
        const marker = {
          getElement: () => null,
          getLatLng: () => ({ lat: point[0], lng: point[1] }),
          on: vi.fn((event, handler) => { handlers[event] = handler; return marker; }),
          options,
          point,
          handlers,
        };
        if (options.draggable) leafletState.draggableMarkers.push(marker);
        return marker;
      }),
      polygon: vi.fn((points, options) => ({ points, options })),
      polyline: vi.fn((points, options) => ({ points, options })),
      tileLayer: vi.fn(() => addable()),
    },
  };
});

import App from './main.jsx';

const ORIGINAL_AREA = [[60.16, 24.92], [60.16, 24.94], [60.17, 24.94], [60.17, 24.92]];
const manifest = {
  schemaVersion: 1,
  generatedAt: '2026-08-13T03:00:00Z',
  totalNotices: 0,
  chunks: [{ key: 'current', file: 'notices-current.json', count: 0 }],
};

let storage;

function savedGuard() {
  return {
    id: 'vahti-1',
    name: 'Koti',
    polygon: ORIGINAL_AREA,
    categories: ['construction'],
    createdAt: '2026-08-10T06:00:00.000Z',
    baselineDate: '2026-08-10',
    acknowledged: ['old-notice'],
  };
}

function renderApp() {
  vi.stubGlobal('fetch', vi.fn(async (url) => ({
    ok: true,
    json: async () => (String(url).endsWith('index.json') ? manifest : { notices: [] }),
  })));
  render(<App />);
  fireEvent.click(screen.getByRole('button', { name: 'Vahdit ja uudet ilmoitukset: 0' }));
  fireEvent.click(screen.getByRole('button', { name: 'Muokkaa' }));
}

beforeEach(() => {
  let value = JSON.stringify({ schemaVersion: 1, guards: [savedGuard()] });
  storage = {
    getItem: vi.fn((key) => (key === GUARDS_KEY ? value : null)),
    setItem: vi.fn((key, next) => { if (key === GUARDS_KEY) value = next; }),
  };
  Object.defineProperty(window, 'localStorage', { configurable: true, value: storage });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  leafletState.draggableMarkers = [];
  leafletState.handlers = {};
});

describe('editing a watch area', () => {
  it('moves existing vertices and appends new ones in boundary order while preserving watch fields', () => {
    renderApp();
    const editor = screen.getByRole('dialog', { name: 'Muokkaa' });
    expect(within(editor).getByText(/^Alue:/)).not.toBeNull();

    fireEvent.click(within(editor).getByRole('button', { name: 'Muokkaa aluetta' }));
    expect(screen.getByRole('region', { name: 'Muokkaa aluetta' })).not.toBeNull();
    expect(screen.queryByRole('button', { name: 'Käytä nykyistä karttanäkymää' })).toBeNull();
    expect(leafletState.draggableMarkers.map((marker) => marker.point)).toEqual(ORIGINAL_AREA);

    const movedPoint = { lat: 60.165, lng: 24.945 };
    act(() => {
      leafletState.draggableMarkers[1].handlers.dragend({
        target: { getLatLng: () => movedPoint },
      });
    });
    const addedPoint = { lat: 60.175, lng: 24.925 };
    act(() => {
      leafletState.handlers.click({ latlng: addedPoint });
    });
    fireEvent.click(screen.getByRole('button', { name: 'Valmis' }));
    fireEvent.click(within(screen.getByRole('dialog', { name: 'Muokkaa' }))
      .getByRole('button', { name: 'Tallenna muutokset' }));

    const payload = JSON.parse(storage.setItem.mock.calls.at(-1)[1]);
    expect(payload.guards[0]).toMatchObject({
      id: 'vahti-1',
      name: 'Koti',
      polygon: [
        ORIGINAL_AREA[0],
        [movedPoint.lat, movedPoint.lng],
        ...ORIGINAL_AREA.slice(2),
        [addedPoint.lat, addedPoint.lng],
      ],
      categories: ['construction'],
      baselineDate: '2026-08-10',
      acknowledged: ['old-notice'],
    });
  });

  it('returns to the editor with the original area when redrawing is cancelled', () => {
    renderApp();
    fireEvent.click(within(screen.getByRole('dialog', { name: 'Muokkaa' }))
      .getByRole('button', { name: 'Muokkaa aluetta' }));
    act(() => {
      leafletState.draggableMarkers[0].handlers.dragend({
        target: { getLatLng: () => ({ lat: 60.15, lng: 24.91 }) },
      });
    });
    fireEvent.click(screen.getByRole('button', { name: 'Peruuta' }));

    const editor = screen.getByRole('dialog', { name: 'Muokkaa' });
    fireEvent.click(within(editor).getByRole('button', { name: 'Tallenna muutokset' }));
    const payload = JSON.parse(storage.setItem.mock.calls.at(-1)[1]);
    expect(payload.guards[0].polygon).toEqual(ORIGINAL_AREA);
  });

  it('lets a newly drawn corner be dragged before the polygon is finished', () => {
    renderApp();
    fireEvent.click(within(screen.getByRole('dialog', { name: 'Muokkaa' }))
      .getByRole('button', { name: 'Sulje' }));
    fireEvent.click(screen.getByRole('button', { name: 'Vahdit ja uudet ilmoitukset: 0' }));
    fireEvent.click(screen.getByRole('button', { name: 'Luo vahti' }));

    const points = [
      { lat: 60.18, lng: 24.92 },
      { lat: 60.18, lng: 24.94 },
      { lat: 60.19, lng: 24.94 },
    ];
    for (const point of points) {
      act(() => { leafletState.handlers.click({ latlng: point }); });
    }

    const currentHandles = leafletState.draggableMarkers.slice(-points.length);
    expect(currentHandles.map((marker) => marker.point)).toEqual(points.map(({ lat, lng }) => [lat, lng]));
    const movedPoint = { lat: 60.185, lng: 24.915 };
    act(() => {
      currentHandles[0].handlers.dragend({ target: { getLatLng: () => movedPoint } });
    });
    fireEvent.click(screen.getByRole('button', { name: 'Valmis' }));
    fireEvent.click(screen.getByRole('button', { name: 'Tallenna vahti' }));

    const payload = JSON.parse(storage.setItem.mock.calls.at(-1)[1]);
    expect(payload.guards.at(-1).polygon).toEqual([
      [movedPoint.lat, movedPoint.lng],
      ...points.slice(1).map(({ lat, lng }) => [lat, lng]),
    ]);
  });
});
