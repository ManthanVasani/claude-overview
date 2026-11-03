# Accessibility

claude-overview should work for you with a keyboard, a screen reader, high zoom and reduced motion, and without telling
things apart by colour. It does not do all of that yet. This page says what works, what does not, and how to report a
barrier. The yardstick is WCAG 2.2 level AA, and a barrier you report is treated as a bug: fixed, or listed here until
it is.

The parts of the board named below (cards, the Needs attention list, the Touching list, the live feed, the timeline and
Usage) are described under [Using it](README.md#using-it) in the README.

It was last checked against version 0.3.2, in November 2026, in headless Chromium on Linux: with scripted key presses,
the accessibility tree, Lighthouse, contrast ratios computed from the page's colours, a colour-blindness simulation, and
emulated forced colours and zoom (zoom as the window size it gives). No screen reader, real browser zoom, Windows
contrast theme or person using assistive technology has tried it yet.

## Where it runs

- The board runs on your own machine: Linux, macOS, or Windows through WSL, with Node.js 20 or later. The page has not
  yet been tried on a Mac.
- You open it in a browser on that same machine, at http://127.0.0.1:3100/ by default. It cannot be opened from
  another device, such as a phone or tablet with its own assistive technology.
- Only Chromium has been tested. The page uses recent CSS, so an older browser may not lay it out right. Firefox and
  Safari have not been tried.

## What works

- The buttons in the bottom row, the timeline's header, the side column's tabs and the Usage panel are standard
  buttons: Tab reaches them, and Enter or Space presses them. Toggle buttons say whether they are on.
- Cards take focus in turn, and Enter or Space opens a card's details. Esc closes them. Rows in Needs attention,
  Touching and the live feed open with Enter.
- Most focused controls and cards show a blue outline. The exceptions are listed below.
- The keys listed under Using it in the README zoom and fit the board, fold the timeline and open Usage. The arrow keys,
  Page Up, Page Down, Home and End move around the board, except while focus is in a card's details or the
  desktop-alerts menu.
- The desktop-alerts menu, opened from the bell button in the bottom row, moves focus into itself, and Esc closes it
  and puts focus back on the bell.
- The page has a language, landmarks and headings. Each card is announced by its name and state, such as "Release
  notes, Needs you".
- On the board, each kind of state has its own icon shape (a spinner while it works, a ringing dot when it needs you, a
  check when it is done, a cross when it failed, and so on), and session cards also print the state as a word, so no
  state is shown by colour alone. The usage limits print their percentage.
- The page's three text colours meet a 4.5:1 contrast ratio on every background they are used on. The exceptions are
  listed below.
- With reduced motion turned on in your system, the page's CSS animations and transitions stop. The exceptions are
  listed below.
- The page makes no sound of its own. Desktop alerts are off until you turn them on; when they are on, your system may
  play its notification sound.

## Known limitations

### Keyboard

- The timeline can only be used with a mouse or touch: a keyboard cannot open a call from it, show a session's agents
  or move back in time. Moving back in time needs a drag or a scroll wheel, and its height can only be changed by
  dragging. Its buttons work from the keyboard, and T folds it.
- Opening a card's details does not move focus to them. Their Close button comes after every other control in the Tab
  order, and while a session is busy, focus inside the details is lost each time they refresh, every few seconds. Esc
  still closes them.
- These rows open another item with a mouse only: Started by, the child agents, Touched most, Who touched it and Every
  touch in a card's details, and Top sessions in Usage.
- The New session and Session died notices that pop up disappear after 8 seconds, cannot be focused, and open their
  card with a mouse only.
- There are no skip links. Tab goes through every card, the bottom row and the side column's rows before it reaches
  the timeline.
- The Tab order can jump up and down within a column when cards move.
- The one-key shortcuts (F, 0, +, -, T, L, S, U) cannot be turned off or changed.
- Ctrl + and Ctrl - zoom the board, not the page, wherever focus is, and over the board so do Ctrl + scroll and a
  pinch. To zoom the page, use the browser's menu; Ctrl 0 still resets the page's zoom.
- Space does not open a row in Needs attention, Touching or the live feed; Enter does.

### Screen readers

- A card is announced by its name and state only. What it is doing, its branch, model and counts are only in its
  details, and the board does not say which session an agent, workflow or shell belongs to.
- The timeline has no text version. The Touching list and the most recent tool calls are text, in the side column,
  which a narrow window does not show (see below). The usage chart's values per day show only on mouse hover.
- Changes are not announced: a session that needs you, a new problem, the New session and Session died notices, the
  counts and a lost connection. Desktop alerts are not shown while the page is in front.
- A card's details are marked to be read out when they change, and they change every few seconds while a session is
  busy, so a screen reader may keep talking.
- Rows in Needs attention, Touching and the live feed are not announced as things that open something.
- In a narrow timeline, the buttons that filter by kind of tool are named by their count only.
- Which card is selected is shown only by its look, and the zoom button is named by its percentage only. Whether
  desktop alerts are on is in the bell's tooltip, not its name; the switch in its menu does say it.
- A card's details are an unnamed region, not a dialog. The page has no top-level heading, and the counts at the bottom
  left and the bottom row are outside its landmarks.

### Colour and contrast

- There is only a dark theme. In forced-colours mode, which Windows' contrast themes turn on, you cannot tell whether a
  toggle button is on, and the timeline does not follow the theme. This was seen in emulation.
- The DONE and ENDED labels, and the FAILED, LOST, DIED and STOPPED labels, are below 4.5:1. So are the dimmed rows
  of finished agents, an account turned off in Usage, the agent counts on the timeline, and the other cards while you
  hover one.
- Colour alone tells apart the kinds of tool on the timeline, the state dot beside each session on the timeline, and
  the model families in the usage chart. In a simulation of deuteranopia, Reads and Agents on the timeline look
  alike.

### Motion

- With reduced motion on, the dots that run along the board's links still move, and the links still slide when cards
  move.
- If you change the reduced-motion setting while the page is open, part of the page follows only after a reload.
- There is no control to pause the animations, and the live feed pauses only while the pointer is over it.

### Zoom and small windows

- If the page is narrower than 1180 CSS pixels, the side column with Touching and the live feed is not shown, and S
  does not bring it back. At 200% zoom that is any window narrower than 2360 pixels at normal zoom.
- In a window 640 pixels wide or less, the bell button is hidden, so desktop alerts cannot be turned on or off there,
  and at 400 pixels or less so is the full-screen button. When the timeline is 560 pixels wide or less, its filters
  are hidden.
- In a window the size 400% zoom gives (measured at 320 by 256 CSS pixels), the board is covered by its own controls.
- In a narrow window, a focused card can sit under the Needs attention list or past the edge, and the board does not
  move to show it.
- When the Needs attention list floats over the board, a focused row in it is hard to see.
- With larger text spacing, the last Touching tab is cut off.

## Reporting a barrier

Open an [issue](https://github.com/ManthanVasani/claude-overview/issues/new/choose), preferably a blank one, since the
bug report form asks for version details you may not need, and start its title with "Accessibility:". Say what you
tried to do and what got in the way, your browser and its version, any assistive technology you use (a screen reader,
a magnifier, voice control) and its version, your zoom or window size, and your system. GitHub issues are the only way
to report one.

The board shows your prompts, commands, file paths and session names. Look at a screenshot or a recording before you
attach it, and blur what you do not want to be public.
