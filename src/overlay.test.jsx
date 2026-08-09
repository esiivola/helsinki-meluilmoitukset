// @vitest-environment jsdom
import React, { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { Overlay } from './main.jsx';

const t = { close: 'Sulje' };

// The dialog in the app is rendered by a parent that re-renders on every keystroke
// and passes an inline arrow for onClose, so this harness reproduces that exactly.
function NameDialog({ onClose = () => {} }) {
  const [name, setName] = useState('');
  return (
    <Overlay id="watch" title="Luo vahti" onClose={() => onClose()} t={t}>
      <label htmlFor="watch-name">
        Vahdin nimi
        <input id="watch-name" value={name} onChange={(event) => setName(event.target.value)} />
      </label>
    </Overlay>
  );
}

describe('dialog focus', () => {
  it('moves focus to the heading when it opens', () => {
    render(<Overlay id="a" title="Otsikko" onClose={() => {}} t={t}><p>Sisältö</p></Overlay>);
    expect(document.activeElement).toBe(screen.getByRole('heading', { name: 'Otsikko' }));
  });

  it('keeps focus in a text field while the reader types', () => {
    render(<NameDialog />);
    const input = screen.getByLabelText(/Vahdin nimi/);
    input.focus();

    // One letter at a time, as a person types. Each keystroke re-renders the parent
    // and hands the dialog a fresh onClose; focus must not follow that.
    for (const letter of 'Koti') {
      fireEvent.change(input, { target: { value: input.value + letter } });
      expect(document.activeElement).toBe(input);
    }
    expect(input.value).toBe('Koti');
  });

  it('closes on Escape using the handler it holds at that moment', () => {
    const first = vi.fn();
    const second = vi.fn();
    const { rerender } = render(<Overlay id="b" title="B" onClose={first} t={t}><p>x</p></Overlay>);

    rerender(<Overlay id="b" title="B" onClose={second} t={t}><p>x</p></Overlay>);
    fireEvent.keyDown(document, { key: 'Escape' });

    expect(second).toHaveBeenCalledTimes(1);
    expect(first).not.toHaveBeenCalled();
  });

  it('returns focus to whatever opened it, and only when it closes', () => {
    render(<button type="button" id="opener">Avaa</button>);
    const opener = document.getElementById('opener');
    opener.focus();

    const view = render(<Overlay id="c" title="C" onClose={() => {}} t={t}><p>x</p></Overlay>);
    expect(document.activeElement).not.toBe(opener);

    view.unmount();
    expect(document.activeElement).toBe(opener);
  });

  it('stops listening for Escape once it is gone', () => {
    const onClose = vi.fn();
    const view = render(<Overlay id="d" title="D" onClose={onClose} t={t}><p>x</p></Overlay>);
    view.unmount();
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onClose).not.toHaveBeenCalled();
  });
});
