import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type {
  CompareBlock,
  ComparePayload,
  CompareWheel,
  DiffCommit,
  DiffFile,
  DiffKind,
  DiffRow,
  RepoAction,
  RepoBusy,
  RepoDiff,
  RepoStatus,
} from '../types'

const PANE = 'gitree'
const DIFF_PANE = 'gitree-diff'
// The graphical comparison gets the whole file in the Client props, which hold at most 100,000 characters:
// past this budget the lines stop and the pane says so
const COMPARE_BUDGET = 90_000
// A line longer than this (a minified file) is shortened: on its own it would use up the budget
const COMPARE_LINE_MAX = 1_000
const TAB_WIDTH = 4
// Height of the graphical comparison when the pane does not report how many rows it has
const COMPARE_DEFAULT_ROWS = 30
const COMPARE_MIN_ROWS = 12
const COMPARE_MAX_ROWS = 80
// Removed and added lines in the Box and Text comparison: pastel like the other pane tints
const REMOVED_BACKGROUND = 'rgba(240, 160, 160, 0.22)'
const ADDED_BACKGROUND = 'rgba(140, 210, 160, 0.22)'
// Past these rows the comparison stops and says so: a huge diff must not be drawn row by row
const DIFF_MAX_ROWS = 800
// Context lines around each changed block, as in the EGit comparison with equal parts collapsed
const DIFF_CONTEXT = 6
const TITLE = 'Repositories'
// Repos are searched under the session folder, at any depth within SEARCH_DEPTH; these folders
// are not explored: dependencies, Claude worktrees, environments, caches
const SEARCH_DEPTH = '8'
const SEARCH_DEPTH_LEVELS = Number(SEARCH_DEPTH)
const SKIPPED_FOLDERS = ['node_modules', '.claude', '.direnv', '.gradle', '.venv', 'venv']
const EVERY_MS = 30_000
// Unpushed commits listed above the comparison: past this, the pane says how many are left
const COMMITS_MAX = 50
// A repo on one of these branches, clean and in sync, is not "in progress"
const BASE_BRANCHES = ['master', 'main', 'develop']
// Table column widths; the status takes the rest
const COLUMNS = { repo: '22%', branch: '30%', actions: '24%' } as const
// Semi-transparent pastel backgrounds: they stay readable with both the light and the dark theme
const HEADER_BACKGROUND = 'rgba(160, 180, 230, 0.16)'
const STRIPE_BACKGROUND = 'rgba(170, 215, 200, 0.07)'
// Table buttons: thin dark grey border and one pastel background per action. The native Button accepts
// neither border nor color, so the surrounding Box carries them, one row high: the desktop draws the border as a line
const CHIP_BORDER = '#3a3a3a'
const CHIP_BACKGROUNDS = {
  change: 'rgba(250, 215, 140, 0.55)',
  push: 'rgba(170, 200, 245, 0.55)',
  pull: 'rgba(170, 225, 185, 0.55)',
  fetch: 'rgba(215, 215, 232, 0.6)',
} as const
// Fetch, pull and push go through GitLab and can ask for the key passphrase
const ACTION_TIMEOUT_MS = 180_000
// The key asks for the passphrase on every connection: one shared SSH connection per host, kept open 2 minutes,
// means a fetch of all repos asks once per host and not once per repo
const GIT_ENV = {
  GIT_SSH_COMMAND: 'ssh -o ControlMaster=auto -o ControlPath=/tmp/gitree-ssh-%C -o ControlPersist=120',
}

// On Windows git keeps its own environment: the system OpenSSH rejects ControlMaster and the fetch would fail
function gitEnv(path: string): typeof GIT_ENV | undefined {
  return isWindowsPath(path) ? undefined : GIT_ENV
}

// Change the tag when the RepoStatus fields change: it discards what an earlier version saved
const snapshot = atom({ plugin: 'gitree', key: 'snapshot' } as const, { updatedAt: null, repos: [] }, {
  shape: 'snapshot-3',
})
const busy = atom({ plugin: 'gitree', key: 'busy' } as const, {} as RepoBusy, { shape: 'busy-1' })
const diff = atom({ plugin: 'gitree', key: 'diff' } as const, null as RepoDiff | null, { shape: 'diff-4' })
const wheel = atom({ plugin: 'gitree', key: 'wheel' } as const, { seq: 0, by: 0 } as CompareWheel, {
  shape: 'wheel-1',
})

let isRefreshing = false
// Why the comparison Client failed: the pane falls back to the Box and Text comparison until "Reload"
let compareFault: string | null = null

// A Windows path: drive letter or network path. There `find` is another program (it searches text in files)
// and the system OpenSSH has no shared connection
function isWindowsPath(path: string): boolean {
  return /^[A-Za-z]:[\\/]/.test(path) || path.startsWith('\\\\')
}

// Past this many folders read, the Windows search stops: a session opened on a whole drive does not block the pane
const WALK_MAX_DIRS = 4_000

