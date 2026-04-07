import type { ReactNode } from 'react';

// ---------------------------------------------------------------------------
// ActionBurst — the LazyLotto signature comic motif
// ---------------------------------------------------------------------------
//
// A 14-spike SVG starburst polygon, stroked in ink and filled with brand
// gold (or any tone), with a centered text slot for callouts like
// "WIN!", "BIG WIN!", "POW!", "NEW!". This is the recurring visual
// fingerprint that ties the dashboard to the LazyVerse comic IP — used
// big for win celebrations, small as a featured-pool sticker, etc.
//
// The polygon is generated programmatically with alternating outer/inner
// radii so it reads as an irregular comic-book burst rather than a
// regular star. 14 spikes is the sweet spot — enough to feel chaotic,
// few enough to render cleanly at small sizes.
//
// Sizing: pass `size` in pixels (defaults to 160). Text inside scales
// with the burst via clamp() relative to the wrapper width.

export interface ActionBurstProps {
  /** Text to render in the centre of the burst (e.g. "WIN!", "POW!"). */
  children?: ReactNode;
  /** Burst diameter in pixels. Default 160. */
  size?: number;
  /** Fill colour of the burst body. Default brand gold. */
  tone?: 'brand' | 'destructive' | 'success' | 'foreground';
  /** Optional className on the outer wrapper for positioning. */
  className?: string;
}

const TONE_FILL: Record<NonNullable<ActionBurstProps['tone']>, string> = {
  brand: 'var(--color-brand)',
  destructive: 'var(--color-destructive)',
  success: 'var(--color-success)',
  foreground: 'var(--color-foreground)',
};

const TONE_TEXT: Record<NonNullable<ActionBurstProps['tone']>, string> = {
  brand: 'text-background',
  destructive: 'text-foreground',
  success: 'text-background',
  foreground: 'text-background',
};

// Generate the 14-spike burst polygon as an SVG points string. Centered
// at (100, 100) in a 200×200 viewBox so the wrapper just needs to size
// the SVG; coordinates are stable.
function buildBurstPoints(spikes: number, outerR: number, innerR: number): string {
  const pts: string[] = [];
  const total = spikes * 2;
  for (let i = 0; i < total; i++) {
    const r = i % 2 === 0 ? outerR : innerR;
    // Start at the top (-π/2) so the first spike points up
    const angle = (i * Math.PI) / spikes - Math.PI / 2;
    const x = 100 + r * Math.cos(angle);
    const y = 100 + r * Math.sin(angle);
    pts.push(`${x.toFixed(2)},${y.toFixed(2)}`);
  }
  return pts.join(' ');
}

const BURST_POINTS = buildBurstPoints(14, 95, 60);

export function ActionBurst({
  children,
  size = 160,
  tone = 'brand',
  className = '',
}: ActionBurstProps) {
  return (
    <div
      className={`relative inline-flex items-center justify-center ${className}`}
      style={{ width: size, height: size }}
      aria-hidden="true"
    >
      <svg
        viewBox="0 0 200 200"
        className="absolute inset-0 h-full w-full"
        // The drop shadow gives the burst a comic-book "popped off the
        // page" feel — hard offset, no blur, ink colour to match the
        // page background tint.
        style={{
          filter: 'drop-shadow(4px 4px 0 var(--color-ink))',
        }}
      >
        <polygon
          points={BURST_POINTS}
          fill={TONE_FILL[tone]}
          stroke="var(--color-ink)"
          strokeWidth="3"
          strokeLinejoin="miter"
        />
      </svg>
      {children && (
        <span
          className={`relative z-10 font-heading font-extrabold uppercase leading-none tracking-tight ${TONE_TEXT[tone]}`}
          style={{
            // Text scales with burst size: ~22% of width is comfortable
            fontSize: `${Math.max(14, size * 0.22)}px`,
            // Slight rotation gives the text a playful "stamped" angle
            transform: 'rotate(-6deg)',
          }}
        >
          {children}
        </span>
      )}
    </div>
  );
}
