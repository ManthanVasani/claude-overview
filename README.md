# claude-overview

A live view of every Claude Code session on your machine: each session with its agents, workflows and background
shells, a timeline of every tool call, the files, servers and sites each session is touching, and your token usage.
It only reads files Claude Code already writes, so it costs no tokens.

![The board with four sessions, the needs-attention list, what they are touching and the timeline](docs/screenshots/overview.png)

The screenshots show made-up projects.

## Requirements

- Linux, WSL or macOS. macOS support has not been tested on a real Mac yet.
- [Node.js](https://nodejs.org). There are no packages to install.
- Claude Code, in VS Code or in the terminal.
- Optional: [cswap](https://github.com/realiti4/claude-swap), to show the plan limits of each account.

## Install

Clone or download this repository, then start it from its folder:

```
./overview start
```

Then open http://127.0.0.1:3100/.

- `./overview status` and `./overview stop` do what they say.
- To use another port, set `CLAUDE_OVERVIEW_PORT` before `./overview start`.
- It does not start again by itself after a restart: run `./overview start`.

## Using it

- Scroll to move around the board, or drag it. Shift + scroll moves sideways.
- Ctrl + scroll (Command on a Mac), a pinch, or Ctrl + and Ctrl - zoom. F fits the board to the window: all of it when
  it fits at a size you can read, otherwise the window's width, and you scroll down for the rest. 0 is full size.
- Shift + F, or the button at the bottom right, goes full screen. S hides or shows the right-hand column, in a window wide enough to have one.
- Click a card to see what it is doing, what it has touched and what failed.
- The timeline at the bottom shows every tool call: 15m, 1h, 3h, or Live. T folds it away.
- Usage, or the U key, opens token totals by day, model, session and folder, and the plan limits of each cswap account.
- A reload keeps how you left it: the zoom (and the scroll, in a window of the same size), the open panel, expanded
  groups, the timeline and the right-hand column.

![The detail panel of a running agent](docs/screenshots/details.png)

![The usage drawer with plan limits and a week of tokens](docs/screenshots/usage.png)

## What it reads

- `~/.claude/sessions` (or `$CLAUDE_CONFIG_DIR/sessions`), to see which sessions are running.
- The session, agent and workflow transcripts under `~/.claude/projects`.
- The process list, to find background shells: `/proc` on Linux, `ps` and `lsof` on macOS.
- cswap's account list and usage cache, when cswap is installed. Never its credentials.

It never changes any of them. The server listens on 127.0.0.1 only and answers only GET requests. Token totals are
kept in `usage-index.json` beside the code; the first start reads your whole transcript history once, at low priority.

Token totals come from the transcripts on this machine. Runs started with `claude -p --no-session-persistence`
write no transcript, so they are not counted.

## License

MIT, see [LICENSE](LICENSE). The bundled `vendor/d3.min.js` is [d3](https://d3js.org) under its own ISC license,
in [vendor/d3-LICENSE](vendor/d3-LICENSE).
