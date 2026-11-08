export type RepoStatus = {
  /** The path relative to the session folder; `path` is the absolute one. */
  name: string
  path: string
  branch: string
  upstream: string | null
  ahead: number
  behind: number
  changed: number
  /** Files with changes in the index and files with changes not yet staged: the same file can count in both. */
  staged: number
  unstaged: number
  untracked: number
  error: string | null
  /** For a linked worktree, the name of the repo it belongs to; null for a main checkout. */
  worktreeOf: string | null
  /** The full path, only for a worktree outside the session folder: the name alone would not say where it is. */
  location: string | null
  /** The other local branches with commits to push, not checked out anywhere; empty for a linked worktree. */
  others: BranchStatus[]
  /** Local branches left out of `others` because they have no upstream. */
  hidden: number
  /** The linked worktrees of this repo, each with its own status; empty for a worktree. */
  worktrees: RepoStatus[]
}

/** A local branch that is not checked out, with commits its upstream does not have. */
export type BranchStatus = {
  name: string
  upstream: string
  remote: string
  ahead: number
  behind: number
  /** Why `git push <remote> <name>` would not do the right thing: behind its upstream, or tracking another branch. */
  blocked: string | null
}

/** A commit of another branch: abbreviated hash, subject and short age ("6w"). */
export type BranchCommit = { hash: string; subject: string; age: string }

/** The commits to push of the branches the person opened, by `<repo>#<branch>`; `ahead` tells a stale list. */
export type BranchLogs = Record<string, { ahead: number; commits: BranchCommit[] }>

export type RepoSnapshot = { updatedAt: number | null; repos: RepoStatus[] }

export type RepoAction = 'fetch' | 'pull' | 'push'

/** The git actions running, by repo name or by `<repo>#<branch>`: the row shows "running" instead of the buttons. */
export type RepoBusy = Record<string, RepoAction>

/**
 * Sections of the list the person opened or closed: by repo name, `<repo>:others` for its other branches,
 * `<repo>#<branch>` for one of them; `:clean` is the group of clean repos.
 */
export type RepoExpanded = Record<string, boolean>

/**
 * What the diff pane compares: `unstaged` the index with the working tree (untracked files included),
 * `staged` HEAD with the index, `push` the point where the branch left the upstream with HEAD,
 * `branch` the same for another branch, `commit` one commit of another branch with its parent.
 */
export type DiffKind = 'unstaged' | 'staged' | 'push' | 'branch' | 'commit'

/** For `branch` and `commit`: the other branch, and the commit when only one is compared. */
export type DiffTarget = { branch: string; commit: string | null }

/** An unpushed commit: abbreviated hash and subject. */
export type DiffCommit = { hash: string; subject: string }

/** A file changed between the two sides of the comparison; an untracked file has all lines added. */
export type DiffFile = { path: string; added: number; removed: number; isUntracked: boolean; isBinary: boolean }

/** A line on one side of the comparison: line number in the file and text; `isChanged` highlights it. */
export type DiffSide = { number: number; text: string; isChanged: boolean }

/** A row of the side-by-side comparison: a hunk header, or the two sides (one can be missing). */
export type DiffRow = { header: string } | { left: DiffSide | null; right: DiffSide | null }

/**
 * A changed block of the whole file, as git pairs it: `[left start, left lines,
 * right start, right lines]`, with starts counted from 0.
 */
export type CompareBlock = [number, number, number, number]

/**
 * The whole file for the graphical comparison (`hooks/compare.tsx`): the lines of HEAD and of the working
 * tree, the changed blocks, and how much was cut to fit within the `Client` `props` limit.
 */
export type ComparePayload = {
  path: string
  /** Lines of HEAD, tabs expanded; empty for an untracked file. */
  left: string[]
  /** Lines of the working tree; empty for a deleted file. */
  right: string[]
  blocks: CompareBlock[]
  /** Lines of the two whole files: greater than `left.length` and `right.length` if the comparison is truncated. */
  leftTotal: number
  rightTotal: number
  isTruncated: boolean
  /** Lines shortened because they exceed the per-line maximum. */
  longLines: number
  isUntracked: boolean
  /** The names of the two sides, for example "HEAD" and "Working tree". */
  leftLabel: string
  rightLabel: string
}

/** The last wheel turn on the diff pane, passed to the graphical comparison: `seq` tells it apart from the previous one. */
export type CompareWheel = { seq: number; by: number }

/** The `props` of the surface module `hooks/compare.tsx`. */
/** `viewRows`: the rows the pane assigns to the comparison, even when the region reports fewer. */
export type CompareProps = ComparePayload & { readAt: number; wheel: CompareWheel; viewRows: number }

/** The comparison shown in the diff pane: the old side on the left, the new one on the right, as in EGit. */
export type RepoDiff = {
  repo: string
  branch: string
  kind: DiffKind
  target: DiffTarget | null
  leftLabel: string
  rightLabel: string
  /** The unpushed commits, only for `push`. */
  commits: DiffCommit[]
  readAt: number
  files: DiffFile[]
  selected: string | null
  rows: DiffRow[]
  hiddenRows: number
  /** The whole file for the graphical comparison on the desktop; null for a binary file or with no file selected. */
  compare: ComparePayload | null
}

declare module 'claude-code' {
  interface PluginState {
    'gitree': {
      snapshot: Shaped<RepoSnapshot>
      busy: Shaped<RepoBusy>
      expanded: Shaped<RepoExpanded>
      logs: Shaped<BranchLogs>
      diff: Shaped<RepoDiff | null>
      wheel: Shaped<CompareWheel>
    }
  }
}
