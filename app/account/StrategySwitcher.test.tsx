/**
 * StrategySwitcher — RTL tests.
 *
 * Locks in the radio-card behaviour + the fact that the preview
 * lines show concrete budget/pool criteria, not just generic blurbs.
 */

import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import {
  StrategySwitcher,
  DEFAULT_STRATEGY_OPTIONS,
  type StrategyOption,
} from './StrategySwitcher';

afterEach(() => cleanup());

// Stub options used where a test wants deterministic copy rather than
// asserting against the production DEFAULT_STRATEGY_OPTIONS strings.
const STUB: StrategyOption[] = [
  {
    value: 'conservative',
    label: 'Conservative',
    blurb: 'low variance blurb',
    preview: '25 HBAR/session preview',
  },
  {
    value: 'balanced',
    label: 'Balanced',
    blurb: 'moderate blurb',
    preview: '100 HBAR/session preview',
  },
  {
    value: 'aggressive',
    label: 'Aggressive',
    blurb: 'high variance blurb',
    preview: '500 HBAR/session preview',
  },
];

describe('StrategySwitcher — rendering', () => {
  it('renders all three options with their labels', () => {
    render(
      <StrategySwitcher
        value="balanced"
        version="0.2"
        loading={false}
        onChange={() => {}}
        options={STUB}
      />,
    );
    expect(screen.getByText('Conservative')).toBeInTheDocument();
    expect(screen.getByText('Balanced')).toBeInTheDocument();
    expect(screen.getByText('Aggressive')).toBeInTheDocument();
  });

  it('shows the tone blurb AND the concrete preview for each option', () => {
    render(
      <StrategySwitcher
        value="balanced"
        version="0.2"
        loading={false}
        onChange={() => {}}
        options={STUB}
      />,
    );
    // Tone blurb
    expect(screen.getByText('low variance blurb')).toBeInTheDocument();
    expect(screen.getByText('moderate blurb')).toBeInTheDocument();
    expect(screen.getByText('high variance blurb')).toBeInTheDocument();
    // Concrete numbers preview — the thing that makes the choice
    // informed rather than cryptic
    expect(screen.getByText('25 HBAR/session preview')).toBeInTheDocument();
    expect(screen.getByText('100 HBAR/session preview')).toBeInTheDocument();
    expect(screen.getByText('500 HBAR/session preview')).toBeInTheDocument();
  });

  it('marks the matching value as checked', () => {
    render(
      <StrategySwitcher
        value="aggressive"
        version="0.2"
        loading={false}
        onChange={() => {}}
        options={STUB}
      />,
    );
    const aggressiveRadio = screen.getByRole('radio', { name: /Aggressive/i });
    expect(aggressiveRadio).toBeChecked();
    expect(screen.getByRole('radio', { name: /Balanced/i })).not.toBeChecked();
  });

  it('caption shows the active strategy + version when not loading', () => {
    render(
      <StrategySwitcher
        value="conservative"
        version="0.2"
        loading={false}
        onChange={() => {}}
        options={STUB}
      />,
    );
    expect(
      screen.getByText(/Active: conservative \(0\.2\)/),
    ).toBeInTheDocument();
  });
});

describe('StrategySwitcher — interaction', () => {
  it('fires onChange with the clicked strategy value', () => {
    const onChange = vi.fn();
    render(
      <StrategySwitcher
        value="conservative"
        version="0.2"
        loading={false}
        onChange={onChange}
        options={STUB}
      />,
    );
    fireEvent.click(screen.getByRole('radio', { name: /Aggressive/i }));
    expect(onChange).toHaveBeenCalledWith('aggressive');
  });

  it('does not fire onChange when clicking the already-selected radio', () => {
    // React's radio onChange only fires on a value change. Clicking
    // the currently-selected radio is a no-op at the DOM level — the
    // component correctly inherits this, so parents don't need to
    // worry about redundant POST requests from repeat clicks. The
    // idempotent no-op on the POST endpoint is still useful for
    // external callers (MCP, A2A) but isn't exercised by in-page
    // clicks.
    const onChange = vi.fn();
    render(
      <StrategySwitcher
        value="balanced"
        version="0.2"
        loading={false}
        onChange={onChange}
        options={STUB}
      />,
    );
    fireEvent.click(screen.getByRole('radio', { name: /Balanced/i }));
    expect(onChange).not.toHaveBeenCalled();
  });
});

describe('StrategySwitcher — loading state', () => {
  it('disables all radios while loading', () => {
    render(
      <StrategySwitcher
        value="balanced"
        version="0.2"
        loading
        onChange={() => {}}
        options={STUB}
      />,
    );
    for (const radio of screen.getAllByRole('radio')) {
      expect(radio).toBeDisabled();
    }
  });

  it('swaps caption to "Updating…" while loading', () => {
    render(
      <StrategySwitcher
        value="balanced"
        version="0.2"
        loading
        onChange={() => {}}
        options={STUB}
      />,
    );
    expect(screen.getByText('Updating…')).toBeInTheDocument();
    expect(
      screen.queryByText(/Active: balanced \(0\.2\)/),
    ).not.toBeInTheDocument();
  });
});

describe('DEFAULT_STRATEGY_OPTIONS — production copy', () => {
  // Sanity-check the production defaults so the UI doesn't drift
  // from the strategy JSONs silently. If someone changes a JSON
  // budget cap they need to update the preview string too.
  it('exports three options keyed by the canonical strategy names', () => {
    const names = DEFAULT_STRATEGY_OPTIONS.map((o) => o.value);
    expect(names).toEqual(['conservative', 'balanced', 'aggressive']);
  });

  it('each option has a non-empty label, blurb, and concrete preview', () => {
    for (const opt of DEFAULT_STRATEGY_OPTIONS) {
      expect(opt.label.length).toBeGreaterThan(0);
      expect(opt.blurb.length).toBeGreaterThan(0);
      expect(opt.preview.length).toBeGreaterThan(0);
    }
  });

  it('previews carry concrete numbers (HBAR cap + per-pool) not just tone words', () => {
    // Cheap guard: every preview should mention HBAR and at least one
    // numeric character. If someone drops the concrete numbers and
    // leaves only tone language, this test fails.
    for (const opt of DEFAULT_STRATEGY_OPTIONS) {
      expect(opt.preview).toMatch(/HBAR/);
      expect(opt.preview).toMatch(/\d/);
    }
  });
});