// On Windows repos are found by reading folders with $.fs: a found repo is not explored, links are not followed
async function walkRepos($: EngineInterface, root: string): Promise<string[]> {
  const found: string[] = []
  let level = [root]
  let visited = 0
  for (let depth = 0; depth <= SEARCH_DEPTH_LEVELS && level.length > 0; depth += 1) {
    const next: string[] = []
    for (const dir of level) {
      if (visited >= WALK_MAX_DIRS) return found.sort()
      visited += 1
      const entries = await $.fs.list(dir).catch(() => [])
      if (entries.some(entry => entry.name === '.git')) {
        found.push(dir)
        continue
      }
      for (const entry of entries) {
        if (entry.kind === 'dir' && !SKIPPED_FOLDERS.includes(entry.name)) next.push(`${dir}\\${entry.name}`)
      }
    }
    level = next
  }
  return found.sort()
}

// The session folder and every nested repo: `.git` is a folder, or a file for worktrees and submodules
async function listRepos($: EngineInterface, root: string): Promise<string[]> {
  if (isWindowsPath(root)) return walkRepos($, root.replace(/[\\/]+$/, ''))
  const skipped = SKIPPED_FOLDERS.flatMap((name, index) => (index === 0 ? ['-name', name] : ['-o', '-name', name]))
  const found = await $.process.run(
    ['find', root, '-maxdepth', SEARCH_DEPTH, '(', ...skipped, ')', '-prune', '-o', '-name', '.git', '-print', '-prune'],
    { timeoutMs: 20_000 },
  )
  return found.stdout
    .split('\n')
    .filter((line: string) => line.length > 0)
    .map((line: string) => line.slice(0, -'/.git'.length))
    .sort()
}

// The deepest folder that contains all repos: if they all sit under `git/`, names start there and the
// Repo column does not repeat a prefix shared by all. A single repo, or the session folder among the repos,
// give the folder above the topmost repo
function commonParent(paths: string[]): string {
  const parents = paths.map(path => slashed(path)).map(path => path.slice(0, path.lastIndexOf('/')))
  if (parents.length === 0) return ''
  let common = parents[0] ?? ''
  for (const parent of parents) {
    while (common.length > 0 && parent !== common && !parent.startsWith(`${common}/`)) {
      common = common.slice(0, common.lastIndexOf('/'))
    }
  }
  return common
}

// Names are computed with forward slashes; git gets the path as is, with backslashes on Windows
function slashed(path: string): string {
  return path.replace(/\\/g, '/')
}

// The displayed name: the path relative to the common folder, or the last segment
function repoName(base: string, original: string): string {
  const root = slashed(base)
  const path = slashed(original)
  if (path.startsWith(`${root}/`)) return path.slice(root.length + 1)
  return path.slice(path.lastIndexOf('/') + 1) || path
}

// Reads the status without fetching: ahead and behind are relative to the remote as of the last fetch
async function repoStatus($: EngineInterface, base: string, path: string): Promise<RepoStatus> {
  const name = repoName(base, path)
  const status: RepoStatus = {
    name,
    path,
    branch: '?',
    upstream: null,
    ahead: 0,
    behind: 0,
    changed: 0,
    staged: 0,
    unstaged: 0,
    untracked: 0,
    error: null,
  }
  const run = await $.process.run(['git', '-C', path, 'status', '--porcelain=v2', '--branch'], { timeoutMs: 15_000 })
  if (run.exitCode !== 0) {
    return { ...status, error: run.stderr.trim().split('\n')[0] ?? 'git status failed' }
  }
  for (const line of run.stdout.split('\n')) {
    if (line.startsWith('# branch.head ')) {
      status.branch = line.slice('# branch.head '.length)
    } else if (line.startsWith('# branch.upstream ')) {
      status.upstream = line.slice('# branch.upstream '.length)
    } else if (line.startsWith('# branch.ab ')) {
      const [ahead, behind] = line.slice('# branch.ab '.length).split(' ')
      status.ahead = Number(ahead?.replace('+', '') ?? 0)
      status.behind = Number(behind?.replace('-', '') ?? 0)
    } else if (line.startsWith('? ')) {
      status.untracked += 1
    } else if (line.startsWith('1 ') || line.startsWith('2 ')) {
      // XY: X the state in the index, Y in the working tree; a dot means unchanged
      status.changed += 1
      if (line[2] !== '.') status.staged += 1
      if (line[3] !== '.') status.unstaged += 1
    } else if (line.startsWith('u ')) {
      // A conflict is resolved in the working tree
      status.changed += 1
      status.unstaged += 1
    }
  }
  return status
}

async function refresh($: EngineInterface): Promise<void> {
  if (isRefreshing) {
    return
  }
  isRefreshing = true
  try {
    const root = await $.session.cwd()
    const paths = await listRepos($, root)
    const base = commonParent(paths) || root
    const repos: RepoStatus[] = []
    for (const path of paths) {
      try {
        repos.push(await repoStatus($, base, path))
      } catch (error) {
        repos.push({
          name: repoName(base, path),
          path,
          branch: '?',
          upstream: null,
          ahead: 0,
          behind: 0,
          changed: 0,
          staged: 0,
          unstaged: 0,
          untracked: 0,
          error: String(error),
        })
      }
    }
    const updatedAt = await $.clock.now()
    await update($, snapshot, () => ({ updatedAt, repos }))
  } finally {
    isRefreshing = false
  }
}

