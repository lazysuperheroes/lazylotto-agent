'use client';

import {
  useCallback,
  useEffect,
  useId,
  useRef,
  type ReactNode,
} from 'react';

// ---------------------------------------------------------------------------
// Accessible Modal
// ---------------------------------------------------------------------------
//
// A minimal WCAG 2.1 AA-compliant dialog wrapper:
//
//   - role="dialog" + aria-modal="true"
//   - aria-labelledby wired to the title
//   - aria-describedby wired to the description (optional)
//   - Escape key closes (unless `locked` is true, e.g. mid-submit)
//   - Focus moves into the dialog on open (first focusable element)
//   - Focus is trapped — Tab from the last element wraps to the first
//     and Shift-Tab from the first wraps to the last
//   - Focus returns to the element that opened the dialog on close
//   - Click-outside-to-close, also suppressed while `locked`
//   - Body scroll locked while open so background doesn't scroll
//
// Designed to replace bare <div> overlays throughout the app. Keep the
// modal content small and self-contained — this wrapper doesn't do
// fancy stacking, portals, or stacking-context management because we
// only ever show one modal at a time.

interface ModalProps {
  open: boolean;
  onClose: () => void;
  /** Modal title shown in the header. Wired to aria-labelledby. */
  title: string;
  /**
   * Optional short description under the title. Wired to
   * aria-describedby so screen readers announce context.
   */
  description?: string;
  /** Body content — the actual form or confirmation UI. */
  children: ReactNode;
  /**
   * When true, Escape and click-outside become no-ops. Use while a
   * mutation is in-flight so the user can't dismiss mid-submit.
   */
  locked?: boolean;
  /**
   * Optional max-width preset. Defaults to `md` (~28rem) which fits
   * most single-field forms.
   */
  size?: 'sm' | 'md' | 'lg';
  /**
   * Border tone — defaults to brand gold for harmless modals.
   * Use 'destructive' for confirmation dialogs that delete data,
   * revoke tokens, or trigger refunds. The colour is a fast visual
   * signal that the user should slow down before clicking through.
   * Mirrors the ComicPanel tone vocabulary so the two compose
   * cleanly.
   */
  tone?: 'brand' | 'destructive';
}

const SIZE_CLASS: Record<NonNullable<ModalProps['size']>, string> = {
  sm: 'max-w-sm',
  md: 'max-w-md',
  lg: 'max-w-lg',
};

const TONE_BORDER: Record<NonNullable<ModalProps['tone']>, string> = {
  brand: 'border-brand',
  destructive: 'border-destructive',
};

// Tag names considered focusable for the focus trap. Skip elements
// with negative tabindex or the `inert` attribute.
const FOCUSABLE_SELECTOR =
  'a[href], button:not([disabled]), textarea:not([disabled]), ' +
  'input:not([disabled]):not([type="hidden"]), select:not([disabled]), ' +
  '[tabindex]:not([tabindex="-1"])';

// ---------------------------------------------------------------------------
// Module-level scroll-lock counter
// ---------------------------------------------------------------------------
//
// A naive "snapshot body.overflow → restore it on close" is wrong when
// any other code touches body overflow while a modal is open: the modal
// would then restore the stale value. We use a refcount instead:
// increment on mount, decrement on unmount, set `hidden` only when the
// count is 1 → 0 restores the originally-saved value.
//
// Also protects against nested modals (we only ever show one at a time,
// but a future stack would just work).

let scrollLockCount = 0;
let savedBodyOverflow = '';

function acquireScrollLock(): void {
  if (scrollLockCount === 0 && typeof document !== 'undefined') {
    savedBodyOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
  }
  scrollLockCount++;
}

function releaseScrollLock(): void {
  if (scrollLockCount <= 0) return;
  scrollLockCount--;
  if (scrollLockCount === 0 && typeof document !== 'undefined') {
    document.body.style.overflow = savedBodyOverflow;
    savedBodyOverflow = '';
  }
}

/**
 * Decide whether a snapshotted element is still a safe focus target.
 * Returns false when the element has been unmounted, removed from the
 * tab order, or disabled since the modal opened. The Withdraw/Play
 * flows re-render the balance card after success, which means the
 * opener button node that we captured on mount can be gone by the
 * time we try to return focus to it — that would silently move focus
 * to <body> and strand the keyboard user.
 */
