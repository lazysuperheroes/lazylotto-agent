import type { ReactNode } from 'react';

// ---------------------------------------------------------------------------
// ComicPanel
// ---------------------------------------------------------------------------
//
// A reusable "night-shift comic book" container — the structural unit
// of the LazyLotto visual identity.
//
// Features:
//   - Thick brand-gold border (committed colour, not shy)
//   - Darker-than-bg interior so the panel reads as inset on dark mode
//   - Halftone dot texture at low opacity for printed-comic feel
//   - Optional corner sticker label (typed in Press Start 2P) that
//     overhangs the top-left corner like an issue number
//   - Hard neo-brutalist offset shadow (no blur) for panel weight
//   - Sharp/square corners by default; cornerRadius prop for softer
//     variants when needed
//
// Intentional non-features:
//   - No hover effects — this is structural, not interactive
//   - No internal padding preset — callers control layout inside
//   - No max-width — panels adapt to their grid cell
//
// Usage:
//   <ComicPanel label="ISSUE #001" tone="gold">
//     <div className="p-8">...</div>
//   </ComicPanel>

export interface ComicPanelProps {
  children: ReactNode;
  /** Corner sticker text. Rendered in Press Start 2P on brand gold. */
  label?: string;
  /** Extra classes on the outer wrapper (use for margin, width). */
  className?: string;
  /**
   * Halftone density inside the panel.
   * - 'light' (default): subtle, works for info-dense content
   * - 'dense': more visible, reserved for hero moments
   * - 'none': flat interior, no texture
   */
  halftone?: 'light' | 'dense' | 'none';
  /**
   * Border tone. Defaults to brand gold for user-facing panels.
   * 'muted' is for admin/calm contexts — still comic-book shape,
   * just without shouting.
   */
  tone?: 'gold' | 'muted' | 'destructive' | 'success';
  /**
   * Whether to render the neo-brutalist offset shadow. Defaults to
   * true on the outer wrapper — disable for nested/secondary panels
   * where stacked shadows would be noisy.
   */
  shadow?: boolean;
}

const TONE_BORDER: Record<NonNullable<ComicPanelProps['tone']>, string> = {
  gold: 'border-brand',
  muted: 'border-secondary',
  destructive: 'border-destructive',
  success: 'border-success',
};

const TONE_LABEL_BG: Record<NonNullable<ComicPanelProps['tone']>, string> = {
  gold: 'bg-brand text-background',
  muted: 'bg-secondary text-muted',
  destructive: 'bg-destructive text-white',
  success: 'bg-success text-white',
};

export function ComicPanel({
  children,
  label,
  className = '',
  halftone = 'light',
  tone = 'gold',
  shadow = true,
}: ComicPanelProps) {
  const halftoneClass =
    halftone === 'dense'
      ? 'halftone-dense'
      : halftone === 'light'
        ? 'halftone'
        : 'bg-[var(--color-panel)]';

  return (
    <div className={`relative ${className}`}>
      {/* Corner sticker — absolute-positioned so it overhangs the panel
          edge like a real comic issue tag. Raised via z-index so it
          sits on top of the border line. */}
      {label && (
        <span
          className={`absolute -top-3 left-5 z-10 font-pixel text-[9px] uppercase tracking-wider ${TONE_LABEL_BG[tone]} px-2 py-1 leading-none panel-shadow-sm`}
          aria-hidden="true"
        >
          {label}
        </span>
      )}
      <div
        className={`relative border-[3px] ${TONE_BORDER[tone]} ${halftoneClass} ${shadow ? 'panel-shadow' : ''}`}
      >
        {children}
      </div>
    </div>
  );
}