function actionArgv(repo: RepoStatus, action: RepoAction): string[] {
  const git = ['git', '-C', repo.path]
  if (action === 'fetch') return [...git, 'fetch', '--prune']
  // Fast-forward only: a pull from the pane never creates a merge
  if (action === 'pull') return [...git, 'pull', '--ff-only']
  return repo.upstream === null ? [...git, 'push', '-u', 'origin', 'HEAD'] : [...git, 'push']
}

// Starts only from the row button: the person asks for the action, the pane never launches it on its own
async function runAction($: EngineInterface, repo: RepoStatus, action: RepoAction): Promise<void> {
  const current = await read($, busy)
  if (current[repo.name] !== undefined) {
    return
  }
  await update($, busy, state => ({ ...state, [repo.name]: action }))
  $.ui.toast(`${repo.name}: ${action} running, may ask for the key passphrase`)
  try {
    const run = await $.process.run(actionArgv(repo, action), { timeoutMs: ACTION_TIMEOUT_MS, env: gitEnv(repo.path) })
    const detail = (run.exitCode === 0 ? run.stdout || run.stderr : run.stderr).trim().split('\n').pop() ?? ''
    $.ui.toast(
      run.exitCode === 0
        ? `${repo.name}: ${action} succeeded${detail ? ` (${detail})` : ''}`
        : `${repo.name}: ${action} failed, ${detail || `exit code ${run.exitCode}`}`,
    )
  } catch (error) {
    $.ui.toast(`${repo.name}: ${action} not run, ${String(error)}`)
  } finally {
    await update($, busy, state => {
      const { [repo.name]: _done, ...rest } = state
      return rest
    })
    await refresh($)
  }
}

// The two sides of a comparison as git diff arguments: none is the index against the working tree,
// --cached HEAD against the index, a single commit that commit against the working tree
type DiffSides = { revs: string[]; withUntracked: boolean }

// The files changed between the two sides, plus the untracked ones when the new side is the working tree
async function changedFiles($: EngineInterface, path: string, sides: DiffSides): Promise<DiffFile[]> {
  const [numstat, untracked] = await Promise.all([
    $.process.run(['git', '-C', path, 'diff', ...sides.revs, '--numstat'], { timeoutMs: 15_000 }),
    sides.withUntracked
      ? $.process.run(['git', '-C', path, 'ls-files', '--others', '--exclude-standard'], { timeoutMs: 15_000 })
      : Promise.resolve({ stdout: '' }),
  ])
  const files: DiffFile[] = []
  for (const line of numstat.stdout.split('\n')) {
    const [added, removed, ...name] = line.split('\t')
    if (added === undefined || removed === undefined || name.length === 0) continue
    const isBinary = added === '-'
    files.push({
      path: name.join('\t'),
      added: isBinary ? 0 : Number(added),
      removed: isBinary ? 0 : Number(removed),
      isUntracked: false,
      isBinary,
    })
  }
  for (const name of untracked.stdout.split('\n')) {
    if (name.length > 0) files.push({ path: name, added: 0, removed: 0, isUntracked: true, isBinary: false })
  }
  return files
}

// The unified diff becomes side-by-side rows: blocks of removed and added lines are paired line by line
function sideBySide(patch: string): DiffRow[] {
  const rows: DiffRow[] = []
  let left = 0
  let right = 0
  let removed: string[] = []
  let added: string[] = []
  const flush = () => {
    const count = Math.max(removed.length, added.length)
    for (let i = 0; i < count; i += 1) {
      const oldText = removed[i]
      const newText = added[i]
      rows.push({
        left: oldText === undefined ? null : { number: ++left, text: oldText, isChanged: true },
        right: newText === undefined ? null : { number: ++right, text: newText, isChanged: true },
      })
    }
    removed = []
    added = []
  }
  let isInHunk = false
  for (const line of patch.split('\n')) {
    const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(.*)$/.exec(line)
    if (hunk !== null) {
      flush()
      left = Number(hunk[1]) - 1
      right = Number(hunk[2]) - 1
      rows.push({ header: `lines ${hunk[1]} → ${hunk[2]}${hunk[3] ?? ''}` })
      isInHunk = true
    } else if (!isInHunk || line.startsWith('\\')) {
      continue
    } else if (line.startsWith('-')) {
      removed.push(line.slice(1))
    } else if (line.startsWith('+')) {
      added.push(line.slice(1))
    } else if (line.startsWith(' ')) {
      flush()
      rows.push({
        left: { number: ++left, text: line.slice(1), isChanged: false },
        right: { number: ++right, text: line.slice(1), isChanged: false },
      })
    }
  }
  flush()
  return rows
}

// An untracked file is compared with an empty file; --no-index exits with 1 when the files differ
function fileDiffArgv(path: string, file: DiffFile, sides: DiffSides, context: string): string[] {
  return file.isUntracked
    ? ['git', '-C', path, 'diff', '--no-color', context, '--no-index', '--', '/dev/null', file.path]
    : ['git', '-C', path, 'diff', '--no-color', context, ...sides.revs, '--', file.path]
}

async function fileRows($: EngineInterface, path: string, file: DiffFile, sides: DiffSides): Promise<DiffRow[]> {
  const run = await $.process.run(fileDiffArgv(path, file, sides, `-U${DIFF_CONTEXT}`), { timeoutMs: 15_000 })
  return sideBySide(run.stdout)
}

