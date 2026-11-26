<script lang="ts">
  import { typeWhole } from "$lib/conductor.svelte";
  import { contextFor, leftPage, type PluginPage, pluginViews, send, showAsked, spendAct } from "$lib/pluginView.svelte";
  import { activeSession, typed } from "$lib/sessions.svelte";
  import { showPlace } from "$lib/show.svelte";
  import { tokenReader } from "$lib/terminal";
  import { printable } from "$lib/terminals.svelte";
  import { theme } from "$lib/theme.svelte";

  /**
   * A plugin's page, in a frame of its own: scripts may run, but with no
   * origin, no storage, no navigation of the window and no forms. The frame
   * takes the page's height, which the page reports through the bridge put
   * in front of it.
   *
   * While a background shows, the page's `html` and `body` are clear, so it
   * is painted as the card it lies on.
   *
   * The bridge is the whole of what crosses. From the page: a place to open
   * in the viewer, a line for the agent, a message for the plugin, a session
   * of the project to bring on screen. To the page: the data its plugin
   * sends while the page is open; the target of the plugin's notification
   * the user clicked to open it; and what is around it, the session on
   * screen and the theme's tokens, told again whenever either changes. The
   * last two are kept for a handler the page sets later. A message is this
   * frame's only when the window it came from is this frame's.
   *
   * A message for the plugin is the user's doing when the user has just
   * clicked or typed in this frame: the click activates this window too,
   * and the frame holds the focus. The plugin may then answer it as it
   * answers an action. A session is brought on screen only on such an act.
   * A webview that cannot say so sends none as the user's.
   */

  interface Props {
    page: PluginPage;
  }

  let { page }: Props = $props();

  // `window.workbench` for the page, over `postMessage`, and the page's own
  // height: the bottom of its last block, which is what the frame should
  // show without a scrollbar.
  const BRIDGE =
    '<script>(function(){var handler=null,target=null,onTarget=null,onContext=null;window.workbench={context:null,open:function(path,from,to,note){parent.postMessage({workbench:"open",path:path,from:from,to:to,note:note===undefined?null:note},"*")},agent:function(text){parent.postMessage({workbench:"agent",text:text},"*")},send:function(payload){parent.postMessage({workbench:"send",payload:payload},"*")},onData:function(fn){handler=fn},onTarget:function(fn){onTarget=fn;if(target!==null)fn(target)},onContext:function(fn){onContext=fn;if(window.workbench.context!==null)fn(window.workbench.context)},show:function(session){parent.postMessage({workbench:"show",session:session},"*")}};addEventListener("message",function(e){var m=e.data;if(m&&m.workbench==="data"&&handler)handler(m.data);if(m&&m.workbench==="target"){target=m.target;if(onTarget)onTarget(target)}if(m&&m.workbench==="context"){var c=m.context,s=document.documentElement.style;window.workbench.context=c;for(var k in c.tokens)s.setProperty("--workbench-"+k,c.tokens[k]);var y=document.getElementById("workbench-clear");if(m.clear){if(!y){y=document.createElement("style");y.id="workbench-clear";document.documentElement.appendChild(y)}y.textContent=":root{color-scheme:"+c.scheme+"!important;background:transparent!important}html body{background:transparent!important}"}else if(y)y.remove();if(onContext)onContext(c)}});function h(){var c=document.body?document.body.children:[],m=0;for(var i=0;i<c.length;i++){var b=c[i].getBoundingClientRect().bottom;if(b>m)m=b}return m>0?m+16:document.documentElement.scrollHeight}function r(){parent.postMessage({workbenchHeight:h()},"*")}addEventListener("load",r);if(window.ResizeObserver&&document.documentElement)new ResizeObserver(r).observe(document.documentElement);setTimeout(r,0)})()<\/script>';

  let frame: HTMLIFrameElement;
  let height = $state(360);
  /** The page the frame has loaded, which is when it can be messaged. */
  let loaded = $state<string | null>(null);
  /** The last message handed over, so one arrives once. */
  let delivered = 0;
  /** The last target handed over, so one arrives once. */
  let targeted = 0;
  /** How many times the frame has loaded, so each document is told what
      is around it. */
  let loads = $state(0);
  /** The context last told, with the load it was told to. */
  let told = "";

  /** A line number as the page gave it, or the fallback. */
  function lineAt(value: unknown, fallback: number): number {
    return typeof value === "number" && Number.isFinite(value) && value > 0
      ? Math.floor(value)
      : fallback;
  }

  /** A place the page asked for, taken as relative to the project, opened
      the way a clicked reference is. */
  function openPlace(data: Record<string, unknown>) {
    const path = typeof data.path === "string" ? data.path : "";
    if (path === "") return;
    const from = lineAt(data.from, 1);
    void showPlace({
      path: `${page.project.replace(/[\\/]+$/, "")}/${path.replace(/^[\\/]+/, "")}`,
      from,
      to: lineAt(data.to, from),
      note: typeof data.note === "string" ? data.note : null,
      cwd: page.project,
      session: null,
    });
  }

  /** A line for the agent, typed at its prompt with no newline, so the user
      reads it and presses Enter. */
  function toAgent(data: Record<string, unknown>) {
    const text = typeof data.text === "string" ? printable(data.text) : "";
    if (text === "") return;
    const session = activeSession();
    if (session === null || session.ptyId === null || session.status !== "running") return;
    // Words on the agent's line that the user has not sent, as their own
    // keys would leave.
    typed(session.ptyId, text);
    typeWhole(session.key, session.ptyId, text).catch(() => {});
  }

  /** Whether the user has just clicked or typed in this frame, which
      `spendAct` lets count once. */
  function acted(): boolean {
    return (
      navigator.userActivation?.isActive === true &&
      document.hasFocus() &&
      document.activeElement === frame
    );
  }

  $effect(() => {
    const onMessage = (e: MessageEvent) => {
      if (e.source !== frame?.contentWindow) return;
      const data = e.data as Record<string, unknown> | null;
      if (data === null || typeof data !== "object") return;
      const reported = data.workbenchHeight;
      if (typeof reported === "number" && Number.isFinite(reported)) {
        height = Math.max(120, Math.min(2400, Math.ceil(reported) + 2));
        return;
      }
      if (data.workbench === "open") openPlace(data);
      else if (data.workbench === "agent") toAgent(data);
      else if (data.workbench === "send") void send(page.key, page.project, data.payload, spendAct(page.key, page.project, acted()));
      else if (data.workbench === "show") showAsked(page.project, data.session, spendAct(page.key, page.project, acted()));
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  });

  // What the plugin sent for the page, handed over once the page is there
  // to take it.
  $effect(() => {
    const message = pluginViews.data;
    if (message === null || loaded !== page.html) return;
    if (message.key !== page.key || message.project !== page.project) return;
    if (message.seq === delivered) return;
    delivered = message.seq;
    frame?.contentWindow?.postMessage(
      { workbench: "data", data: $state.snapshot(message.data) },
      "*",
    );
  });

  // The target of the notification that opened the page, handed over once
  // the page is there to take it.
  $effect(() => {
    const given = pluginViews.target;
    if (given === null || loaded !== page.html) return;
    if (given.key !== page.key || given.project !== page.project) return;
    if (given.seq === targeted) return;
    targeted = given.seq;
    frame?.contentWindow?.postMessage({ workbench: "target", target: given.target }, "*");
  });

  // What is around the page, told once it is there and again when the
  // session on screen, the theme or the background changes. The tokens are
  // read where the frame stands, so they are those of the card it lies on.
  // While a background shows, the bridge also clears the page's own ground,
  // which needs the page in the app's colour scheme: a frame whose scheme
  // differs from the page's is painted opaque.
  $effect(() => {
    if (loaded !== page.html) return;
    void theme.painted;
    const clear = theme.behind !== null;
    const context = contextFor(page.project, tokenReader(frame));
    const said = `${loads}\n${clear}\n${JSON.stringify(context)}`;
    if (said === told) return;
    told = said;
    frame?.contentWindow?.postMessage({ workbench: "context", context, clear }, "*");
  });
</script>

<iframe
  bind:this={frame}
  srcdoc={BRIDGE + page.html}
  sandbox="allow-scripts"
  title={page.plugin}
  onload={() => {
    loaded = page.html;
    loads += 1;
  }}
  onblur={() => leftPage(page.key, page.project)}
  class:waiting={loaded === null}
  style:height="{height}px"
  data-testid="plugin-page"
></iframe>

<style>
  /* The frame is painted in the canvas colour of the scheme it inherits, the
     same scheme the page inside reads as prefers-color-scheme. A strip the
     frame gains before the page repaints, while a column moves, is then the
     colour a page that follows the scheme is about to paint there. */
  iframe {
    width: 100%;
    border: 0;
    border-radius: var(--radius);
    background: Canvas;
  }

  /* Over a background the page lies on the card itself. */
  :global(:root[data-background]) iframe {
    background: transparent;
  }

  /* Until its page has loaded, the frame holds the browser's own empty
     document, which a webview may paint white whatever the scheme. The
     frame keeps its place in the layout but shows nothing until then. */
  iframe.waiting {
    visibility: hidden;
  }
</style>
