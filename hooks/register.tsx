import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, RenderChildren } from 'claude-code'

import type {
  BranchCommit,
  BranchLogs,
  BranchStatus,
  CompareBlock,
  ComparePayload,
  CompareWheel,
  DiffCommit,
  DiffFile,
  DiffKind,
  DiffRow,
  DiffTarget,
  RepoAction,
  RepoBusy,
  RepoDiff,
  RepoExpanded,
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
// The list is a column of sections, narrow enough for the dock beside the transcript
const PANE_COLUMNS = 44
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
// Semi-transparent pastel backgrounds: they stay readable with both the light and the dark theme
const HEADER_BACKGROUND = 'rgba(160, 180, 230, 0.16)'
// The counters beside a repo name: a pastel background and a stronger text of the same hue, readable with
// both the light and the dark theme; on the terminal only the text color
const PILLS = {
  changes: { color: '#b07400', background: 'rgba(250, 215, 140, 0.35)' },
  ahead: { color: '#3b66c4', background: 'rgba(170, 200, 245, 0.35)' },
  behind: { color: '#8357b8', background: 'rgba(205, 180, 240, 0.35)' },
  neutral: { color: '#6b7380', background: 'rgba(190, 195, 205, 0.3)' },
  error: { color: '#c0392b', background: 'rgba(240, 160, 160, 0.3)' },
  worktree: { color: '#2f7d7a', background: 'rgba(150, 215, 210, 0.3)' },
} as const
const LINK_COLOR = '#3b66c4'
// The git branch icon, in the color of the neutral pills; colors as attributes, since a <style> may be stripped
// A folder, for the worktrees: same stroke and size as the branch icon
const FOLDER_ICON =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" fill="none" stroke="#6b7380" stroke-width="1.6" stroke-linejoin="round">' +
  '<path d="M1.8 4.2c0-.6.5-1.1 1.1-1.1h3.3l1.5 1.6h5.4c.6 0 1.1.5 1.1 1.1v6.4c0 .6-.5 1.1-1.1 1.1H2.9c-.6 0-1.1-.5-1.1-1.1z"/></svg>'
const BRANCH_ICON =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" fill="none" stroke="#6b7380" stroke-width="1.6" stroke-linecap="round">' +
  '<circle cx="4.5" cy="3.5" r="1.8"/><circle cx="4.5" cy="12.5" r="1.8"/><circle cx="11.5" cy="5" r="1.8"/>' +
  '<path d="M4.5 5.3v5.4"/><path d="M11.5 6.8c0 2.6-7 2-7 3.9"/></svg>'
// An open section is a card: a faint tint under its lines
const CARD_BACKGROUND = 'rgba(160, 165, 180, 0.07)'
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
  shape: 'snapshot-5',
})
const busy = atom({ plugin: 'gitree', key: 'busy' } as const, {} as RepoBusy, { shape: 'busy-1' })
const sections = atom({ plugin: 'gitree', key: 'expanded' } as const, {} as RepoExpanded, { shape: 'expanded-1' })
const logs = atom({ plugin: 'gitree', key: 'logs' } as const, {} as BranchLogs, { shape: 'logs-1' })
const diff = atom({ plugin: 'gitree', key: 'diff' } as const, null as RepoDiff | null, { shape: 'diff-5' })
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

// Paths compared as Windows does: slashes and case do not matter, nor a final slash
function samePath(path: string): string {
  return slashed(path).replace(/\/+$/, '').toLowerCase()
}

// A worktree inside a skipped folder (Claude worktrees under `.claude`) stays out, as in the folder search
function isInSkippedFolder(path: string): boolean {
  return slashed(path)
    .split('/')
    .some(segment => SKIPPED_FOLDERS.includes(segment))
}

type Worktree = { path: string; isMain: boolean }

// `git worktree list --porcelain`: one block per worktree, the main checkout first; missing and bare ones are left out
function parseWorktrees(stdout: string): Worktree[] {
  const found: Worktree[] = []
  for (const block of stdout.split(/\n\s*\n/)) {
    const lines = block.split('\n')
    const head = lines.find(line => line.startsWith('worktree '))
    if (head === undefined) continue
    if (lines.some(line => line === 'bare' || line.startsWith('prunable'))) continue
    found.push({ path: head.slice('worktree '.length).trim(), isMain: found.length === 0 })
  }
  return found
}

// "6 weeks ago" → "6w"; "1 year, 2 months ago" keeps the first part
function shortAge(relative: string): string {
  const match = /^(\d+) (second|minute|hour|day|week|month|year)/.exec(relative)
  if (match === null) return relative
  const units: Record<string, string> = { second: 's', minute: 'min', hour: 'h', day: 'd', week: 'w', month: 'mo', year: 'y' }
  return `${match[1]}${units[match[2] ?? ''] ?? ''}`
}