function expandTabs(line: string): string {
  if (!line.includes('\t')) return line
  let out = ''
  for (const char of line) {
    out += char === '\t' ? ' '.repeat(TAB_WIDTH - (out.length % TAB_WIDTH)) : char
  }
  return out
}

// The diff with full context is a single @@ hunk holding the whole file: lines starting with a space
// belong to both sides, those with - and + form the changed blocks
function parseFullDiff(patch: string): { left: string[]; right: string[]; blocks: CompareBlock[] } {
  const left: string[] = []
  const right: string[] = []
  const blocks: CompareBlock[] = []
  let open: CompareBlock | null = null
  let isInHunk = false
  for (const line of patch.split('\n')) {
    if (line.startsWith('@@')) {
      isInHunk = true
      open = null
    } else if (!isInHunk || line.length === 0 || line.startsWith('\\')) {
      continue
    } else if (line.startsWith(' ')) {
      open = null
      left.push(line.slice(1))
      right.push(line.slice(1))
    } else if (line.startsWith('-') || line.startsWith('+')) {
      if (open === null) {
        open = [left.length, 0, right.length, 0]
        blocks.push(open)
      }
      if (line.startsWith('-')) {
        left.push(line.slice(1))
        open[1] += 1
      } else {
        right.push(line.slice(1))
        open[3] += 1
      }
    }
  }
  return { left, right, blocks }
}

// Cuts the comparison at the first aligned row that exceeds the props budget: both sides stop at the
// same point, so the shown part stays paired as in the whole file
function fitCompare(
  parsed: { left: string[]; right: string[]; blocks: CompareBlock[] },
  path: string,
  isUntracked: boolean,
  labels: [string, string],
): ComparePayload {
  let longLines = 0
  const tidy = (line: string) => {
    const expanded = expandTabs(line)
    if (expanded.length <= COMPARE_LINE_MAX) return expanded
    longLines += 1
    return `${expanded.slice(0, COMPARE_LINE_MAX)}…`
  }
  const left = parsed.left.map(tidy)
  const right = parsed.right.map(tidy)
  const cost = (line: string) => JSON.stringify(line).length + 1
  let used = JSON.stringify(path).length
  let l = 0
  let r = 0
  let isTruncated = false
  const blocks: CompareBlock[] = []
  // Advances row by row up to `untilL`/`untilR`; false as soon as the budget runs out
  const take = (untilL: number, untilR: number, block: CompareBlock | null): boolean => {
    while (l < untilL || r < untilR) {
      const rowCost = (l < untilL ? cost(left[l] ?? '') : 0) + (r < untilR ? cost(right[r] ?? '') : 0)
      if (used + rowCost > COMPARE_BUDGET) return false
      used += rowCost
      if (block !== null) {
        if (l < untilL) block[1] += 1
        if (r < untilR) block[3] += 1
      }
      if (l < untilL) l += 1
      if (r < untilR) r += 1
    }
    return true
  }
  for (const [ls, lc, rs, rc] of parsed.blocks) {
    if (!take(ls, rs, null)) {
      isTruncated = true
      break
    }
    const block: CompareBlock = [ls, 0, rs, 0]
    used += JSON.stringify(block).length + 6
    blocks.push(block)
    if (!take(ls + lc, rs + rc, block)) {
      isTruncated = true
      break
    }
  }
  if (!isTruncated && !take(left.length, right.length, null)) isTruncated = true
  return {
    path,
    left: left.slice(0, l),
    right: right.slice(0, r),
    blocks: blocks.filter(([, lc, , rc]) => lc + rc > 0),
    leftTotal: left.length,
    rightTotal: right.length,
    isTruncated,
    longLines,
    isUntracked,
    leftLabel: labels[0],
    rightLabel: labels[1],
  }
}

async function fileCompare(
  $: EngineInterface,
  path: string,
  file: DiffFile,
  sides: DiffSides,
  labels: [string, string],
): Promise<ComparePayload> {
  // Huge context: git puts the whole file in a single hunk, aligned with its diff algorithm
  const run = await $.process.run(fileDiffArgv(path, file, sides, '-U100000000'), { timeoutMs: 15_000 })
  return fitCompare(parseFullDiff(run.stdout), file.path, file.isUntracked, labels)
}

// The two sides and the commits for each kind of comparison. Unpushed commits start from the point where the branch
// left the upstream: commits that reached the remote and are not pulled yet stay out of the comparison
async function diffPlan(
  $: EngineInterface,
  repo: RepoStatus,
  kind: DiffKind,
): Promise<{ sides: DiffSides; labels: [string, string]; commits: DiffCommit[] }> {
  if (kind === 'staged') {
    return { sides: { revs: ['--cached'], withUntracked: false }, labels: ['HEAD', 'Index'], commits: [] }
  }
  if (kind === 'unstaged') {
    // With nothing staged the index matches HEAD: the left side takes the name the reader knows
    const left = repo.staged > 0 ? 'Index' : 'HEAD'
    return { sides: { revs: [], withUntracked: true }, labels: [left, 'Working tree'], commits: [] }
  }
  if (repo.upstream === null) throw new Error('the branch has no upstream')
  const mergeBase = await $.process.run(['git', '-C', repo.path, 'merge-base', 'HEAD', repo.upstream], {
    timeoutMs: 15_000,
  })
  const base = mergeBase.stdout.trim()
  if (mergeBase.exitCode !== 0 || base.length === 0) throw new Error(`no common ancestor with ${repo.upstream}`)
  const log = await $.process.run(
    ['git', '-C', repo.path, 'log', '--format=%h%x09%s', `-n${COMMITS_MAX}`, `${base}..HEAD`],
    { timeoutMs: 15_000 },
  )
  const commits = log.stdout
    .split('\n')
    .filter((line: string) => line.length > 0)
    .map((line: string) => {
      const [hash = '', ...subject] = line.split('\t')
      return { hash, subject: subject.join('\t') }
    })
  return { sides: { revs: [base, 'HEAD'], withUntracked: false }, labels: [repo.upstream, 'HEAD'], commits }
}

