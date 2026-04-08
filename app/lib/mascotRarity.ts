'use client';

// ---------------------------------------------------------------------------
// Mascot rarity — the character speaks only at meaningful moments
// ---------------------------------------------------------------------------
//
// Previously the mascot's speech bubble rendered on EVERY dashboard
// visit, pulling from a quip pool via pickCharacterLine(). The critique
// flagged this as "always talking" — the easy version of personality
// that, at scale, turns into Clippy:
//
//   "What if the character was mostly silent and ONLY piped up at
//    specific moments (a win, a loss streak, a first deposit, a long
//    absence)? One line every five interactions, but each line lands."
//
// This module decides whether the character SHOULD speak on this
// render, given:
//
//   - Total visit count (speak on the first 3 visits so new users get
//     the onboarding quips, then back off)
//   - Time since the character last spoke (if it's been > 24h, speak
//     again — long absences get a welcome-back line)
//   - Whether the current state is a "big moment" (first deposit, a
//     pending win to claim, the kill switch just turning on) — these
//     always trigger speech regardless of the quiet window
//   - Session-level overrides (a fresh play session in flight always
//     speaks, because the playingLines are functional feedback, not
//     ambient personality)
//
// The output is a boolean "should speak right now?" that the dashboard
// uses to gate the SpeechBubble render. When the character doesn't
// speak, the mascot frame still shows — the character is present, just
// not chatty.
//
// Persistence: localStorage under 'lazylotto:mascot:*'. SSR-safe via
// typeof-window guards so calling these functions during SSR is a no-op.

const VISIT_COUNT_KEY = 'lazylotto:mascot:visits';
const LAST_SPOKEN_KEY = 'lazylotto:mascot:lastSpokenAt';

/**
 * Read the total dashboard visit count.
 */
export function getVisitCount(): number {
  if (typeof window === 'undefined') return 0;
  const raw = window.localStorage.getItem(VISIT_COUNT_KEY);
  const parsed = raw ? Number(raw) : 0;
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
}

/**
 * Increment the visit counter. Should be called once per dashboard
 * mount (not per render). Returns the new count.
 */
export function bumpVisitCount(): number {
  if (typeof window === 'undefined') return 0;
  const next = getVisitCount() + 1;
  window.localStorage.setItem(VISIT_COUNT_KEY, String(next));
  return next;
}

/**
 * Record that the mascot just spoke. Stamps the current time so
 * future shouldSpeak() calls can compute the quiet window.
 */
export function markSpoken(): void {
  if (typeof window === 'undefined') return;
  window.localStorage.setItem(LAST_SPOKEN_KEY, String(Date.now()));
}

/**
 * Time since the mascot last spoke, in ms. Returns Infinity if never.
 */
export function msSinceLastSpoken(): number {
  if (typeof window === 'undefined') return Number.POSITIVE_INFINITY;
  const raw = window.localStorage.getItem(LAST_SPOKEN_KEY);
  if (!raw) return Number.POSITIVE_INFINITY;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) return Number.POSITIVE_INFINITY;
  return Date.now() - parsed;
}

// ── Speech-gating policy ───────────────────────────────────────

/**
 * Inputs that drive the "should the mascot speak right now?" decision.
 * The dashboard assembles this from the status snapshot + local state
 * and hands it to shouldMascotSpeak().
 *
 * The policy was previously broader — play-in-flight, agent-closed,
 * and pending-claim all forced the bubble to render. But the narrative
 * headline now carries the character's voice for those states directly
 * ("Aadan is at the table right now", "Gordo bagged 150 HBAR —
 * claim it on the dApp, boss"). Keeping the bubble on top of the
 * headline made the character feel like it was repeating itself.
 *
 * New policy: the bubble is a RARE DELIGHT. It only appears for
 * first-run teaching (where the bubble is the primary teaching
 * surface) and the 24h quiet-window welcome-back moment. Everything
 * else is now handled by the headline.
 */
export interface MascotSpeechContext {
  /** True when the user has no balance AND no plays — first-run intro. */
  isFirstRun: boolean;
  /** Total dashboard visits so far (post-bump). */
  visitCount: number;
}

const EARLY_VISITS_THRESHOLD = 3; // speak on visits 1..3
const QUIET_WINDOW_MS = 24 * 60 * 60 * 1000; // 24h between quips

/**
 * The actual policy: should the mascot speak on this render?
 *
 * Rules (first match wins):
 *   1. First-run users ALWAYS speak — the bubble is the character's
 *      primary teaching surface for the Fund → Play → Withdraw loop.
 *   2. Early visits (1..3) ALWAYS speak so new users get character
 *      presence before the rarity kicks in.
 *   3. After the early-visits window, speak only when it's been at
 *      least 24h since the mascot last spoke. This gives returning
 *      users the occasional welcome-back line without the character
 *      blabbering on every visit.
 *
 * When this function returns true, the caller should eventually call
 * markSpoken() to stamp the moment — typically after the bubble has
 * rendered for at least one frame so a render-abort doesn't consume
 * the quiet-window budget.
 */
export function shouldMascotSpeak(ctx: MascotSpeechContext): boolean {
  // First-run users always speak — the bubble teaches the loop
  if (ctx.isFirstRun) return true;

  // Early visits — teach the character to new users
  if (ctx.visitCount > 0 && ctx.visitCount <= EARLY_VISITS_THRESHOLD) return true;

  // Quiet window — only speak if it's been at least 24h
  return msSinceLastSpoken() >= QUIET_WINDOW_MS;
}
