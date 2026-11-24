# Layout

The window has three panes: projects and sessions on the left, the agent in the middle, and the changes on the right. Below them sits a panel for plain shells, and along the foot a status bar. The [layout reference](reference/layout.md) describes all of it in full.

## The three shapes

- **Working**: the three panes. The agent takes whatever room the side panes leave. With no project open the changes pane stays away, and the agent pane says `Open a project to start.` over Open project. With a project and no session on screen, it offers New session.
- **Reviewing**: the changes pane grows into a file viewer and the sessions pane folds. Open a file or press <kbd>Cmd</kbd><kbd>D</kbd> to enter it, and <kbd>Esc</kbd> to leave.
- **Editing**: the file tree and an editor take the middle, and the agent moves to the right pane, still running. Switch with Agent and Editor in the top right corner, or <kbd>Shift</kbd><kbd>Cmd</kbd><kbd>E</kbd>.

## Showing and hiding panes

| Keys | Does |
| --- | --- |
| <kbd>Cmd</kbd><kbd>B</kbd> | Fold or open the sessions pane |
| <kbd>Cmd</kbd><kbd>\\</kbd> | Hide or show the right pane |
| <kbd>Cmd</kbd><kbd>J</kbd> | Hide or show the terminal panel |
| <kbd>Cmd</kbd><kbd>1</kbd> to <kbd>4</kbd> | Focus sessions, agent, changes or terminal |

A folded sessions pane keeps a narrow column with each project's session dots. When the window gets too narrow for three panes, the sessions pane folds first and the changes pane next, and they come back when there is room. See [what gives way](reference/layout.md#what-gives-way-in-order).

## Dividers

Drag the gap between two panes to resize them. Double-click it to go back to the default width. A pane keeps the size you chose: a narrow window draws it smaller for the moment, and it widens back once there is room. With the divider focused, the arrow keys move it, by more with <kbd>Shift</kbd>. See [dividers](reference/layout.md#dividers).

## Compact mode

A setting under Appearance that takes the sessions pane out of the layout. It slides in over the other panes when the pointer reaches the window's left edge, or with <kbd>Cmd</kbd><kbd>1</kbd> or <kbd>Cmd</kbd><kbd>B</kbd>. See [compact mode](reference/layout.md#compact-mode).

## The status bar

The row along the window's foot names the branch the session on screen works on and, with more than one account, the account and how much of its allowance is used. At its right end it says how many sessions wait for you. The session's state is on its row's dot, and its model on the composer; a terminal session, which has no composer, says it on the agent pane's header. See [the status bar](reference/layout.md#the-status-bar).

## The terminal panel

Plain shells under the panes. <kbd>Cmd</kbd><kbd>J</kbd> shows and hides the panel, <kbd>Cmd</kbd><kbd>T</kbd> opens a new shell, and <kbd>Cmd</kbd><kbd>W</kbd> closes the one in front. A shell belongs to the session that was on screen when it was opened, and goes with it. Shells can be split side by side. See [the terminal panel](reference/layout.md#the-terminal-panel).

## The field above the tree

The field at the top of the changes pane narrows the tree to matching paths. <kbd>Cmd</kbd><kbd>F</kbd> filters files, and <kbd>Shift</kbd><kbd>Cmd</kbd><kbd>F</kbd> searches inside them. A folder you open or close yourself stays that way, through restarts too. See [the field above the tree](reference/layout.md#the-field-above-the-tree).

## Under the tree

Folds at the foot of the tree's column hold what the agent has presented (Media), the sessions the one on screen has started, the processes running under the project, the session's browser tabs, and sections that plugins add. See [under the tree](reference/layout.md#under-the-tree).

## The viewer

The viewer shows a file's diff or its source, and renders Markdown, HTML, Mermaid and SVG, images and PDFs. <kbd>Cmd</kbd><kbd>E</kbd> switches between the views. See [inside the viewer](reference/layout.md#inside-the-viewer).

## Editor mode

In editor mode the tree keeps a column on the left and the editor takes the rest, with the agent on the right. [Editor](editor.md) says what the editor does, and [editor mode](reference/layout.md#editor-mode) how the panes are sized.

## Zoom

<kbd>Cmd</kbd><kbd>=</kbd> and <kbd>Cmd</kbd><kbd>-</kbd> zoom the terminal or editor that has focus, and <kbd>Cmd</kbd><kbd>0</kbd> puts it back. See [zoom](reference/layout.md#zoom).

On Windows and Linux, read <kbd>Ctrl</kbd> for <kbd>Cmd</kbd> throughout. A few shortcuts differ there; [focus](focus-model.md) has the full table.