function isSafeFocusTarget(el: HTMLElement | null): el is HTMLElement {
  if (!el) return false;
  if (typeof document === 'undefined') return false;
  if (!document.contains(el)) return false;
  if (el.hasAttribute('disabled')) return false;
  const tabIndex = el.getAttribute('tabindex');
  if (tabIndex && Number(tabIndex) < 0) return false;
  return true;
}

export function Modal({
  open,
  onClose,
  title,
  description,
  children,
  locked = false,
  size = 'md',
  tone = 'brand',
}: ModalProps) {
  const dialogRef = useRef<HTMLDivElement>(null);
  // Snapshot the element that had focus when the modal opened so we
  // can restore it on close (keyboard users expect this).
  const returnFocusRef = useRef<HTMLElement | null>(null);
  const titleId = useId();
  const descId = useId();

  // ── Open/close lifecycle ──────────────────────────────────────

  useEffect(() => {
    if (!open) return;

    // Snapshot current focus — we'll return focus here on close unless
    // the element has become unsafe (see isSafeFocusTarget).
    returnFocusRef.current = (document.activeElement as HTMLElement | null) ?? null;

    // Lock body scroll via the counter so nested modals stack correctly
    // and we don't clobber a concurrent overflow value.
    acquireScrollLock();

    // Move focus into the dialog on the next microtask so the DOM
    // is ready. Prefer the first focusable, fall back to the dialog
    // itself (which has tabIndex=-1).
    const moveFocusIn = () => {
      const dialog = dialogRef.current;
      if (!dialog) return;
      const first = dialog.querySelector<HTMLElement>(FOCUSABLE_SELECTOR);
      (first ?? dialog).focus();
    };
    const raf = requestAnimationFrame(moveFocusIn);

    return () => {
      cancelAnimationFrame(raf);
      releaseScrollLock();

      // Return focus to whatever opened the dialog IF it's still a
      // valid target. If not (opener was unmounted by a parent
      // re-render after a successful mutation), fall back to the
      // dialog element — which may also be gone by this point, in
      // which case do nothing and let the browser pick up focus on
      // the next Tab press.
      const target = returnFocusRef.current;
      if (isSafeFocusTarget(target)) {
        target.focus();
      } else if (dialogRef.current && document.contains(dialogRef.current)) {
        dialogRef.current.focus();
      }
      returnFocusRef.current = null;
    };
  }, [open]);

  // ── Keyboard handling ─────────────────────────────────────────

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLDivElement>) => {
      if (e.key === 'Escape' && !locked) {
        e.stopPropagation();
        onClose();
        return;
      }

      if (e.key !== 'Tab') return;

      // Focus trap — wrap from first/last focusable element
      const dialog = dialogRef.current;
      if (!dialog) return;
      const focusables = Array.from(
        dialog.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR),
      );
      if (focusables.length === 0) {
        e.preventDefault();
        return;
      }
      const first = focusables[0]!;
      const last = focusables[focusables.length - 1]!;
      const active = document.activeElement as HTMLElement | null;

      if (e.shiftKey && active === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && active === last) {
        e.preventDefault();
        first.focus();
      }
    },
    [locked, onClose],
  );

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 px-4"
      onClick={() => {
        if (!locked) onClose();
      }}
    >
      {/* The dialog itself wears the comic-book panel vocabulary —
          sharp corners, brand-gold border, neo-brutalist offset
          shadow. The previous incarnation used rounded-xl + soft
          shadow-xl which contradicted everything inside it; now
          the wrapper IS a ComicPanel-shaped surface so any modal
          content inherits the right frame for free.

          Note on focus: the dialog has tabIndex={-1} so the Modal's
          focus-trap logic can programmatically focus it as a fallback
          when no focusable children exist (see isSafeFocusTarget).
          The global :focus-visible rule in globals.css paints a
          brand-gold outline around ANY keyboard-focused element, so
          when the dialog is focused via keyboard, users see a clear
          indicator. We intentionally do NOT add outline-none here —
          the previous version did, and it silently broke the
          fallback focus state for keyboard users. */}
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={description ? descId : undefined}
        tabIndex={-1}
        onClick={(e) => e.stopPropagation()}
        onKeyDown={handleKeyDown}
        className={`w-full ${SIZE_CLASS[size]} border-2 ${TONE_BORDER[tone]} bg-[var(--color-panel)] p-6 panel-shadow`}
      >
        <h3 id={titleId} className="heading-1 mb-2 text-foreground">
          {title}
        </h3>
        {description && (
          <p id={descId} className="type-caption mb-5">
            {description}
          </p>
        )}
        {children}
      </div>
    </div>
  );
}
