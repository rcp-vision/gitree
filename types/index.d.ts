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
}

export type RepoSnapshot = { updatedAt: number | null; repos: RepoStatus[] }

export type RepoAction = 'fetch' | 'pull' | 'push'

/** The git actions running, by repo name: the row shows "running" instead of the buttons. */
export type RepoBusy = Record<string, RepoAction>

/**
 * What the diff pane compares: `unstaged` the index with the working tree (untracked files included),
 * `staged` HEAD with the index, `push` the point where the branch left the upstream with HEAD.
 */
export type DiffKind = 'unstaged' | 'staged' | 'push'

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
      diff: Shaped<RepoDiff | null>
      wheel: Shaped<CompareWheel>
    }
  }
}
