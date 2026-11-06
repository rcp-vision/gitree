# gitree

`gitree` is a [Claude Code](https://docs.claude.com/en/docs/claude-code) plugin that shows, next to the chat, the
status of all the git repositories nested in the session folder.

## What it shows

The **Repositories** pane lists one repository per row, with four columns:

| Column | Content |
|---|---|
| **Repo** | The repository path, starting from the folder that contains all of them. |
| **Branch** | The current branch. |
| **Status** | The comparison buttons and the status relative to the remote. |
| **Actions** | **Fetch**, plus **Pull** and **Push** when they apply. |

The **Status** column shows only the buttons that apply:

- **Unstaged N** opens the comparison between the index and the working tree, untracked files included.
- **Staged N** opens the comparison between `HEAD` and the index.
- **Unpushed N** opens the comparison between the point where the branch left the upstream and `HEAD`, with the list
  of commits.

Next to the buttons, the column shows "no upstream", "N to pull", or "clean".

The **Fetch**, **Pull**, and **Push** buttons run the git action on a single repository. **Refresh** runs fetch on all
repositories. Repositories in progress stay at the top of the list.

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
  `.direnv`, `.gradle`, `.venv`, and `venv`.
- The status is read again every 30 seconds, without fetching. "Unpushed" and "to pull" refer to the last fetch.
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