// The local branches with commits to push that no worktree has checked out: those checked out are rows of their own.
// `hidden` counts the ones left out because they have no upstream (backups, agents)
async function otherBranches(
  $: EngineInterface,
  path: string,
  current: string,
): Promise<{ branches: BranchStatus[]; hidden: number }> {
  const run = await $.process.run(
    [
      'git',
      '-C',
      path,
      'for-each-ref',
      '--format=%(refname:short)%09%(upstream:short)%09%(upstream:remotename)%09%(upstream:remoteref)%09%(upstream:track,nobracket)%09%(worktreepath)',
      'refs/heads',
    ],
    { timeoutMs: 15_000 },
  )
  if (run.exitCode !== 0) return { branches: [], hidden: 0 }
  const branches: BranchStatus[] = []
  let hidden = 0
  for (const line of run.stdout.split('\n')) {
    const [name = '', upstream = '', remote = '', remoteRef = '', track = '', worktree = ''] = line.split('\t')
    if (name.length === 0 || name === current || worktree.length > 0) continue
    if (upstream.length === 0) {
      hidden += 1
      continue
    }
    const ahead = Number(/ahead (\d+)/.exec(track)?.[1] ?? 0)
    const behind = Number(/behind (\d+)/.exec(track)?.[1] ?? 0)
    if (ahead === 0) continue
    // `git push <remote> <name>` writes the branch of the same name: right only if that is the upstream and it is not ahead
    const blocked = behind > 0 ? 'diverged' : remoteRef !== `refs/heads/${name}` ? `tracks ${upstream}` : null
    branches.push({ name, upstream, remote, ahead, behind, blocked })
  }
  return { branches, hidden }
}

