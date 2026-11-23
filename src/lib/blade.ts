/**
 * Blade, the mark's arrival in the welcome and in About.
 *
 * The disc fades and grows in, a cut runs across it along the chord, the
 * gap springs open behind the cut, and the pink runs out from the cut over
 * the top part. Each window holds an empty beat before it starts.
 *
 * The mark's geometry is the icon's: a circle of radius 480 about (512,
 * 512), cut by a chord 42 degrees off the horizontal. In a frame turned by
 * that angle the cut is the band from y -249.8 to -191.8.
 *
 * Everything here is arithmetic on time; BladeMark draws a frame.
 */

/** A cubic bezier easing, solved for x. */
export function bezier(x1: number, y1: number, x2: number, y2: number): (x: number) => number {
  return (x) => {
    if (x <= 0) return 0;
    if (x >= 1) return 1;
    let t = x;
    for (let i = 0; i < 8; i++) {
      const cx = 3 * (1 - t) * (1 - t) * t * x1 + 3 * (1 - t) * t * t * x2 + t * t * t - x;
      const d = 3 * (1 - t) * (1 - t) * x1 + 6 * (1 - t) * t * (x2 - x1) + 3 * t * t * (1 - x2);
      if (Math.abs(d) < 1e-6) break;
      t = Math.min(1, Math.max(0, t - cx / d));
    }
    return 3 * (1 - t) * (1 - t) * t * y1 + 3 * (1 - t) * t * t * y2 + t * t * t;
  };
}

export const EASE = {
  out: bezier(0.16, 1, 0.3, 1),
  soft: bezier(0.4, 0, 0.2, 1),
  slice: bezier(0.75, 0, 0.18, 1),
  back: bezier(0.34, 1.42, 0.64, 1),
  move: bezier(0.62, 0, 0.14, 1),
};

/** How far `t` is through the span from `a` to `b`, from 0 to 1, eased. */
export function span(t: number, a: number, b: number, ease?: (x: number) => number): number {
  const p = Math.min(1, Math.max(0, (t - a) / (b - a)));
  return ease ? ease(p) : p;
}

export const CUT_TOP = -249.8;
export const CUT_HEIGHT = 58;
export const CUT_MID = -220.8;
/** The cut's normal, along which the top part lifts. */
export const NORMAL = { x: 0.6691, y: -0.7431 };

/** The empty beat before the mark starts, in milliseconds. */
export const BEAT = 500;
/** How long Blade runs, in milliseconds. */
export const DURATION = 1280;

/** One frame of the mark. */
export interface Frame {
  /** The whole mark's opacity and scale. */
  opacity: number;
  scale: number;
  /** Where the gap starts along the cut, how far it reaches, and how
      high it is open. */
  gapX: number;
  gapWidth: number;
  gapHeight: number;
  /** The glint on the cut's tip while it travels. */
  glint: { x: number; opacity: number } | null;
  /** How far the top part stands off along the cut's normal. */
  lift: number;
  /** Whether the pink shows, and how far up from the cut it has run. */
  accent: number;
  wipe: number;
}

/** The finished mark. */
export const DONE: Frame = {
  opacity: 1,
  scale: 1,
  gapX: -700,
  gapWidth: 1400,
  gapHeight: CUT_HEIGHT,
  glint: null,
  lift: 0,
  accent: 1,
  wipe: 1,
};

/** The mark `t` milliseconds into Blade. */
export function blade(t: number): Frame {
  if (t >= DURATION) return DONE;
  const cut = span(t, 430, 760, EASE.slice);
  const open = span(t, 730, 1090, EASE.back);
  const settle = span(t, 760, 1180);
  const tip = -640 + 1280 * cut;
  return {
    opacity: span(t, 0, 240, EASE.soft),
    scale: 0.84 + 0.16 * span(t, 0, 460, EASE.out),
    gapX: -700,
    gapWidth: cut >= 1 ? 1400 : tip + 700,
    gapHeight: cut <= 0 ? 0 : 6 + (CUT_HEIGHT - 6) * open,
    glint: cut > 0 && cut < 1 ? { x: tip, opacity: 0.85 * Math.sin(Math.PI * cut) ** 0.4 } : null,
    lift: 20 * Math.sin(Math.PI * settle ** 0.5) * (1 - settle),
    accent: t < 800 ? 0 : 1,
    wipe: span(t, 800, 1280, EASE.out),
  };
}

/** After the mark, the welcome holds, moves the mark to the top and brings
    the rest in, one piece after another. In milliseconds from Blade's end. */
export const HOLD = 110;
export const MOVE = 640;
export const LIST = 360;
export const STEP = 55;
export const RISE = 430;

/** How far the mark has moved from the middle to its place at the top,
    eased, `after` milliseconds from Blade's end. */
export function moved(after: number): number {
  return span(after - HOLD, 0, MOVE, EASE.move);
}

/** How far the `index`th piece has come in, eased, `after` milliseconds
    from Blade's end. */
export function arrived(after: number, index: number): number {
  const start = HOLD + LIST + index * STEP;
  return span(after, start, start + RISE, EASE.out);
}

/** The style of a piece `q` of the way in: it fades in as it rises the
    last 12 pixels. Nothing once it is in. */
export function risen(q: number): string {
  return q >= 1 ? "" : `opacity: ${q}; transform: translateY(${(1 - q) * 12}px)`;
}

/** When the welcome's motion is over, in milliseconds from the window
    opening, for `pieces` pieces brought in. */
export function welcomeEnds(pieces: number): number {
  return BEAT + DURATION + HOLD + LIST + pieces * STEP + RISE;
}