// The comparison is read on press and kept: the pane redraws it without running git again
async function showDiff($: EngineInterface, repo: RepoStatus, kind: DiffKind, selected?: string): Promise<void> {
  const path = repo.path
  const { sides, labels, commits } = await diffPlan($, repo, kind)
  const files = await changedFiles($, path, sides)
  const file = files.find(one => one.path === selected) ?? files.find(one => !one.isBinary) ?? null
  const [rows, compare] =
    file === null || file.isBinary
      ? [[], null]
      : await Promise.all([fileRows($, path, file, sides), fileCompare($, path, file, sides, labels)])
  const readAt = await $.clock.now()
  await update($, diff, () => ({
    repo: repo.name,
    branch: repo.branch,
    kind,
    leftLabel: labels[0],
    rightLabel: labels[1],
    commits,
    readAt,
    files,
    selected: file?.path ?? null,
    rows: rows.slice(0, DIFF_MAX_ROWS),
    hiddenRows: Math.max(0, rows.length - DIFF_MAX_ROWS),
    compare,
  }))
  // focus: the link goes straight to the comparison tab, it does not open it behind Repositories
  await $.ui.open({ id: DIFF_PANE, title: `Compare ${repo.name}`, focus: true })
}

function startShowDiff($: EngineInterface, repo: RepoStatus, kind: DiffKind, selected?: string): void {
  showDiff($, repo, kind, selected).catch(error => $.ui.toast(`${repo.name}: comparison not read, ${String(error)}`))
}

let isFetchingAll = false

// One after the other: the first fetch to a host opens the shared connection, the others reuse it
async function fetchAll($: EngineInterface): Promise<void> {
  if (isFetchingAll) {
    return
  }
  isFetchingAll = true
  try {
    const { repos } = await read($, snapshot)
    $.ui.toast(`Fetching ${repos.length} repositories: the passphrase may be needed once per host`)
    const failed: string[] = []
    for (const repo of repos) {
      await update($, busy, state => ({ ...state, [repo.name]: 'fetch' as RepoAction }))
      try {
        const run = await $.process.run(actionArgv(repo, 'fetch'), { timeoutMs: ACTION_TIMEOUT_MS, env: gitEnv(repo.path) })
        if (run.exitCode !== 0) failed.push(repo.name)
      } catch {
        failed.push(repo.name)
      } finally {
        await update($, busy, state => {
          const { [repo.name]: _done, ...rest } = state
          return rest
        })
      }
    }
    $.ui.toast(
      failed.length === 0
        ? `Fetch succeeded on ${repos.length} repositories`
        : `Fetch failed on ${failed.length} of ${repos.length}: ${failed.join(', ')}`,
    )
  } finally {
    isFetchingAll = false
    await refresh($)
  }
}

function startFetchAll($: EngineInterface): void {
  fetchAll($).catch(error => $.ui.log(`gitree: fetch all: ${String(error)}`, { to: 'debug' }))
}

function startAction($: EngineInterface, repo: RepoStatus, action: RepoAction): void {
  runAction($, repo, action).catch(error => $.ui.log(`gitree: ${action} ${repo.name}: ${String(error)}`, { to: 'debug' }))
}

// From the timer, a button or after a command: an error goes to the debug log, it does not bring down the caller
function refreshInBackground($: EngineInterface): void {
  refresh($).catch(error => $.ui.log(`gitree: ${String(error)}`, { to: 'debug' }))
}

function isInProgress(repo: RepoStatus): boolean {
  return (
    repo.error !== null ||
    repo.changed > 0 ||
    repo.untracked > 0 ||
    repo.ahead > 0 ||
    repo.behind > 0 ||
    !BASE_BRANCHES.includes(repo.branch) ||
    repo.upstream === null
  )
}

// The status is always spelled out: color reinforces it, it does not replace it
function describe(repo: RepoStatus): string {
  if (repo.error !== null) {
    return `error: ${repo.error}`
  }
  // Unstaged, Staged and Unpushed are the links next to it: only what has no comparison stays here
  const parts: string[] = []
  if (repo.upstream === null) parts.push(repo.ahead > 0 ? `no upstream, ${repo.ahead} local commits` : 'no upstream')
  if (repo.behind > 0) parts.push(`${repo.behind} to pull`)
  if (parts.length > 0) return parts.join(', ')
  return repo.changed + repo.untracked + repo.ahead > 0 ? '' : 'clean'
}

