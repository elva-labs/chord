/**
 * Hangs a menu from the element it stands in, whole inside the window. The
 * menu keeps its natural width, its right edge a row's padding in from the
 * anchor's, and moves right where it would cross the window's left edge. It
 * hangs under the anchor, or stands over it when it carries the `up` class
 * or the room under is too small.
 *
 * It is shown as a manual popover, in the top layer, so no pane or list
 * clips it or paints over it, and stays the anchor's child, so events and
 * scoped styles reach it as any other. It follows the anchor while open.
 */
export function hangMenu(node: HTMLElement, options: { gap?: number } = {}) {
  const anchor = node.parentElement!;
  const gap = options.gap ?? 2;
  const edge = 4;
  node.popover = "manual";
  node.showPopover?.();

  /** Whether the anchor is scrolled wholly out of the list holding it. */
  const gone = (at: DOMRect) => {
    for (let box = anchor.parentElement; box !== null; box = box.parentElement) {
      if (!/auto|scroll/.test(getComputedStyle(box).overflowY)) continue;
      const within = box.getBoundingClientRect();
      return at.height > 0 && (at.bottom <= within.top || at.top >= within.bottom);
    }
    return false;
  };

  let placed = "";
  const place = () => {
    const at = anchor.getBoundingClientRect();
    const width = node.offsetWidth;
    const height = node.offsetHeight;
    const inset = parseFloat(getComputedStyle(node).getPropertyValue("--row-pad-x")) || 0;
    const left = Math.max(edge, Math.min(at.right - inset - width, window.innerWidth - width - edge));
    const under = at.bottom + gap;
    const over = at.top - gap - height;
    const fitsUnder = under + height <= window.innerHeight - edge;
    const fitsOver = over >= edge;
    const up = node.classList.contains("up") ? fitsOver || !fitsUnder : !fitsUnder && fitsOver;
    const top = Math.max(edge, Math.min(up ? over : under, window.innerHeight - height - edge));
    const visibility = gone(at) ? "hidden" : "";
    const next = `${left} ${top} ${visibility}`;
    if (next === placed) return;
    placed = next;
    node.style.left = `${left}px`;
    node.style.top = `${top}px`;
    node.style.visibility = visibility;
  };

  let frame = 0;
  const follow = () => {
    place();
    frame = requestAnimationFrame(follow);
  };
  follow();

  return { destroy: () => cancelAnimationFrame(frame) };
}
