// ---------------------------------------------------------------------------
// ThemePreviewMini
// ---------------------------------------------------------------------------
//
// A miniature hero-panel sample that lives inside the /account Preferences
// radio cards so users can see the comic vs calm treatment side-by-side
// BEFORE they commit to a choice. The comic preview renders with the
// default LazyLotto vocabulary (halftone, hard offset shadow, full-width
// corner sticker). The calm preview wraps in `.theme-preview-calm` so the
// scoped CSS overrides in globals.css take effect regardless of the
// user's current root theme.
//
// Verifies visually that calm mode is "quieter comic" not "generic
// dashboard" — if the preview still reads as LazyLotto, the mode works;
// if it doesn't, the user will immediately see it and know.
//
// Kept presentational + compact: one corner sticker, one halftone panel,
// one mock balance line, one mock action-row button. Just enough surface
// for the differences to show without reproducing the entire dashboard.

export function ThemePreviewMini({ variant }: { variant: 'comic' | 'calm' }) {
  const wrapperClass = variant === 'calm' ? 'theme-preview-calm' : '';

  return (
    <div className={`${wrapperClass} mt-3`} aria-hidden="true">
      <div className="relative">
        {/* Corner sticker — shares the .comic-sticker hook with the
            real ComicPanel label so calm-mode CSS targets both the
            real panels AND this preview with a single selector.
            Uses -top-2 (proportional to the mini's smaller scale)
            instead of the full panel's -top-3. Font size is 10px
            to match the project-wide pixel-font floor; the mini
            previously used text-[8px] which slipped past the
            round-1 sweep because it was added afterward. */}
        <span className="comic-sticker absolute -top-2 left-3 z-10 border border-brand bg-brand px-1.5 py-0.5 font-pixel text-[10px] uppercase tracking-wider text-background panel-shadow-sm leading-none">
          ISSUE #001
        </span>
        {/* Panel itself — halftone-dense in comic mode, flat tint in
            calm mode. Same brand-gold border in both because the border
            is identity, not volume. */}
        <div className="relative border-2 border-brand halftone-dense panel-shadow px-3 pt-4 pb-3">
          <p className="label-caps-lg mb-1 text-muted">Your agent</p>
          <p className="num-tabular text-sm font-semibold text-brand">
            285 HBAR
          </p>
          <p className="mt-1 text-[10px] text-muted">Last run 2h ago</p>
        </div>
      </div>
    </div>
  );
}