function color(repo: RepoStatus): 'error' | 'warning' | 'suggestion' | 'success' {
  if (repo.error !== null) return 'error'
  if (repo.changed > 0 || repo.untracked > 0) return 'warning'
  if (repo.ahead > 0 || repo.behind > 0 || repo.upstream === null) return 'suggestion'
  return 'success'
}

// "of the working tree", "of the index", "of HEAD", "of origin/develop"
function ofSide(label: string): string {
  if (label === 'Working tree') return 'of the working tree'
  if (label === 'Index') return 'of the index'
  return `of ${label}`
}

function clockTime(epochMs: number): string {
  const at = new Date(epochMs)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${pad(at.getHours())}:${pad(at.getMinutes())}:${pad(at.getSeconds())}`
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'gitree',
      description: 'Shows repo, branch and status of the git repositories in the session folder',
    })
    void $.ui.open({ id: PANE, title: TITLE })
    refreshInBackground($)
    $.clock.every(EVERY_MS, () => refreshInBackground($))

    return next(e)
  })

  on('command.run', { command: 'gitree' }, async $ => {
    await $.ui.open({ id: PANE, title: TITLE })
    await refresh($)

    return { text: 'Repositories pane opened and refreshed.' }
  })

  // After a git command in the session the status changes: do not wait for the next timer tick
  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    const ran = await next(e)
    if (typeof e.command === 'string' && /\bgit\b/.test(e.command)) {
      refreshInBackground($)
    }

    return ran
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    const { updatedAt, repos } = await read($, snapshot)
    const running = await read($, busy)
    // In progress first, then the clean ones: all of them have at least fetch
    const rows = [...repos.filter(isInProgress), ...repos.filter(repo => !isInProgress(repo))]
    // The terminal does not always draw colors with transparency: no backgrounds there
    const hasBackgrounds = e.surface !== 'terminal'
    // Compact in height: no per-cell borders or vertical margins, a single border around the table
    const cell = { paddingX: 1 } as const
    // On the desktop a plain Button inside a bordered Box; on the terminal the terminal button, "[ label ]",
    // because there the border would add two rows to every table row
    const chip = (key: string, label: string, tint: keyof typeof CHIP_BACKGROUNDS, onPress: () => void) =>
      hasBackgrounds ? (
        <Box
          key={`${key}:chip`}
          borderStyle="single"
          borderColor={CHIP_BORDER}
          backgroundColor={CHIP_BACKGROUNDS[tint]}
          paddingX="xs"
          height={1}
          alignItems="center"
          flexShrink={0}
        >
          <Button key={key} plain onPress={onPress} hover={{ underline: true }}>
            <Text size="caption">{label}</Text>
          </Button>
        </Box>
      ) : (
        <Button key={key} onPress={onPress}>
          <Text size="caption">{label}</Text>
        </Button>
      )

    return (
      <Box flexDirection="column">
        {updatedAt === null && <Text dimColor size="footnote">Reading repositories…</Text>}
        <Box flexDirection="column" borderStyle="single" borderDimColor>
        {rows.length > 0 && (
          <Box flexDirection="row" key="header" backgroundColor={hasBackgrounds ? HEADER_BACKGROUND : undefined}>
            <Box {...cell} width={COLUMNS.repo}>
              <Text weight="semibold" size="footnote">Repo</Text>
            </Box>
            <Box {...cell} width={COLUMNS.branch}>
              <Text weight="semibold" size="footnote">Branch</Text>
            </Box>
            <Box {...cell} flexGrow={1}>
              <Text weight="semibold" size="footnote">Status</Text>
            </Box>
            <Box {...cell} width={COLUMNS.actions}>
              <Text weight="semibold" size="footnote">Actions</Text>
            </Box>
          </Box>
        )}
        {rows.map((repo, index) => {
          const isClean = !isInProgress(repo)
          const action = running[repo.name]
          return (
            <Box
              flexDirection="row"
              key={repo.name}
              backgroundColor={hasBackgrounds && index % 2 === 1 ? STRIPE_BACKGROUND : undefined}
            >
              <Box {...cell} width={COLUMNS.repo}>
                <Text dimColor={isClean} size="footnote">{repo.name}</Text>
              </Box>
              <Box {...cell} width={COLUMNS.branch}>
                <Text mono dimColor={isClean} size="footnote">
                  {repo.branch}
                </Text>
              </Box>
              <Box {...cell} flexGrow={1} flexDirection="row" columnGap={1} alignItems="center">
                {/* As in the EGit Git Staging view: untracked files count among the unstaged */}
                {repo.unstaged + repo.untracked > 0 &&
                  chip(`${repo.name}:diff`, `Unstaged ${repo.unstaged + repo.untracked}`, 'change', () =>
                    startShowDiff($, repo, 'unstaged'),
                  )}
                {repo.staged > 0 &&
                  chip(`${repo.name}:diff-staged`, `Staged ${repo.staged}`, 'change', () =>
                    startShowDiff($, repo, 'staged'),
                  )}
                {repo.ahead > 0 &&
                  repo.upstream !== null &&
                  chip(`${repo.name}:diff-push`, `Unpushed ${repo.ahead}`, 'push', () =>
                    startShowDiff($, repo, 'push'),
                  )}
                {describe(repo).length > 0 && (
                  <Text color={isClean ? undefined : color(repo)} dimColor={isClean} size="footnote">
                    {describe(repo)}
                  </Text>
                )}
              </Box>
              <Box {...cell} width={COLUMNS.actions} flexDirection="row" columnGap={1} alignItems="center">
                {action !== undefined && <Text dimColor size="footnote">{action} running…</Text>}
                {action === undefined &&
                  chip(`${repo.name}:fetch`, 'Fetch', 'fetch', () => startAction($, repo, 'fetch'))}
                {action === undefined &&
                  repo.behind > 0 &&
                  chip(`${repo.name}:pull`, 'Pull', 'pull', () => startAction($, repo, 'pull'))}
                {action === undefined && (repo.ahead > 0 || repo.upstream === null) && repo.error === null && (
                  <Button
                    key={`${repo.name}:push`}
                    variant="primary"
                    onPress={() => startAction($, repo, 'push')}
                  >
                    <Text size="caption">Push</Text>
                  </Button>
                )}
              </Box>
            </Box>
          )
        })}
        </Box>
        <Box flexDirection="row" columnGap={1}>
          <Button key="refresh" onPress={() => startFetchAll($)}>
            <Text size="caption">Refresh (fetch all)</Text>
          </Button>
          {updatedAt !== null && (
            <Text dimColor size="caption">
              read at {clockTime(updatedAt)}; push and pull as of the last fetch
            </Text>
          )}
        </Box>
      </Box>
    )
  })

  on('ui.render', { component: 'Pane', requestId: DIFF_PANE }, async ($, e) => {
    const table = $.ui.resolve(e)
    const { Box, Text, Button } = table
    const shown = await read($, diff)
    if (shown === null) {
      return <Text dimColor>Choose Unstaged, Staged or Unpushed in the Repositories pane.</Text>
    }
    const { repos } = await read($, snapshot)
    const repo = repos.find(one => one.name === shown.repo)
    const selected = shown.files.find(file => file.path === shown.selected)
    // The graphical comparison only on the desktop; terminal, vscode and mobile, or a broken Client, use Box and Text rows
    const Client = e.surface === 'desktop' && 'Client' in table ? table.Client : undefined
    const compare = Client !== undefined && compareFault === null ? shown.compare : null
    const scrolled = await read($, wheel)
    // The comparison takes the height left in the pane: title, bordered file list, notices, buttons
    const roomRows = e.props.scroll.bodyRows
    const commitRows = shown.commits.length > 0 ? shown.commits.length + 3 : 0
    const otherRows = 1 + commitRows + Math.max(1, shown.files.length) + 2 + 2 + 1
    const compareRows =
      roomRows > 0
        ? Math.min(COMPARE_MAX_ROWS, Math.max(COMPARE_MIN_ROWS, roomRows - otherRows))
        : COMPARE_DEFAULT_ROWS
    // As in the EGit comparison: the old side on the left, the new one on the right, changed lines highlighted
    const half = { width: '50%', flexDirection: 'row', columnGap: 1, paddingX: 1 } as const
    // The terminal does not always draw transparency: there the diff theme keys and no header tint
    const isTerminal = e.surface === 'terminal'
    const headerBackground = isTerminal ? undefined : HEADER_BACKGROUND
    const side = (value: { number: number; text: string; isChanged: boolean } | null, which: 'left' | 'right') => (
      <Box
        {...half}
        backgroundColor={
          !value?.isChanged
            ? undefined
            : which === 'left'
              ? isTerminal
                ? 'diffRemoved'
                : REMOVED_BACKGROUND
              : isTerminal
                ? 'diffAdded'
                : ADDED_BACKGROUND
        }
      >
        <Box width={5} flexShrink={0}>
          <Text mono dimColor size="caption">
            {value === null ? '' : String(value.number)}
          </Text>
        </Box>
        <Box flexGrow={1}>
          <Text mono size="footnote">
            {value === null ? ' ' : value.text.length > 0 ? value.text : ' '}
          </Text>
        </Box>
      </Box>
    )

    return (
      <Box flexDirection="column">
        <Box flexDirection="row" columnGap={1}>
          <Text weight="semibold">{shown.repo}</Text>
          <Text mono dimColor>
            {shown.branch}
          </Text>
          <Text size="caption">
            {shown.leftLabel} → {shown.rightLabel}
          </Text>
          <Text dimColor size="caption">
            read at {clockTime(shown.readAt)}
          </Text>
        </Box>
        {shown.commits.length > 0 && (
          <Box flexDirection="column" borderStyle="single" borderDimColor>
            {shown.commits.map(commit => (
              <Box flexDirection="row" columnGap={1} key={`c:${commit.hash}`}>
                <Text mono dimColor size="footnote">
                  {commit.hash}
                </Text>
                <Text size="footnote" wrap="truncate">
                  {commit.subject}
                </Text>
              </Box>
            ))}
            {repo !== undefined && repo.ahead > shown.commits.length && (
              <Text dimColor size="caption">
                … {repo.ahead - shown.commits.length} more commits
              </Text>
            )}
          </Box>
        )}
        <Box flexDirection="column" borderStyle="single" borderDimColor>
          {shown.files.length === 0 && (
            <Text dimColor size="caption">
              No differences between {shown.leftLabel} and {shown.rightLabel}.
            </Text>
          )}
          {shown.files.map(file => (
            <Box flexDirection="row" columnGap={1} key={`f:${file.path}`}>
              <Button
                key={`file:${file.path}`}
                plain
                onPress={() => repo !== undefined && startShowDiff($, repo, shown.kind, file.path)}
              >
                <Text mono size="footnote" weight={file.path === shown.selected ? 'bold' : undefined}>
                  {file.path === shown.selected ? '▸ ' : '  '}
                  {file.path}
                </Text>
              </Button>
              <Text size="caption" color="success">
                {file.isUntracked ? 'new' : file.isBinary ? 'binary' : `+${file.added}`}
              </Text>
              {!file.isUntracked && !file.isBinary && (
                <Text size="caption" color="error">
                  −{file.removed}
                </Text>
              )}
            </Box>
          ))}
        </Box>
        {selected?.isBinary === true && <Text dimColor>Binary file: no line-by-line comparison.</Text>}
        {Client !== undefined && compareFault !== null && (
          <Text dimColor size="caption">
            Graphical comparison unavailable ({compareFault}): showing the changed lines with context.
          </Text>
        )}
        {compare !== null && compare.isTruncated && (
          <Text color="warning" size="caption">
            Comparison truncated: showing {compare.left.length} of {compare.leftTotal} lines {ofSide(compare.leftLabel)} and{' '}
            {compare.right.length} of {compare.rightTotal} lines {ofSide(compare.rightLabel)}; the pane limit is
            100,000 characters.
          </Text>
        )}
        {compare !== null && compare.longLines > 0 && (
          <Text dimColor size="caption">
            {compare.longLines} lines longer than {COMPARE_LINE_MAX} characters are shortened.
          </Text>
        )}
        {Client !== undefined && compare !== null && (
          <Box flexDirection="column" borderStyle="single" borderDimColor>
            <Client
              key="compare"
              module="./compare.tsx"
              props={{ ...compare, readAt: shown.readAt, wheel: scrolled, viewRows: compareRows }}
              height={compareRows}
            />
          </Box>
        )}
        {compare === null && shown.rows.length > 0 && (
          <Box flexDirection="column" borderStyle="single" borderDimColor>
            <Box flexDirection="row" backgroundColor={headerBackground}>
              <Box {...half}>
                <Text weight="semibold" size="footnote">
                  {shown.leftLabel}
                </Text>
              </Box>
              <Box {...half}>
                <Text weight="semibold" size="footnote">
                  {shown.rightLabel}
                </Text>
              </Box>
            </Box>
            {shown.rows.map((row, index) =>
              'header' in row ? (
                <Box key={`r${index}`} paddingX={1} backgroundColor={headerBackground}>
                  <Text mono dimColor size="caption">
                    {row.header}
                  </Text>
                </Box>
              ) : (
                <Box flexDirection="row" key={`r${index}`}>
                  {side(row.left, 'left')}
                  {side(row.right, 'right')}
                </Box>
              ),
            )}
          </Box>
        )}
        {compare === null && shown.hiddenRows > 0 && (
          <Text dimColor size="caption">
            … {shown.hiddenRows} more lines not shown
          </Text>
        )}
        <Box flexDirection="row" columnGap={1}>
          {repo !== undefined && (
            <Button
              key="diff:reload"
              onPress={() => {
                // Reload also retries the graphical comparison after a Client failure
                compareFault = null
                startShowDiff($, repo, shown.kind, shown.selected ?? undefined)
              }}
            >
              <Text size="caption">Reload</Text>
            </Button>
          )}
          <Button key="diff:close" role="dismiss" onPress={() => void $.ui.close({ id: DIFF_PANE })}>
            <Text size="caption">Close</Text>
          </Button>
        </Box>
      </Box>
    )
  })

  // The wheel on the diff pane scrolls the graphical comparison when the pane fits in its space
  // and has nothing of its own to scroll; otherwise it scrolls the pane as usual
  on('ui.scroll', { requestId: DIFF_PANE }, async ($, e, next) => {
    const takeWheel = async (): Promise<boolean> => {
      const shown = await read($, diff)
      const isForCompare =
        shown?.compare != null &&
        compareFault === null &&
        e.origin.kind === 'person' &&
        e.pointer !== undefined &&
        e.contentRows <= e.bodyRows
      if (isForCompare) {
        await update($, wheel, current => ({ seq: current.seq + 1, by: e.by }))
      }
      return isForCompare
    }
    // An error here must not block pane scrolling
    const isTaken = await takeWheel().catch(error => {
      $.ui.log(`gitree: wheel on comparison: ${String(error)}`, { to: 'debug' })
      return false
    })

    return isTaken ? {} : next(e)
  })

  // The comparison Client failed: the engine redraws the pane, which falls back to the Box and Text rows
  on('ui.fault', async ($, e, next) => {
    if (e.requestId === DIFF_PANE) {
      compareFault = e.reason
      $.ui.log(`gitree: graphical comparison (${e.phase}): ${e.reason}`, { to: 'debug' })
    }

    return next(e)
  })
}
