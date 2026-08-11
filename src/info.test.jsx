// @vitest-environment jsdom
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';

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
      map: vi.fn(() => map),
      tileLayer: vi.fn(() => layer()),
    },
  };
});

import App from './main.jsx';

const manifest = {
  schemaVersion: 1,
  generatedAt: '2026-08-11T03:00:00Z',
  totalNotices: 0,
  chunks: [{ key: 'current', file: 'notices-current.json', count: 0 }],
};

function renderApp() {
  vi.stubGlobal('fetch', vi.fn(async (url) => ({
    ok: true,
    json: async () => (String(url).endsWith('index.json') ? manifest : { notices: [] }),
  })));
  render(<App />);
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('service information', () => {
  it('puts the Finnish maker attribution and website before the service description', () => {
    renderApp();
    fireEvent.click(screen.getByRole('button', { name: 'Tietoa palvelusta' }));

    const dialog = screen.getByRole('dialog', { name: 'Tietoa palvelusta' });
    const maker = within(dialog).getByText('Sivuston tekijä: Eero Siivola');
    const website = within(dialog).getByRole('link', { name: 'esiivola.github.io' });
    const lead = within(dialog).getByText('Kartta näyttää Helsingin kaupungin meluilmoituksista antamat päätökset.');

    expect(within(dialog).getByText(/Sivuston tekijän kotisivut:/).contains(website)).toBe(true);
    expect(website.getAttribute('href')).toBe('https://esiivola.github.io/');
    expect(website.querySelector('strong')).not.toBeNull();
    expect(maker.compareDocumentPosition(lead) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('uses idiomatic English terms for the same concepts', () => {
    renderApp();
    fireEvent.click(screen.getByRole('button', { name: 'FI, vaihda kieleksi englanti' }));

    expect(screen.getByRole('button', { name: 'Area alerts and new noise notifications: 0' })).not.toBeNull();
    expect(screen.getByText('Public event')).not.toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'About this service' }));

    const dialog = screen.getByRole('dialog', { name: 'About this service' });
    expect(within(dialog).getByText('Created by Eero Siivola')).not.toBeNull();
    expect(within(dialog).getByText(/Creator’s website:/).contains(
      within(dialog).getByRole('link', { name: 'esiivola.github.io' }),
    )).toBe(true);
    expect(within(dialog).getByText(/Area alerts and their boundaries are stored in this browser/)).not.toBeNull();
    expect(within(dialog).queryByText(/\bWatches\b/)).toBeNull();
  });
});