// Reads the status without fetching: ahead and behind are relative to the remote as of the last fetch
async function repoStatus(
  $: EngineInterface,
  base: string,
  path: string,
  place: { worktreeOf: string | null; location: string | null },
): Promise<RepoStatus> {
  const name = repoName(base, path)
  const status: RepoStatus = {
    ...place,
    others: [],
    hidden: 0,
    worktrees: [],
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
  // Worktrees share the branches with their repo: the list goes only on the main checkout
  if (place.worktreeOf === null) {
    const { branches, hidden } = await otherBranches($, path, status.branch)
    status.others = branches
    status.hidden = hidden
  }
  return status
}

// The repos found in the session folder plus the worktrees git knows about, also those outside the folder.
// Each linked worktree records the repo it belongs to
async function withWorktrees(
  $: EngineInterface,
  base: string,
  found: string[],
): Promise<{ paths: string[]; worktreeOf: Map<string, string> }> {
  const paths = [...found]
  const known = new Set(found.map(samePath))
  const worktreeOf = new Map<string, string>()
  for (const path of found) {
    const run = await $.process.run(['git', '-C', path, 'worktree', 'list', '--porcelain'], { timeoutMs: 15_000 })
    if (run.exitCode !== 0) continue
    const worktrees = parseWorktrees(run.stdout)
    const main = worktrees.find(one => one.isMain)
    if (main === undefined) continue
    if (samePath(main.path) !== samePath(path)) {
      // This folder is itself a linked worktree: its repo lists it too, when it is in the session folder
      worktreeOf.set(samePath(path), known.has(samePath(main.path)) ? repoName(base, main.path) : repoName('', main.path))
      continue
    }
    for (const worktree of worktrees) {
      if (worktree.isMain || isInSkippedFolder(worktree.path)) continue
      worktreeOf.set(samePath(worktree.path), repoName(base, path))
      if (!known.has(samePath(worktree.path))) {
        known.add(samePath(worktree.path))
        paths.push(worktree.path)
      }
    }
  }
  return { paths, worktreeOf }
}

async function refresh($: EngineInterface): Promise<void> {
  if (isRefreshing) {
    return
  }
  isRefreshing = true
  try {
    const root = await $.session.cwd()
    const found = await listRepos($, root)
    // The common folder comes from the session folder alone: an outside worktree would push it up to the drive
    const base = commonParent(found) || root
    const { paths, worktreeOf } = await withWorktrees($, base, found)
    const repos: RepoStatus[] = []
    for (const path of paths) {
      const place = {
        worktreeOf: worktreeOf.get(samePath(path)) ?? null,
        location: samePath(path).startsWith(`${samePath(root)}/`) || samePath(path) === samePath(root) ? null : slashed(path),
      }
      try {
        repos.push(await repoStatus($, base, path, place))
      } catch (error) {
        repos.push({
          ...place,
          others: [],
          hidden: 0,
          worktrees: [],
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
    await update($, snapshot, () => ({ updatedAt, repos: nestWorktrees(repos) }))
    // An open branch whose count changed rereads its commits
    const opened = await read($, sections)
    const stored = await read($, logs)
    for (const repo of repos) {
      for (const branch of repo.others) {
        const key = branchKey(repo, branch)
        if (opened[key] === true && stored[key]?.ahead !== branch.ahead) await loadBranchLog($, repo, branch)
      }
    }
  } finally {
    isRefreshing = false
  }
}

// A linked worktree goes inside its repo, among its branches; one whose repo is not listed stays on its own
function nestWorktrees(statuses: RepoStatus[]): RepoStatus[] {
  const mains = new Map(statuses.filter(one => one.worktreeOf === null).map(one => [one.name, one]))
  const top: RepoStatus[] = []
  for (const status of statuses) {
    const main = status.worktreeOf === null ? undefined : mains.get(status.worktreeOf)
    if (main === undefined) top.push(status)
    else main.worktrees.push(status)
  }
  return top
}

// The checkout with that name: a repo or one of its worktrees
function findCheckout(repos: RepoStatus[], name: string): RepoStatus | undefined {
  for (const repo of repos) {
    if (repo.name === name) return repo
    const worktree = repo.worktrees.find(one => one.name === name)
    if (worktree !== undefined) return worktree
  }
  return undefined
}

function branchKey(repo: RepoStatus, branch: BranchStatus): string {
  return `${repo.name}#${branch.name}`
}

// The commits of another branch are read when the person opens it, not on every refresh
async function loadBranchLog($: EngineInterface, repo: RepoStatus, branch: BranchStatus): Promise<void> {
  const run = await $.process.run(
    ['git', '-C', repo.path, 'log', '--format=%h%x09%s%x09%cr', `-n${COMMITS_MAX}`, `${branch.upstream}..${branch.name}`],
    { timeoutMs: 15_000 },
  )
  const commits: BranchCommit[] = run.stdout
    .split('\n')
    .filter((line: string) => line.length > 0)
    .map((line: string) => {
      const [hash = '', subject = '', age = ''] = line.split('\t')
      return { hash, subject, age: shortAge(age) }
    })
  await update($, logs, state => ({ ...state, [branchKey(repo, branch)]: { ahead: branch.ahead, commits } }))
}

function startLoadBranchLog($: EngineInterface, repo: RepoStatus, branch: BranchStatus): void {
  loadBranchLog($, repo, branch).catch(error => $.ui.toast(`${repo.name} ${branch.name}: commits not read, ${String(error)}`))
}

function actionArgv(repo: RepoStatus, action: RepoAction): string[] {
  const git = ['git', '-C', repo.path]
  if (action === 'fetch') return [...git, 'fetch', '--prune']
  // Fast-forward only: a pull from the pane never creates a merge
  if (action === 'pull') return [...git, 'pull', '--ff-only']
  return repo.upstream === null ? [...git, 'push', '-u', 'origin', 'HEAD'] : [...git, 'push']
}

// Starts only from the row button: the person asks for the action, the pane never launches it on its own
// With a branch, the push of that branch without checking it out: the rest of the repo stays usable meanwhile
async function runAction($: EngineInterface, repo: RepoStatus, action: RepoAction, branch?: BranchStatus): Promise<void> {
  const key = branch === undefined ? repo.name : branchKey(repo, branch)
  const label = branch === undefined ? repo.name : `${repo.name} ${branch.name}`
  const argv =
    branch === undefined ? actionArgv(repo, action) : ['git', '-C', repo.path, 'push', branch.remote, branch.name]
  const current = await read($, busy)
  if (current[key] !== undefined) {
    return
  }
  await update($, busy, state => ({ ...state, [key]: action }))
  $.ui.toast(`${label}: ${action} running, may ask for the key passphrase`)
  try {
    const run = await $.process.run(argv, { timeoutMs: ACTION_TIMEOUT_MS, env: gitEnv(repo.path) })
    const detail = (run.exitCode === 0 ? run.stdout || run.stderr : run.stderr).trim().split('\n').pop() ?? ''
    $.ui.toast(
      run.exitCode === 0
        ? `${label}: ${action} succeeded${detail ? ` (${detail})` : ''}`
        : `${label}: ${action} failed, ${detail || `exit code ${run.exitCode}`}`,
    )
  } catch (error) {
    $.ui.toast(`${label}: ${action} not run, ${String(error)}`)
  } finally {
    await update($, busy, state => {
      const { [key]: _done, ...rest } = state
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
  target: DiffTarget | null,
): Promise<{ sides: DiffSides; labels: [string, string]; commits: DiffCommit[] }> {
  if (kind === 'commit') {
    if (target?.commit == null) throw new Error('no commit to compare')
    const parent = `${target.commit}^`
    return { sides: { revs: [parent, target.commit], withUntracked: false }, labels: [parent, target.commit], commits: [] }
  }
  if (kind === 'branch') {
    const branch = repo.others.find(one => one.name === target?.branch)
    if (branch === undefined) throw new Error(`${target?.branch ?? 'the branch'} has nothing to push any more`)
    return unpushed($, repo.path, branch.upstream, branch.name)
  }
  if (kind === 'staged') {
    return { sides: { revs: ['--cached'], withUntracked: false }, labels: ['HEAD', 'Index'], commits: [] }
  }
  if (kind === 'unstaged') {
    // With nothing staged the index matches HEAD: the left side takes the name the reader knows
    const left = repo.staged > 0 ? 'Index' : 'HEAD'
    return { sides: { revs: [], withUntracked: true }, labels: [left, 'Working tree'], commits: [] }
  }
  if (repo.upstream === null) throw new Error('the branch has no upstream')
  return unpushed($, repo.path, repo.upstream, 'HEAD')
}

// From the point where `tip` left `upstream` to `tip`
async function unpushed(
  $: EngineInterface,
  path: string,
  upstream: string,
  tip: string,
): Promise<{ sides: DiffSides; labels: [string, string]; commits: DiffCommit[] }> {
  const mergeBase = await $.process.run(['git', '-C', path, 'merge-base', tip, upstream], {
    timeoutMs: 15_000,
  })
  const base = mergeBase.stdout.trim()
  if (mergeBase.exitCode !== 0 || base.length === 0) throw new Error(`no common ancestor with ${upstream}`)
  const log = await $.process.run(
    ['git', '-C', path, 'log', '--format=%h%x09%s', `-n${COMMITS_MAX}`, `${base}..${tip}`],
    { timeoutMs: 15_000 },
  )
  const commits = log.stdout
    .split('\n')
    .filter((line: string) => line.length > 0)
    .map((line: string) => {
      const [hash = '', ...subject] = line.split('\t')
      return { hash, subject: subject.join('\t') }
    })
  return { sides: { revs: [base, tip], withUntracked: false }, labels: [upstream, tip], commits }
}

// The comparison is read on press and kept: the pane redraws it without running git again
async function showDiff(
  $: EngineInterface,
  repo: RepoStatus,
  kind: DiffKind,
  selected?: string,
  target: DiffTarget | null = null,
): Promise<void> {
  const path = repo.path
  const { sides, labels, commits } = await diffPlan($, repo, kind, target)
  const files = await changedFiles($, path, sides)
  const file = files.find(one => one.path === selected) ?? files.find(one => !one.isBinary) ?? null
  const [rows, compare] =
    file === null || file.isBinary
      ? [[], null]
      : await Promise.all([fileRows($, path, file, sides), fileCompare($, path, file, sides, labels)])
  const readAt = await $.clock.now()
  await update($, diff, () => ({
    repo: repo.name,
    branch: target?.branch ?? repo.branch,
    kind,
    target,
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

// An action of a row's menu: `label` is what the list shows; `compare` adds "Compare" in front
type MenuItem = { key: string; label: string; run?: () => void; why?: string; compare?: boolean }

function startShowDiff(
  $: EngineInterface,
  repo: RepoStatus,
  kind: DiffKind,
  selected?: string,
  target: DiffTarget | null = null,
): void {
  showDiff($, repo, kind, selected, target).catch(error => $.ui.toast(`${repo.name}: comparison not read, ${String(error)}`))
}

let isFetchingAll = false

// One after the other: the first fetch to a host opens the shared connection, the others reuse it
async function fetchAll($: EngineInterface): Promise<void> {
  if (isFetchingAll) {
    return
  }
  isFetchingAll = true
  try {
    // A linked worktree shares the remote branches of its repo: one fetch of the repo is enough
    const repos = (await read($, snapshot)).repos.filter(repo => repo.worktreeOf === null)
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

function startAction($: EngineInterface, repo: RepoStatus, action: RepoAction, branch?: BranchStatus): void {
  runAction($, repo, action, branch).catch(error => $.ui.log(`gitree: ${action} ${repo.name}: ${String(error)}`, { to: 'debug' }))
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
    repo.others.length > 0 ||
    repo.worktrees.length > 0 ||
    !BASE_BRANCHES.includes(repo.branch) ||
    repo.upstream === null
  )
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
    void $.ui.open({ id: PANE, title: TITLE, columns: PANE_COLUMNS })
    refreshInBackground($)
    $.clock.every(EVERY_MS, () => refreshInBackground($))

    return next(e)
  })

  on('command.run', { command: 'gitree' }, async $ => {
    await $.ui.open({ id: PANE, title: TITLE, columns: PANE_COLUMNS })
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
    const table = $.ui.resolve(e)
    const { Box, Text, Button } = table
    const { updatedAt, repos } = await read($, snapshot)
    const running = await read($, busy)
    const opened = await read($, sections)
    const commitLogs = await read($, logs)
    const working = repos.filter(isInProgress)
    const clean = repos.filter(repo => !isInProgress(repo))
    // The terminal does not always draw colors with transparency: no backgrounds there
    const hasBackgrounds = e.surface !== 'terminal'
    const toggle = (id: string, isOpen: boolean) => () =>
      void update($, sections, state => ({ ...state, [id]: !isOpen }))

    // A counter beside the name: a tinted pill on the desktop, colored text on the terminal
    const pill = (key: string, label: string, tint: keyof typeof PILLS) => (
      <Box
        key={key}
        paddingX={1}
        flexShrink={0}
        backgroundColor={hasBackgrounds ? PILLS[tint].background : undefined}
      >
        <Text color={PILLS[tint].color} size="caption" weight="semibold">
          {label}
        </Text>
      </Box>
    )
    const revealOnHover = e.surface === 'desktop'

    // Where the surface draws vectors (the desktop, the editor, the phone) the branch count gets the git branch icon;
    // the terminal, without them, keeps "br". No glyph does it: ⎇ came out unreadable in the pane
    const Svg = 'Svg' in table ? table.Svg : undefined
    const branchPill = (key: string, count: string) =>
      Svg === undefined ? (
        pill(key, count.length > 0 ? `${count} br` : 'br', 'neutral')
      ) : (
        <Box
          key={key}
          flexDirection="row"
          columnGap={1}
          alignItems="center"
          paddingX={1}
          flexShrink={0}
          backgroundColor={PILLS.neutral.background}
        >
          <Svg key={`${key}:icon`} source={BRANCH_ICON} alt="branches" width={12} height={12} />
          {count.length > 0 && (
            <Text color={PILLS.neutral.color} size="caption" weight="semibold">
              {count}
            </Text>
          )}
        </Box>
      )
    // The repo closed sums the counters of all its branches: checkouts, worktrees and the others
    const counters = (repo: RepoStatus) => {
      const checkouts = [repo, ...repo.worktrees]
      const changes = checkouts.reduce((sum, one) => sum + one.unstaged + one.untracked + one.staged, 0)
      const ahead =
        checkouts.reduce((sum, one) => sum + one.ahead, 0) + repo.others.reduce((sum, one) => sum + one.ahead, 0)
      const behind = checkouts.reduce((sum, one) => sum + one.behind, 0)
      const branches = checkouts.length + repo.others.length
      return [
        checkouts.some(one => one.error !== null) && pill(`${repo.name}:n-error`, 'error', 'error'),
        changes > 0 && pill(`${repo.name}:n-changes`, `●${changes}`, 'changes'),
        ahead > 0 && pill(`${repo.name}:n-ahead`, `↑${ahead}`, 'ahead'),
        behind > 0 && pill(`${repo.name}:n-behind`, `↓${behind}`, 'behind'),
        branches > 1 && branchPill(`${repo.name}:n-branches`, String(branches)),
        !isInProgress(repo) && (
          <Text key={`${repo.name}:n-clean`} color="success" size="caption">
            ✓
          </Text>
        ),
      ]
    }

    // An item of a menu: a link when it can run, grey with the reason when it cannot
    // An action of a row: a button when it can run; one that cannot says why only when the reason is news
    // (a diverged branch), never "nothing to push"
    type Item = MenuItem
    // The actions of an open branch or repo, under its messages: one link per line, only what can run now.
    // Why something cannot run is a message of the branch
    // One line of links, wrapping when the pane is narrow. On the desktop a Button draws its label in its own
    // style and keeps no Text color: there the link is a blue Text, underlined under the pointer, with a plain
    // Button laid over it that draws only blanks and takes the press. No `label`: the desktop would draw it
    const actionList = (id: string, items: Item[], action?: string) => (
      <Box key={`${id}:items`} flexDirection="row" flexWrap="wrap" columnGap={1} alignItems="center" paddingLeft={4}>
        {action !== undefined ? (
          <Text dimColor italic size="caption">
            {action} running…
          </Text>
        ) : (
          // Short labels, to fit one line of the pane: "unstaged" and "commits" open their comparison
          [
            ...items
            .filter(item => item.run !== undefined)
            .map(item => {
              const label = item.label
              const run = item.run ?? (() => undefined)
              return revealOnHover ? (
                <Box key={`${item.key}:item`} flexShrink={0}>
                  <Text color={LINK_COLOR} size="caption" hover={{ underline: true }}>
                    {label}
                  </Text>
                  {/* Squeezed to the text, a short label's Button would draw an ellipsis: it keeps a width of its own
                      and the box around clips it to the text */}
                  <Box position="absolute" top={0} left={0} right={0} bottom={0} overflow="hidden">
                    <Box width={label.length + 6} flexShrink={0}>
                      <Button key={item.key} plain onPress={run}>
                        {' '.repeat(label.length)}
                      </Button>
                    </Box>
                  </Box>
                </Box>
              ) : (
                <Box key={`${item.key}:item`} flexShrink={0}>
                  <Button key={item.key} plain onPress={run}>
                    {label}
                  </Button>
                </Box>
              )
            }),
          ]
        )}
      </Box>
    )
    // At the end of a row only what is running, never a control: the actions are in the open branch
    const runningNote = (id: string, action?: string) =>
      action !== undefined && (
        <Text key={`${id}:running`} dimColor size="caption">
          {action} running…
        </Text>
      )
    // A message under a branch: small, grey, italic, indented, so it never reads as a branch or a repo
    const message = (key: string, text: string) => (
      <Box key={key} paddingLeft={4}>
        <Text dimColor italic size="caption" wrap="truncate-end">
          {text}
        </Text>
      </Box>
    )
    // A branch line: arrow and name open it, the name shortens before pushing the ⌄ out of the pane
    const branchLine = (
      key: string,
      name: string,
      isOpen: boolean,
      onToggle: () => void,
      pills: RenderChildren[],
      end: RenderChildren,
      isCurrent = false,
      kind: 'branch' | 'worktree' = 'branch',
    ) => (
      <Box key={`${key}:line`} flexDirection="row" alignItems="center" paddingLeft={1}>
        {/* A worktree is a folder of its own: the folder icon tells it from a branch at a glance. The icon comes
            first: on the desktop a Button keeps its native padding even plain, so arrow and name share one Button
            and nothing sits between them */}
        {Svg !== undefined ? (
          <Svg
            key={`${key}:kind`}
            source={kind === 'worktree' ? FOLDER_ICON : BRANCH_ICON}
            alt={kind}
            width={12}
            height={12}
          />
        ) : (
          kind === 'worktree' && (
            <Text key={`${key}:kind`} dimColor size="caption">
              wt
            </Text>
          )
        )}
        <Box flexGrow={1} flexShrink={1} minWidth={0} overflow="hidden">
          <Button key={`${key}:branch`} plain onPress={onToggle}>
            <Text dimColor size="caption">{isOpen ? '▾ ' : '▸ '}</Text>
            <Text mono size="footnote" weight={isCurrent ? 'bold' : undefined} wrap="truncate-end">
              {name}
            </Text>
          </Button>
        </Box>
        <Box flexDirection="row" columnGap={1} alignItems="center" flexShrink={0}>
          {pills}
          {end}
        </Box>
      </Box>
    )
    const plural = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`

    // A branch checked out in a folder, the repo's own or a worktree's. The current branch starts open
    // `extra`: the repo's own actions (Fetch), on the same line as the current branch's
    const checkoutRow = (checkout: RepoStatus, isCurrent: boolean, extra: Item[] = []) => {
      const key = checkout.name
      const isOpen = opened[`${key}:branch`] ?? isCurrent
      const unstaged = checkout.unstaged + checkout.untracked
      const changes = unstaged + checkout.staged
      const canPush = (checkout.ahead > 0 || checkout.upstream === null) && checkout.error === null
      const pills = [
        checkout.error !== null && pill(`${key}:b-error`, 'error', 'error'),
        changes > 0 && pill(`${key}:b-changes`, `●${changes}`, 'changes'),
        checkout.ahead > 0 && pill(`${key}:b-ahead`, `↑${checkout.ahead}`, 'ahead'),
        checkout.behind > 0 && pill(`${key}:b-behind`, `↓${checkout.behind}`, 'behind'),
      ]
      // As in the EGit Git Staging view: untracked files count among the unstaged
      const candidates: (Item | false)[] = [
        unstaged > 0 && { key: `${key}:diff`, label: 'unstaged', compare: true, run: () => startShowDiff($, checkout, 'unstaged') },
        checkout.staged > 0 && { key: `${key}:diff-staged`, label: 'staged', compare: true, run: () => startShowDiff($, checkout, 'staged') },
        checkout.ahead > 0 && checkout.upstream !== null && { key: `${key}:diff-push`, label: 'commits', compare: true, run: () => startShowDiff($, checkout, 'push') },
        canPush && { key: `${key}:push`, label: 'Push', run: () => startAction($, checkout, 'push') },
        checkout.behind > 0 && { key: `${key}:pull`, label: 'Pull', run: () => startAction($, checkout, 'pull') },
      ]
      const items = candidates.filter((item): item is Item => item !== false)
      return (
        <Box key={`${key}:checkout`} flexDirection="column">
          {branchLine(key, checkout.branch, isOpen, toggle(`${key}:branch`, isOpen), pills, runningNote(key, running[key]), isCurrent, checkout.worktreeOf !== null ? 'worktree' : 'branch')}
          {isOpen && (
            <Box flexDirection="column">
              {checkout.worktreeOf !== null && message(`${key}:where`, `worktree in ${checkout.location ?? checkout.name}`)}
              {checkout.error !== null && message(`${key}:error`, checkout.error)}
              {unstaged > 0 && message(`${key}:m-unstaged`, plural(unstaged, 'unstaged file', 'unstaged files'))}
              {checkout.staged > 0 && message(`${key}:m-staged`, plural(checkout.staged, 'staged file', 'staged files'))}
              {checkout.ahead > 0 && checkout.upstream !== null && message(`${key}:m-push`, plural(checkout.ahead, 'commit to push', 'commits to push'))}
              {checkout.behind > 0 && message(`${key}:m-pull`, plural(checkout.behind, 'commit to pull', 'commits to pull'))}
              {/* No message for a branch without upstream: Push among its actions publishes it, that says enough */}
              {changes + checkout.ahead + checkout.behind === 0 && checkout.upstream !== null && message(`${key}:m-sync`, `In sync with ${checkout.upstream}`)}
              {actionList(key, [...items, ...extra], running[key])}
            </Box>
          )}
        </Box>
      )
    }
    const opening = (repo: RepoStatus, branch: BranchStatus, isOpen: boolean) => () => {
      void update($, sections, state => ({ ...state, [branchKey(repo, branch)]: !isOpen }))
      if (!isOpen) startLoadBranchLog($, repo, branch)
    }
    // A branch not checked out: its commits to push, read when it opens
    const branchRow = (repo: RepoStatus, branch: BranchStatus) => {
      const key = branchKey(repo, branch)
      const isOpen = opened[key] ?? false
      const log = commitLogs[key]
      const pills = [
        pill(`${key}:n-ahead`, `↑${branch.ahead}`, 'ahead'),
        branch.behind > 0 && pill(`${key}:n-behind`, `↓${branch.behind}`, 'behind'),
      ]
      const items: Item[] = [
        { key: `${key}:compare`, label: 'commits', compare: true, run: () => startShowDiff($, repo, 'branch', undefined, { branch: branch.name, commit: null }) },
        branch.blocked === null
          ? { key: `${key}:push`, label: 'Push', run: () => startAction($, repo, 'push', branch) }
          : { key: `${key}:push`, label: 'Push', why: branch.blocked },
      ]
      return (
        <Box key={`${key}:other`} flexDirection="column">
          {branchLine(key, branch.name, isOpen, opening(repo, branch, isOpen), pills, runningNote(key, running[key]))}
          {isOpen && (
            <Box flexDirection="column" paddingLeft={4}>
              {branch.blocked !== null && (
                <Text dimColor italic size="caption">
                  {`can't push, ${branch.blocked}`}
                </Text>
              )}
              {log === undefined && (
                <Text dimColor italic size="caption">
                  Reading commits…
                </Text>
              )}
              {/* A commit opens its own comparison with its parent */}
              {log?.commits.map(commit => (
                <Box key={`${key}@${commit.hash}:commit`} flexDirection="row" columnGap={1} alignItems="center">
                  <Text mono dimColor size="caption">
                    {commit.hash}
                  </Text>
                  <Box flexGrow={1} flexShrink={1} minWidth={0} overflow="hidden">
                    <Button
                      key={`${key}@${commit.hash}`}
                      plain
                      onPress={() => startShowDiff($, repo, 'commit', undefined, { branch: branch.name, commit: commit.hash })}
                    >
                      <Text dimColor italic size="caption" wrap="truncate-end">
                        {commit.subject}
                      </Text>
                    </Button>
                  </Box>
                  <Text dimColor size="caption">
                    {commit.age}
                  </Text>
                </Box>
              ))}
              {log !== undefined && branch.ahead > log.commits.length && (
                <Text dimColor italic size="caption">
                  … {branch.ahead - log.commits.length} more
                </Text>
              )}
            </Box>
          )}
          {isOpen && actionList(key, items, running[key])}
        </Box>
      )
    }

    // A repo in progress is a section: closed, a big bold name and the counters over the current branch; open,
    // a card with one list of branches, a gap between the checked out and the others
    const section = (repo: RepoStatus) => {
      const isOpen = opened[repo.name] ?? false
      const items: Item[] = [{ key: `${repo.name}:fetch`, label: 'Fetch', run: () => startAction($, repo, 'fetch') }]
      return (
        <Box
          key={`${repo.name}:section`}
          flexDirection="column"
          // A row of air above every repo: the repos read apart from each other and from the open card
          marginTop={1}
          borderStyle={isOpen ? 'round' : undefined}
          borderDimColor
          backgroundColor={isOpen && hasBackgrounds ? CARD_BACKGROUND : undefined}
          paddingX={isOpen ? 0 : 1}
          paddingBottom={isOpen ? 1 : 0}
        >
          <Box key={`${repo.name}:head`} flexDirection="row" columnGap={1} alignItems="center">
            <Box flexGrow={1} flexShrink={1} minWidth={0} overflow="hidden">
              <Button key={`${repo.name}:toggle`} plain onPress={toggle(repo.name, isOpen)}>
                <Text dimColor size="caption">{isOpen ? '▾ ' : '▸ '}</Text>
                <Text weight="bold" size="body" wrap="truncate-end">
                  {repo.name}
                </Text>
              </Button>
            </Box>
            {counters(repo)}
            {!isOpen && runningNote(`${repo.name}:repo`, running[repo.name] === 'fetch' ? 'fetch' : undefined)}
          </Box>
          {!isOpen && (
            <Box paddingLeft={2}>
              <Text mono dimColor size="caption" wrap="truncate-end">
                {repo.branch}
              </Text>
            </Box>
          )}
          {isOpen && (
            <Box flexDirection="column">
              {checkoutRow(repo, true, items)}
              {repo.worktrees.map(worktree => checkoutRow(worktree, false))}
              {repo.others.length > 0 && <Box key={`${repo.name}:gap`} height={1} />}
              {repo.others.map(branch => branchRow(repo, branch))}
              {/* Fetch is one per repo: it sits with the current branch's actions, here only when that branch is closed */}
              {!(opened[`${repo.name}:branch`] ?? true) && (
                <Box key={`${repo.name}:repo-actions`} paddingTop={1}>
                  {actionList(`${repo.name}:repo`, items, running[repo.name] === 'fetch' ? 'fetch' : undefined)}
                </Box>
              )}
            </Box>
          )}
        </Box>
      )
    }

    return (
      <Box flexDirection="column">
        <Box flexDirection="row" columnGap={1} alignItems="center" paddingX={1}>
          <Box key="refresh:link" flexShrink={0}>
            <Button key="refresh" plain onPress={() => startFetchAll($)} hover={{ underline: true }}>
              <Text color={LINK_COLOR} size="caption">
                ↻ Fetch all
              </Text>
            </Button>
          </Box>
          <Box flexGrow={1} />
          {updatedAt !== null && (
            <Text dimColor size="caption">
              read at {clockTime(updatedAt)}
            </Text>
          )}
        </Box>
        {updatedAt === null && <Text dimColor size="footnote">Reading repositories…</Text>}
        {/* Clean repos are sections like the others, after the ones in progress */}
        {working.map(section)}
        {clean.map(section)}
        {/* The surface has no tooltips: what the counters mean is spelled out once, with the same pills */}
        {updatedAt !== null && (
          <Box key="legend" flexDirection="row" flexWrap="wrap" columnGap={1} rowGap={1} alignItems="center" paddingX={1} marginTop={2}>
            {pill('legend:changes', '●', 'changes')}
            <Text dimColor size="caption">changes</Text>
            {pill('legend:ahead', '↑', 'ahead')}
            <Text dimColor size="caption">push</Text>
            {pill('legend:behind', '↓', 'behind')}
            <Text dimColor size="caption">pull</Text>
            {branchPill('legend:branches', '')}
            <Text dimColor size="caption">branches</Text>
          </Box>
        )}
      </Box>
    )
  })

  on('ui.render', { component: 'Pane', requestId: DIFF_PANE }, async ($, e) => {
    const table = $.ui.resolve(e)
    const { Box, Text, Button } = table
    const shown = await read($, diff)
    if (shown === null) {
      return <Text dimColor>Choose a comparison in the Repositories pane.</Text>
    }
    const { repos } = await read($, snapshot)
    const repo = findCheckout(repos, shown.repo)
    const selected = shown.files.find(file => file.path === shown.selected)
    // How many commits the comparison covers: the current branch, or the other branch it shows
    const totalCommits =
      shown.kind === 'branch'
        ? (repo?.others.find(one => one.name === shown.target?.branch)?.ahead ?? 0)
        : shown.kind === 'push'
          ? (repo?.ahead ?? 0)
          : 0
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
            {totalCommits > shown.commits.length && (
              <Text dimColor size="caption">
                … {totalCommits - shown.commits.length} more commits
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
                onPress={() => repo !== undefined && startShowDiff($, repo, shown.kind, file.path, shown.target)}
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
                startShowDiff($, repo, shown.kind, shown.selected ?? undefined, shown.target)
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
