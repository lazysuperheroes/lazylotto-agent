'use client';

import { useEffect, useState } from 'react';

// ---------------------------------------------------------------------------
// useFreshness — "Updated 3s ago" timestamp hook
// ---------------------------------------------------------------------------
//
// Takes a "loaded at" epoch ms (number | null) and returns a human-readable
// relative-time string that re-renders every 5 seconds. Used by the
// dashboard to show users how stale each data section is, so the speed
// perception comes from explicit freshness rather than guesswork.
//
// Returns:
//   null   when timestamp is null (data hasn't loaded yet)
//   "just now"     for < 5 seconds
//   "Xs ago"       for < 60 seconds
//   "Xm ago"       for < 60 minutes
//   "Xh ago"       for < 24 hours
//   "Xd ago"       beyond that
//
// The 5-second tick is shared per hook instance via setInterval. Cleaned
// up on unmount. Three concurrent hook instances on the dashboard means
// three intervals — that's fine, they're nearly free, and consolidating
// them into a single context provider would be over-engineering for a
// page-level concern.
//
// Important: do NOT use Date.now() in the render path without this hook.
// Doing so would compute a stale value at render and never refresh until
// the next state change, which might be minutes away.

function formatRelative(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  if (seconds < 5) return 'just now';
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

export function useFreshness(loadedAt: number | null): string | null {
  // Tick every 5 seconds so the relative-time string updates without
  // requiring an external re-render trigger. The state value itself is
  // unused — we only need React to re-evaluate the formatRelative call.
  const [, setTick] = useState(0);

  useEffect(() => {
    if (loadedAt == null) return;
    const id = window.setInterval(() => {
      setTick((t) => t + 1);
    }, 5000);
    return () => window.clearInterval(id);
  }, [loadedAt]);

  if (loadedAt == null) return null;
  return formatRelative(Date.now() - loadedAt);
}
