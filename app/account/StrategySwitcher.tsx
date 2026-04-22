'use client';

/**
 * StrategySwitcher — three-radio-card strategy picker for /account.
 *
 * Extracted from app/account/page.tsx on 2026-04-22 so the component
 * can be tested in isolation with RTL.
 *
 * Behaviour invariants this component owns:
 *   - Selected state uses brand-gold border + filled indicator block
 *   - Non-selected cards have muted border with brand hover
 *   - `loading` disables the whole fieldset + shows "Updating…" caption
 *   - Click on a card fires `onChange(value)` — parent handles the
 *     idempotent no-op when value === current
 *   - Per-strategy preview lines show concrete budget + pool numbers
 *     sourced from the strategy JSONs (baked in at build time) so
 *     the copy stays accurate without a runtime fetch
 *
 * Does NOT own:
 *   - The POST /api/user/strategy call (parent fires it in onChange)
 *   - Toast feedback on success / error (parent)
 *   - Re-fetching status after the update (parent)
 */

export type StrategyName = 'conservative' | 'balanced' | 'aggressive';

export interface StrategyOption {
  value: StrategyName;
  label: string;
  /** One-line tone blurb describing the risk posture. */
  blurb: string;
  /**
   * One-line concrete preview — budget caps + pool filter criteria
   * pulled from the strategy JSON. "Up to 25 HBAR/session, 10 HBAR/pool.
   * Only pools with 10%+ win rate." style.
   */
  preview: string;
}

/**
 * Default presets sourced from strategies/*.json. Kept inline rather
 * than imported as JSON modules so the display copy stays tight and
 * editable without shipping the full snapshot to the client.
 *
 * If the JSON shapes drift from these summaries, add a test that
 * cross-checks — don't silently let the UI lie.
 */
export const DEFAULT_STRATEGY_OPTIONS: StrategyOption[] = [
  {
    value: 'conservative',
    label: 'Conservative',
    blurb: 'Small entries, only the safest pools. Low variance — slow and steady.',
    preview:
      'Up to 25 HBAR/session, 10 HBAR/pool. Only pools with 10%+ win rate. 1 entry per batch.',
  },
  {
    value: 'balanced',
    label: 'Balanced',
    blurb: 'Medium entries across mid-EV pools. The default — reasonable swings.',
    preview:
      'Up to 100 HBAR/session, 40 HBAR/pool. All pool types. 2 entries per batch.',
  },
  {
    value: 'aggressive',
    label: 'Aggressive',
    blurb: 'Bigger entries, high-EV pools only. More volatility — bigger upside and downside.',
    preview:
      'Up to 500 HBAR/session, 200 HBAR/pool. Prize-rich pools (2+ prizes) only. 5 entries per batch.',
  },
];

export interface StrategySwitcherProps {
  /** Currently active strategy — the matching card renders as selected. */
  value: StrategyName;
  /** Version string shown in the caption (e.g. "0.2"). */
  version: string;
  /** True while the parent's update POST is in flight. Disables the fieldset. */
  loading: boolean;
  /** Fires when the user clicks a card. Parent handles the mutation. */
  onChange: (value: StrategyName) => void;
  /**
   * Override the default preset list — tests inject a stub to avoid
   * coupling assertions to the production copy. In real usage the
   * DEFAULT_STRATEGY_OPTIONS above is the source of truth.
   */
  options?: StrategyOption[];
}

export function StrategySwitcher({
  value,
  version,
  loading,
  onChange,
  options = DEFAULT_STRATEGY_OPTIONS,
}: StrategySwitcherProps) {
  return (
    <>
      <fieldset disabled={loading}>
        <legend className="sr-only">Strategy</legend>
        <div
          role="radiogroup"
          aria-label="Strategy"
          className="grid gap-3 sm:grid-cols-3"
        >
          {options.map((opt) => {
            const isSelected = value === opt.value;
            return (
              <label
                key={opt.value}
                className={`group relative flex cursor-pointer flex-col gap-1.5 border-2 bg-[var(--color-panel)] px-3 py-3 transition-colors ${
                  isSelected
                    ? 'border-brand bg-brand/5'
                    : 'border-secondary hover:border-brand/60'
                } ${loading ? 'cursor-wait opacity-50' : ''}`}
              >
                <input
                  type="radio"
                  name="strategy"
                  value={opt.value}
                  checked={isSelected}
                  onChange={() => onChange(opt.value)}
                  className="sr-only"
                />
                <div className="flex items-center gap-2">
                  {/* Sticker-style indicator — filled brand block
                      when selected, hollow muted when not. */}
                  <span
                    className={`inline-block h-3 w-3 border-2 ${
                      isSelected
                        ? 'border-brand bg-brand'
                        : 'border-secondary'
                    }`}
                    aria-hidden="true"
                  />
                  <span className="font-heading text-sm font-extrabold uppercase tracking-wider text-foreground">
                    {opt.label}
                  </span>
                </div>
                <p className="type-caption">{opt.blurb}</p>
                <p className="type-caption-sm text-muted">{opt.preview}</p>
              </label>
            );
          })}
        </div>
      </fieldset>
      <p className="mt-2 type-caption">
        {loading
          ? 'Updating…'
          : `Active: ${value} (${version}). Changes take effect on the next play session.`}
      </p>
    </>
  );
}
