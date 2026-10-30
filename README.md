# claude-overview

**See every Claude Code session on your machine at once, and which one is waiting on you.**

![Tokens: zero](https://img.shields.io/badge/tokens-zero-2ea043)
![Claude data: read-only](https://img.shields.io/badge/Claude%20data-read--only-2ea043)
![Listens on 127.0.0.1 only](https://img.shields.io/badge/listens%20on-127.0.0.1%20only-2ea043)
![npm dependencies: none](https://img.shields.io/badge/npm%20dependencies-none-2ea043)

![The board updating live: a session turns pink when it needs you, and clicking an agent opens its details](docs/screenshots/demo.gif)

It shows each session with its agents, workflows and background shells, a timeline of every tool call, the files,
servers and sites each session is touching, and your token usage. It only reads files Claude Code already writes, so
it costs no tokens.

The demo and the screenshots show made-up projects.

## Requirements

- Linux, WSL or macOS. macOS support has not been tested on a real Mac yet.
- [Node.js](https://nodejs.org) 20 or later. It has no npm dependencies.
- Claude Code, in VS Code or in the terminal.
- Optional: [cswap](https://github.com/realiti4/claude-swap), to show the plan limits of each account.

## Install

```
npx claude-overview
```

Then open http://127.0.0.1:3100/. It runs until you press Ctrl + C. `npm install -g claude-overview` keeps it
installed, so `claude-overview` starts it.

Or clone this repository and start it in the background from its folder:

```
./overview start
```

- `./overview status` and `./overview stop` do what they say.
- To use another port, set `CLAUDE_OVERVIEW_PORT` before starting it.
- It does not start again by itself after a restart.

## Using it

- Scroll to move around the board, or drag it. Shift + scroll moves sideways.
- Ctrl + scroll (Command on a Mac), a pinch, or Ctrl + and Ctrl - zoom. F fits the board to the window: all of it when
  it fits at a size you can read, otherwise the window's width, and you scroll down for the rest. 0 is full size.
- Shift + F, or the button at the bottom right, goes full screen. S hides or shows the right-hand column, in a window
  wide enough to have one.
- Click a card to see what it is doing, what it has touched and what failed.
- The timeline at the bottom shows every tool call: 15m, 1h, 3h, or Live. T folds it away.
- Usage, or the U key, opens token totals by day, model, session and folder, and the plan limits of each cswap account.
- The tab title counts the sessions that need you. The bell turns on desktop alerts for when the page is not in front:
  a session needs you, something fails or stops and, if you tick it, a session finishes its turn. Clicking an alert
  opens that card. An alert can quote a command or what the session last said, so it can show on your lock screen.
- A reload keeps how you left it: the zoom (and the scroll, in a window of the same size), the open panel, expanded
  groups, the timeline and the right-hand column.

![The whole board: five sessions, the needs-attention list, what they are touching and the timeline](docs/screenshots/overview.png)

![The detail panel of a running agent](docs/screenshots/details.png)

![The usage drawer with plan limits and a week of tokens](docs/screenshots/usage.png)

## What it reads

- `~/.claude/sessions` (or `$CLAUDE_CONFIG_DIR/sessions`), to see which sessions are running.
- The session, agent and workflow transcripts under `~/.claude/projects`.
- The process list, to find background shells: `/proc` on Linux, `ps` and `lsof` on macOS.
- cswap's account list and usage cache, when cswap is installed. Never its credentials.

It never changes any of them. The server listens on 127.0.0.1 only and answers only GET requests. Token totals are
kept in `~/.local/state/claude-overview` (`$XDG_STATE_HOME/claude-overview` when that is set, and
`~/Library/Application Support/claude-overview` on macOS); the first start reads your whole transcript history once, at
low priority.

Token totals come from the transcripts on this machine. Runs started with `claude -p --no-session-persistence`
write no transcript, so they are not counted.

## License

MIT, see [LICENSE](LICENSE). The bundled `vendor/d3.min.js` is [d3](https://d3js.org) under its own ISC license,
in [vendor/d3-LICENSE](vendor/d3-LICENSE).
