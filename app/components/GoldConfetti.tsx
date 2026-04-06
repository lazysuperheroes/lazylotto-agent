// ---------------------------------------------------------------------------
// GoldConfetti
// ---------------------------------------------------------------------------
//
// A burst of brand-coloured confetti particles raining downward.
// Pure CSS animation via the `confettiFall` keyframe in globals.css —
// no JS animation loop, no canvas, no library dependency. Each particle
// gets randomized left position, delay, duration, colour, size, and
// initial rotation so the burst feels natural rather than mechanical.
//
// Used by:
//   - /auth success moment
//   - dashboard win celebration overlay
//
// Container is `confetti-container` (defined in globals.css) which sets
// position:absolute, pointer-events:none, and overflow:hidden so the
// particles fall within a fixed window without affecting layout.

interface GoldConfettiProps {
  /** How many particles to render. Default 24. */
  count?: number;
}

export function GoldConfetti({ count = 24 }: GoldConfettiProps) {
  const particles = Array.from({ length: count }, (_, i) => ({
    id: i,
    left: `${Math.random() * 100}%`,
    delay: `${Math.random() * 0.6}s`,
    duration: `${1.2 + Math.random() * 1.0}s`,
    color:
      Math.random() > 0.3
        ? '#e5a800' // brand gold (most particles)
        : Math.random() > 0.5
          ? '#fafafa' // off-white accent
          : '#3b82f6', // primary blue accent
    size: `${4 + Math.random() * 4}px`,
    rotation: `${Math.random() * 360}deg`,
  }));

  return (
    <div className="confetti-container" aria-hidden="true">
      {particles.map((p) => (
        <div
          key={p.id}
          className="confetti-particle"
          style={{
            left: p.left,
            animationDelay: p.delay,
            animationDuration: p.duration,
            backgroundColor: p.color,
            width: p.size,
            height: p.size,
            transform: `rotate(${p.rotation})`,
          }}
        />
      ))}
    </div>
  );
}
