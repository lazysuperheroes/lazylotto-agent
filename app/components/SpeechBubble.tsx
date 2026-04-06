import type { ReactNode } from 'react';

// ---------------------------------------------------------------------------
// SpeechBubble — character quip container with comic-book tail
// ---------------------------------------------------------------------------
//
// A boxy speech bubble with a brand-gold border and a CSS triangle tail
// pointing at the speaker. Used in the dashboard hero so the mascot's
// quip looks like the character is actually speaking, not just a stylish
// pull-quote with no relationship to the image next to it.
//
// The tail is built with the classic two-triangle CSS technique:
// an outer triangle in the border colour and an inner triangle in the
// background colour, slightly offset, so the tail picks up the panel
// border without needing SVG.
//
// Tail position can be left/right/top/bottom — defaults to left because
// the dashboard hero has the mascot to the left of the bubble on
// desktop. On mobile the layout stacks vertically and the tail can
// switch to top via the `tailPosition` prop or just stay left and read
// fine.

export interface SpeechBubbleProps {
  children: ReactNode;
  /** Where the bubble's tail points. Default 'left'. */
  tailPosition?: 'left' | 'right' | 'top';
  /** Optional className on the outer wrapper. */
  className?: string;
}

const TAIL_WRAPPER_CLASS: Record<NonNullable<SpeechBubbleProps['tailPosition']>, string> = {
  left: 'before:absolute before:left-[-14px] before:top-6 before:h-0 before:w-0 before:border-y-[10px] before:border-r-[14px] before:border-y-transparent before:border-r-brand after:absolute after:left-[-10px] after:top-[26px] after:h-0 after:w-0 after:border-y-[8px] after:border-r-[12px] after:border-y-transparent after:border-r-[var(--color-panel)]',
  right:
    'before:absolute before:right-[-14px] before:top-6 before:h-0 before:w-0 before:border-y-[10px] before:border-l-[14px] before:border-y-transparent before:border-l-brand after:absolute after:right-[-10px] after:top-[26px] after:h-0 after:w-0 after:border-y-[8px] after:border-l-[12px] after:border-y-transparent after:border-l-[var(--color-panel)]',
  top: 'before:absolute before:left-8 before:top-[-14px] before:h-0 before:w-0 before:border-x-[10px] before:border-b-[14px] before:border-x-transparent before:border-b-brand after:absolute after:left-[34px] after:top-[-10px] after:h-0 after:w-0 after:border-x-[8px] after:border-b-[12px] after:border-x-transparent after:border-b-[var(--color-panel)]',
};

export function SpeechBubble({
  children,
  tailPosition = 'left',
  className = '',
}: SpeechBubbleProps) {
  return (
    <div
      className={`relative border-2 border-brand bg-[var(--color-panel)] px-5 py-4 panel-shadow-sm ${TAIL_WRAPPER_CLASS[tailPosition]} ${className}`}
    >
      {children}
    </div>
  );
}
