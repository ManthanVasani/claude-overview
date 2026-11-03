# Contributing to claude-overview

Bug reports, ideas and pull requests are all welcome.

## Reporting a bug or asking for a feature

Open an [issue](https://github.com/ManthanVasani/claude-overview/issues/new/choose) and pick the form that fits. For a
bug, the versions of claude-overview, Claude Code and Node.js, and your system, help the most.

The board shows your prompts, commands, file paths and session names. Look at a screenshot or a log before you attach
it, and blur what you do not want to be public.

To report a security problem, follow [SECURITY.md](SECURITY.md) instead of opening an issue.

## Running your copy

There is no build step and nothing to install. You need Node.js 20 or later:

```
git clone https://github.com/ManthanVasani/claude-overview.git
cd claude-overview
node server.js
```

Then open http://127.0.0.1:3100/. If another copy already uses that port, start yours with another one, such as
`CLAUDE_OVERVIEW_PORT=3200 node server.js`.

`npm test` runs the checks every pull request runs, on Linux and on macOS. On Linux they include the macOS ones,
through a stand-in for macOS `ps`. Two need tools that may be missing and are skipped without them: `lsof` (and on
Linux procps `ps`), and a C compiler with `strvis` (on Linux it comes from libbsd: `libbsd-dev` on Debian and Ubuntu).

## Where things are

- `server.js` starts the board.
- `lib/` is the server, a module per job: reading the session registry and transcripts (`sessions`, `conversation`,
  `agents`, `workflows`), the process list (`procs`, `shells`, `shell-line`), the tool-call timeline (`steps`,
  `tools`), token usage (`usage`, `usage-scan`, `days`), serving the page and its live updates (`http`, `feed`), and
  what they share (`config`, `constants`, `files`, `text`, `log`).
- `public/` is the page and its scripts.
- `test/` holds the checks, and `test/helpers/` the stand-ins they use for Claude Code's files and processes.

## What a change has to keep

- No npm dependencies. `npx claude-overview@latest` starts the board without installing anything else.
- It reads Claude Code's files and the process list and never writes to them. Its only files are its token totals,
  in the folder [What it reads](README.md#what-it-reads) names, and `overview.log` when `./overview start` runs it.
- It listens on 127.0.0.1 only, answers only GET requests and makes no requests of its own.
- It runs on Linux, macOS and Windows with WSL, on Node.js 20 and later.
- The code matches the code around it. Comments are rare and say why, not what.
- A change in what the board shows comes with a test that fails without it.

## Pull requests

Branch from `main` and open the pull request against `main`. Its template asks what changed, why, and how you checked
it. CI runs `npm test` on Linux and macOS, with Node.js 20 and 24.

Contributions are licensed under the [MIT license](LICENSE), as the rest of the project is.

Everyone taking part follows the [code of conduct](CODE_OF_CONDUCT.md).
