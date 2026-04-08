// ---------------------------------------------------------------------------
// Dashboard section skeletons
// ---------------------------------------------------------------------------
//
// Per-section structural placeholders. The previous DashboardSkeleton was
// a single full-page component returned via early-return, which blocked
// EVERYTHING (history, trust, prize-status) until /api/user/status
// resolved. Now each fetch renders its real or skeleton state
// independently, so the dashboard feels alive immediately and history
// shows as soon as it lands — no longer gated on the slowest fetch.
//
// Both skeletons mirror the EXACT shape of the real component they replace:
//   - HeroSkeleton: ComicPanel border, mascot frame, label-caps row,
//     display-xl number block, speech bubble shape, primary CTA slot
//   - HistorySkeleton: three timeline rows
// This means the transition from skeleton → real content has minimal
// paint shift; the user sees the same shape filling in with content.

import { SkeletonBox } from '../components/SkeletonBox';

export function HeroSkeleton() {
  return (
    // Match the ComicPanel shape exactly so the only diff between
    // skeleton and real is "the inner content arrived". No corner
    // sticker — that lands when the real ComicPanel mounts.
    <div className="relative mb-12">
      <div className="relative border-[3px] border-brand halftone-dense panel-shadow">
        <div className="grid gap-6 p-6 sm:p-8 md:grid-cols-[auto_1fr] md:items-center md:gap-10">
          {/* Mascot frame placeholder — same dimensions as the real
              h-auto w-44 mascot block on desktop. */}
          <div className="mx-auto w-32 shrink-0 sm:w-40 md:mx-0 md:w-44">
            <div className="border-2 border-brand bg-[var(--color-panel)] p-2 panel-shadow-sm">
              <SkeletonBox className="aspect-square w-full" />
            </div>
          </div>
          {/* Hero content placeholders — eyebrow, "Pot" label, big number,
              token symbol, speech bubble shape, button slot. */}
          <div className="min-w-0">
            <SkeletonBox className="mb-5 h-3 w-32" />
            <SkeletonBox className="mb-2 h-3 w-12" />
            <SkeletonBox className="mb-3 h-16 w-64 sm:h-20" />
            <SkeletonBox className="mb-6 h-6 w-24" />
            {/* Speech bubble shape — bordered, narrow */}
            <div className="prose-width mt-6 ml-2 border-2 border-brand bg-[var(--color-panel)] px-5 py-4">
              <SkeletonBox className="mb-2 h-3 w-full" />
              <SkeletonBox className="mb-3 h-3 w-3/4" />
              <SkeletonBox className="h-2.5 w-20" />
            </div>
            {/* Play button slot */}
            <SkeletonBox className="mt-6 h-14 w-full" />
          </div>
        </div>
      </div>
    </div>
  );
}

export function HistorySkeleton() {
  return (
    // Three rows so the empty-state slot looks substantive enough that
    // a user with no plays doesn't think the page is broken.
    <div className="divide-y divide-secondary/50">
      {[0, 1, 2].map((i) => (
        <div key={i} className="px-5 py-4">
          <div className="mb-3 flex items-center justify-between">
            <SkeletonBox className="h-4 w-32" />
            <SkeletonBox className="h-4 w-16" />
          </div>
          <div className="flex gap-2">
            <SkeletonBox className="h-6 w-20" />
            <SkeletonBox className="h-6 w-20" />
            <SkeletonBox className="h-6 w-20" />
          </div>
        </div>
      ))}
    </div>
  );
}
