# gitree

`gitree` is a [Claude Code](https://docs.claude.com/en/docs/claude-code) plugin that shows, next to the chat, the
status of all the git repositories nested in the session folder.

## What it shows

The **Repositories** pane is a vertical list made for the narrow side panel. Each repository is a section that opens
and closes:

- **Closed**, a section shows the repository name, the counters (● changed files, ↑ commits to push, ↓ commits to pull,
  and the number of branches when there is more than one) and the current branch. A clean repository shows a check.
- **Open**, a section lists the branches of the repository: first the ones checked out in a folder (the current branch,
  in bold, and the git worktrees, with a folder icon, also those outside the session folder), then the other local
  branches that have commits to push. Branches without an upstream that are not checked out stay hidden.

An open branch shows its state (unstaged and staged files, commits to push and to pull) and, on one line, the actions
that apply now:

- **unstaged** opens the comparison between the index and the working tree, untracked files included.
- **staged** opens the comparison between `HEAD` and the index.
- **commits** opens the comparison between the point where the branch left the upstream and the branch, with the list
  of commits.
- **Push** pushes the branch, also a branch that is not checked out (`git push <remote> <branch>`). A branch that is
  behind its upstream, or that tracks a branch with another name, says why it cannot be pushed.
- **Pull** pulls with fast-forward only, for a branch checked out in a folder.
- **Fetch**, next to the current branch, fetches the repository: one fetch brings all its remote branches.

The commits of a branch that is not checked out are read when it opens; each one opens its own comparison. **Fetch all**
fetches every repository once, worktrees included. A legend under the list explains the counters.

On the desktop the comparison is graphical, in the style of the EGit Compare Editor: two sides next to each other,
connectors between the changed blocks, and scroll bars. On the terminal the comparison shows the changed lines with
their context.

## Installation

In Claude Code, add the marketplace and install the plugin:

```text
/plugin marketplace add rcp-vision/gitree
/plugin install gitree@rcp-vision
```

The pane opens at the start of every session. If you close it, reopen it with `/gitree`.

## Behaviour

- The plugin searches the session folder for repositories up to 8 levels deep. It skips `node_modules`, `.claude`,
  `.direnv`, `.gradle`, `.venv`, and `venv`. It then asks git for the worktrees of each repository, also those outside
  the session folder, except the ones in a skipped folder.
- The status is read again every 30 seconds, without fetching. Commits to push and to pull refer to the last fetch.
- On Linux and macOS, fetch, pull, and push share one SSH connection per host for 2 minutes, so the key passphrase is
  asked once per host.
- On Windows the plugin finds repositories by reading folders, and does not explore a repository it has found. Git
  uses its usual SSH environment.

## Development

The code is in `hooks/register.tsx` (panes and commands) and `hooks/compare.tsx` (graphical comparison on the
desktop). The state types are in `types/index.d.ts`.

If you want to try a change, start Claude Code with the plugin folder:

```bash
claude --plugin-dir /PATH/TO/gitree
```

On the first load Claude Code generates the types in `.claude-plugin/types/`. Then you can run the checks:

```bash
claude plugin validate .
```

```bash
claude plugin test .
```

```bash
npx -p typescript@5 tsc -p .
```

## License

[MIT](LICENSE).
