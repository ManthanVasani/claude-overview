# Security policy

## Supported versions

Fixes go into the next release on npm, so only the latest version gets them. `npx claude-overview@latest` always
starts the latest one.

## Reporting a vulnerability

Please report it privately through GitHub, not in a public issue: on the repository's **Security** tab, choose
**Report a vulnerability** ([direct link](https://github.com/ManthanVasani/claude-overview/security/advisories/new)).

Say what someone could do with it, how to reproduce it, and which version you ran (`claude-overview --version`, or
`npx claude-overview@latest --version`).

## What the board promises

claude-overview is meant to be safe to leave running:

- It reads Claude Code's files and the process list, and never writes to them.
- It listens on 127.0.0.1 only and answers only GET requests.
- It makes no network requests of its own, and the page loads nothing from other sites.
- It never reads cswap's credentials.

A way around any of these is a vulnerability. So is text from a session (a prompt, a command, a file name, a
transcript line) that makes the page run script.
