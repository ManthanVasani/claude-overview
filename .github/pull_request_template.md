## Context

<!-- The problem this solves or what it adds, and the issue it closes, if there is one. -->

## Design

<!-- What changed, and why it is done this way. -->

Checked:

<!-- How you know it works: the tests you added and what you saw on a running board. -->

- `npm test` passes.

### Risks

<!-- What could break, for whom, and how they would notice. "None" is fine. -->

- [ ] No new npm dependency.
- [ ] Claude Code's files are only read, never written.
- [ ] It still listens on 127.0.0.1 only, answers only GET requests and makes no requests of its own.
- [ ] A change in what the board shows comes with a test that fails without it.
