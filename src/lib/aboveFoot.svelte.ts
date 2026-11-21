import { untrack } from "svelte";
import { agentVisible, layout } from "$lib/layout.svelte";
import { sessions } from "$lib/sessions.svelte";

/** The room kept between a floating ask and the foot it stands above. */
const GAP = 12;
/** The room kept between a floating ask and the window's edges. */
const EDGE = 24;
/** Where an ask stands from the window's bottom with no conversation on
    screen to stand above. */
const LOW = 28;

/** The conversation on screen, while the agent pane shows it. */
function conversationOnScreen(): HTMLElement | null {
  if (!agentVisible()) return null;
  return document.querySelector<HTMLElement>('[data-testid="conversation"].active');
}

/** A conversation's foot, its composer or ended bar with the dock above,
    while it is drawn. */
function footOf(conversation: HTMLElement | null): HTMLElement | null {
  const foot = conversation?.querySelector<HTMLElement>(":scope > [data-foot]") ?? null;
  if (foot === null) return null;
  const rect = foot.getBoundingClientRect();
  return rect.width > 0 && rect.height > 0 ? foot : null;
}

/**
 * An action for an ask that floats over the window: it stands above the
 * foot of the conversation on screen, centred over it, so it never covers
 * the composer or the dock, and is kept inside the window. Its height is
 * held to the room above the foot. With no conversation on screen it
 * stands low in the window's middle. It is placed again when the foot or
 * the ask changes size, the window does, the conversation on screen
 * changes, or that conversation draws its foot or a gate instead. The
 * element is placed by its centre, so its style keeps `translateX(-50%)`.
 */
export function aboveFoot(node: HTMLElement) {
  let foot: HTMLElement | null = null;
  const sizes = new ResizeObserver(() => place());
  const parts = new MutationObserver(() => watch());

  function place() {
    const half = node.offsetWidth / 2;
    const rect = foot?.isConnected ? foot.getBoundingClientRect() : null;
    const middle = rect === null ? innerWidth / 2 : rect.left + rect.width / 2;
    const centre = Math.max(EDGE + half, Math.min(middle, innerWidth - EDGE - half));
    const bottom = rect === null ? LOW : Math.max(LOW, innerHeight - rect.top + GAP);
    node.style.left = `${centre}px`;
    node.style.bottom = `${bottom}px`;
    node.style.maxHeight = `${Math.max(0, innerHeight - bottom - EDGE)}px`;
  }

  function watch() {
    sizes.disconnect();
    parts.disconnect();
    const conversation = conversationOnScreen();
    foot = footOf(conversation);
    sizes.observe(node);
    if (conversation !== null) {
      sizes.observe(conversation);
      parts.observe(conversation, { childList: true });
    }
    if (foot !== null) sizes.observe(foot);
    place();
  }

  const stop = $effect.root(() => {
    $effect(() => {
      void sessions.active;
      void layout.mode;
      void agentVisible();
      untrack(watch);
    });
  });
  addEventListener("resize", place);
  return {
    destroy() {
      stop();
      sizes.disconnect();
      parts.disconnect();
      removeEventListener("resize", place);
    },
  };
}
