// ---------------------------------------------------------------------------
// SkeletonBox
// ---------------------------------------------------------------------------
//
// A single placeholder rectangle for loading states. Intentionally minimal —
// just an animated bar in the secondary panel tone. Compose multiple boxes
// into shapes that mirror the real layout so the page doesn't reflow when
// data lands.
//
// Used by:
//   - app/dashboard/page.tsx (full DashboardSkeleton + inline history rows)
//   - app/account/page.tsx (profile loading state)
//
// Extracted from inline duplication during the /normalize polish pass so
// both pages share one source of truth for the placeholder treatment.

export function SkeletonBox({ className = '' }: { className?: string }) {
  return <div className={`animate-pulse rounded bg-secondary/50 ${className}`} />;
}
