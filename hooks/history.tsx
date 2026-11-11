// The History pane, in the style of the EGit History view: the commit graph with its lanes, branches and merges,
// the ref labels, author and dates; under the table the selected commit with its message and changed files.
// A file opens the comparison of the commit with its first parent in the Compare pane.
import { atom, read, update } from 'claude-code'
import type { EngineInterface, RenderInput } from 'claude-code'

import type { DiffFile, HistoryCommit, HistoryDetail, HistoryRef, HistoryScope, RepoHistory, RepoStatus } from '../types'
import { layoutGraph, ROW_HEIGHT, rowGlyphs, rowSvg, rowSvgWidth } from './graph'
import type { SvgLabel } from './graph'

export const HISTORY_PANE = 'gitree-history'
/** Commits on one page of the table. */
export const HISTORY_PAGE = 50
/** The tree git hashes for an empty folder: the left side of a commit without parents. */
export const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904'

const SELECTED_BACKGROUND = 'rgba(80, 130, 220, 0.22)'
const HOVER_BACKGROUND = 'rgba(80, 130, 220, 0.08)'
const HEADER_BACKGROUND = 'rgba(160, 180, 230, 0.16)'
const LINK_COLOR = '#3b66c4'
// The ref labels: green for a local branch, grey-blue for a remote one, yellow for a tag, as in EGit
// `fill` and `fillOpacity` are the same background for the labels drawn in the graph's SVG
const REF_STYLE = {
  head: { color: '#256b2f', background: 'rgba(170, 225, 170, 0.45)', fill: '#aae1aa', fillOpacity: 0.45 },
  remote: { color: '#4a5a70', background: 'rgba(195, 205, 225, 0.5)', fill: '#c3cde1', fillOpacity: 0.5 },
  tag: { color: '#7a5c00', background: 'rgba(250, 225, 130, 0.5)', fill: '#fae182', fillOpacity: 0.5 },
  detached: { color: '#8a3b12', background: 'rgba(245, 190, 160, 0.45)', fill: '#f5bea0', fillOpacity: 0.45 },
} as const

function svgLabel(ref: HistoryRef): SvgLabel {
  const style = REF_STYLE[ref.kind]
  return { name: ref.name, color: style.color, fill: style.fill, fillOpacity: style.fillOpacity, isBold: ref.isCurrent }
}
// Columns in cells; the committer columns only when the pane is wide enough
const ID_WIDTH = 9
const PERSON_WIDTH = 20
const DATE_WIDTH = 20
const WIDE_COLUMNS = 150

const history = atom({ plugin: 'gitree', key: 'history' } as const, null as RepoHistory | null, { shape: 'history-1' })

/** What the History pane borrows from the Repositories pane, bound to the hook's engine interface. */
export type HistoryDeps = {
  findRepo: (name: string) => Promise<RepoStatus | undefined>
  changedFiles: (path: string, revs: string[]) => Promise<DiffFile[]>
  openCommitDiff: (repo: RepoStatus, commit: HistoryCommit, file: string) => void
}

const FORMAT = ['%H', '%h', '%P', '%an', '%ae', '%at', '%cn', '%ce', '%ct', '%D', '%s'].join('%x1f') + '%x1e'

/** The decorations of `git log --decorate=full` (`%D`) as labels; `origin/HEAD` and the stash stay out. */
export function parseRefs(decoration: string): HistoryRef[] {
  const refs: HistoryRef[] = []
  for (const part of decoration.split(', ')) {
    if (part.length === 0) continue
    if (part === 'HEAD') {
      refs.push({ name: 'HEAD', kind: 'detached', isCurrent: true })
    } else if (part.startsWith('HEAD -> refs/heads/')) {
      refs.push({ name: part.slice('HEAD -> refs/heads/'.length), kind: 'head', isCurrent: true })
    } else if (part.startsWith('tag: refs/tags/')) {
      refs.push({ name: part.slice('tag: refs/tags/'.length), kind: 'tag', isCurrent: false })
    } else if (part.startsWith('refs/heads/')) {
      refs.push({ name: part.slice('refs/heads/'.length), kind: 'head', isCurrent: false })
    } else if (part.startsWith('refs/remotes/') && !part.endsWith('/HEAD')) {
      refs.push({ name: part.slice('refs/remotes/'.length), kind: 'remote', isCurrent: false })
    }
  }
  return refs
}

/** The commits of `git log` in FORMAT, without their graph row. */
export function parseLog(stdout: string): Omit<HistoryCommit, 'graph'>[] {
  return stdout
    .split('\x1e')
    .map(record => record.replace(/^\n/, ''))
    .filter(record => record.length > 0)
    .map(record => {
      const [hash = '', short = '', parents = '', author = '', authorEmail = '', authoredAt = '0', committer = '',
        committerEmail = '', committedAt = '0', decoration = '', ...subject] = record.split('\x1f')
      return {
        hash,
        short,
        parents: parents.length > 0 ? parents.split(' ') : [],
        author,
        authorEmail,
        authoredAt: Number(authoredAt) * 1000,
        committer,
        committerEmail,
        committedAt: Number(committedAt) * 1000,
        refs: parseRefs(decoration),
        subject: subject.join('\x1f'),
      }
    })
}

// The graph needs every commit above the page: the log is read from the top down to the end of the page
async function readPage(
  $: EngineInterface,
  path: string,
  scope: HistoryScope,
  start: number,
): Promise<{ commits: HistoryCommit[]; hasMore: boolean }> {
  const revs = scope === 'all' ? ['--branches', '--remotes', '--tags', 'HEAD'] : ['HEAD']
  const run = await $.process.run(
    ['git', '-C', path, 'log', '--date-order', '--decorate=full', `--format=${FORMAT}`, `-n${start + HISTORY_PAGE + 1}`, ...revs],
    { timeoutMs: 30_000 },
  )
  if (run.exitCode !== 0) throw new Error(run.stderr.trim() || `git log ended with ${run.exitCode}`)
  const all = parseLog(run.stdout)
  const graph = layoutGraph(all)
  const commits = all
    .slice(start, start + HISTORY_PAGE)
    .map((commit, index) => ({ ...commit, graph: graph[start + index] ?? { lane: 0, color: 0, top: [], bottom: [], width: 1, isMerge: false } }))
  return { commits, hasMore: all.length > start + HISTORY_PAGE }
}

async function readDetail($: EngineInterface, deps: HistoryDeps, path: string, commit: HistoryCommit): Promise<HistoryDetail> {
  const parent = commit.parents[0] ?? EMPTY_TREE
  const [show, files] = await Promise.all([
    $.process.run(['git', '-C', path, 'show', '-s', '--format=%B', commit.hash], { timeoutMs: 15_000 }),
    deps.changedFiles(path, [parent, commit.hash]),
  ])
  return { hash: commit.hash, body: show.stdout.replace(/\s+$/, ''), files }
}

async function select($: EngineInterface, deps: HistoryDeps, hash: string): Promise<void> {
  const shown = await read($, history)
  const commit = shown?.commits.find(one => one.hash === hash)
  if (shown == null || commit === undefined) return
  await update($, history, state => (state === null ? state : { ...state, selected: hash, detail: null }))
  const repo = await deps.findRepo(shown.repo)
  if (repo === undefined) return
  const detail = await readDetail($, deps, repo.path, commit)
  // Another click may have come first: only the detail of the commit still selected is kept
  await update($, history, state => (state === null || state.selected !== hash ? state : { ...state, detail }))
}

async function loadPage($: EngineInterface, deps: HistoryDeps, repo: RepoStatus, scope: HistoryScope, start: number): Promise<void> {
  const { commits, hasMore } = await readPage($, repo.path, scope, start)
  const readAt = await $.clock.now()
  const selected = commits[0]?.hash ?? null
  await update($, history, () => ({ repo: repo.name, scope, start, commits, hasMore, readAt, selected, detail: null }))
  if (selected !== null) await select($, deps, selected)
}

/** Opens the History pane on `repo`, every branch and tag, newest commit first. */
export async function openHistory($: EngineInterface, deps: HistoryDeps, repo: RepoStatus): Promise<void> {
  await loadPage($, deps, repo, 'all', 0)
  await $.ui.open({ id: HISTORY_PANE, title: `History ${repo.name}`, focus: true })
}

function dateTime(epochMs: number): string {
  const at = new Date(epochMs)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())} ${pad(at.getHours())}:${pad(at.getMinutes())}:${pad(at.getSeconds())}`
}

async function reload($: EngineInterface, deps: HistoryDeps, scope: HistoryScope, start: number): Promise<void> {
  const shown = await read($, history)
  const repo = shown === null ? undefined : await deps.findRepo(shown.repo)
  if (repo !== undefined) await loadPage($, deps, repo, scope, start)
}

function startSelect($: EngineInterface, deps: HistoryDeps, hash: string): void {
  select($, deps, hash).catch(error => $.ui.toast(`History: commit not read, ${String(error)}`))
}

function startReload($: EngineInterface, deps: HistoryDeps, scope: HistoryScope, start: number): void {
  reload($, deps, scope, start).catch(error => $.ui.toast(`History: log not read, ${String(error)}`))
}

/** The History pane, drawn by the `ui.render` hook of `HISTORY_PANE`. */
export async function historyPane($: EngineInterface, e: Extract<RenderInput, { component: 'Pane' }>, deps: HistoryDeps) {
  const table = $.ui.resolve(e)
  const { Box, Text, Button } = table
  // The terminal resolves no vector element: there the graph is drawn in characters
  const Svg = e.surface !== 'terminal' && 'Svg' in table ? table.Svg : undefined
  const shown = await read($, history)
  if (shown === null) {
    return <Text dimColor>Open the history of a repository from the Repositories pane.</Text>
  }
  const hasBackgrounds = e.surface !== 'terminal'
  const isWide = e.props.bodyColumns >= WIDE_COLUMNS
  const selected = shown.commits.find(commit => commit.hash === shown.selected)
  const byHash = new Map(shown.commits.map(commit => [commit.hash, commit]))

  // A link: blue text with a plain Button laid over it, as in the Repositories pane
  const link = (key: string, label: string, run: () => void) => (
    <Box key={`${key}:link`} flexShrink={0}>
      <Button key={key} plain onPress={run}>
        <Text color={LINK_COLOR} size="caption">
          {label}
        </Text>
      </Button>
    </Box>
  )
  const refLabel = (commit: HistoryCommit, ref: HistoryRef) => (
    <Box
      key={`${commit.hash}:ref:${ref.kind}:${ref.name}`}
      flexShrink={0}
      paddingX={hasBackgrounds ? 'xs' : 0}
      borderStyle={hasBackgrounds ? 'single' : undefined}
      borderColor={REF_STYLE[ref.kind].color}
      height={hasBackgrounds ? 1 : undefined}
      backgroundColor={hasBackgrounds ? REF_STYLE[ref.kind].background : undefined}
    >
      <Text color={REF_STYLE[ref.kind].color} size="caption" weight={ref.isCurrent ? 'bold' : undefined}>
        {hasBackgrounds ? ref.name : `[${ref.name}]`}
      </Text>
    </Box>
  )
  const cell = (key: string, width: number, text: string, mono = false) => (
    <Box key={key} width={width} flexShrink={0} overflow="hidden" paddingLeft={1}>
      <Text size="footnote" mono={mono} dimColor={mono} wrap="truncate-end">
        {text}
      </Text>
    </Box>
  )
  const header = (
    <Box key="history:header" flexDirection="row" backgroundColor={hasBackgrounds ? HEADER_BACKGROUND : undefined}>
      {[
        ['Id', ID_WIDTH],
        ['Message', 0],
        ['Author', PERSON_WIDTH],
        ['Authored Date', DATE_WIDTH],
        ...(isWide ? [['Committer', PERSON_WIDTH], ['Committed Date', DATE_WIDTH]] : []),
      ].map(([title, width]) => (
        <Box
          key={`history:col:${title}`}
          width={width === 0 ? undefined : (width as number)}
          flexGrow={width === 0 ? 1 : 0}
          flexShrink={width === 0 ? 1 : 0}
          paddingLeft={1}
        >
          <Text weight="semibold" size="footnote">
            {title as string}
          </Text>
        </Box>
      ))}
    </Box>
  )
  const row = (commit: HistoryCommit) => {
    const isSelected = commit.hash === shown.selected
    const choose = () => startSelect($, deps, commit.hash)
    return (
      <Box
        key={`history:row:${commit.hash}`}
        flexDirection="row"
        alignItems="center"
        backgroundColor={isSelected && hasBackgrounds ? SELECTED_BACKGROUND : undefined}
        hover={hasBackgrounds && !isSelected ? { backgroundColor: HOVER_BACKGROUND } : undefined}
      >
        {cell(`${commit.hash}:id`, ID_WIDTH, commit.short, true)}
        <Box key={`${commit.hash}:message`} flexDirection="row" alignItems="center" columnGap={1} flexGrow={1} flexShrink={1} minWidth={0} overflow="hidden" paddingLeft={1}>
          {/* With vectors the ref labels are drawn in the graph's picture, as in EGit: a label of its own would make
              the row taller than the picture and break the lanes between rows */}
          {/* The picture never shrinks: scaled down to a narrow column it would lose height and break the lanes.
              The column clips it on the right instead, labels first, lanes last */}
          {Svg !== undefined ? (
            <Box key={`${commit.hash}:graph-box`} flexShrink={0}>
              <Svg
                key={`${commit.hash}:graph`}
                source={rowSvg(commit.graph, commit.refs.map(svgLabel))}
                alt={[commit.graph.isMerge ? 'merge commit' : 'commit', ...commit.refs.map(ref => ref.name)].join(', ')}
                width={rowSvgWidth(commit.graph, commit.refs.map(svgLabel))}
                height={ROW_HEIGHT}
              />
            </Box>
          ) : (
            <Text key={`${commit.hash}:graph`} mono size="footnote">
              {rowGlyphs(commit.graph)}
            </Text>
          )}
          {Svg === undefined && commit.refs.map(ref => refLabel(commit, ref))}
          <Box flexGrow={1} flexShrink={1} minWidth={0}>
            <Text size="footnote" wrap="truncate-end" weight={isSelected ? 'semibold' : undefined}>
              {commit.subject}
            </Text>
          </Box>
        </Box>
        {cell(`${commit.hash}:author`, PERSON_WIDTH, commit.author)}
        {cell(`${commit.hash}:authored`, DATE_WIDTH, dateTime(commit.authoredAt))}
        {isWide && cell(`${commit.hash}:committer`, PERSON_WIDTH, commit.committer)}
        {isWide && cell(`${commit.hash}:committed`, DATE_WIDTH, dateTime(commit.committedAt))}
        {/* The whole row takes the click: a plain Button of blanks laid over it */}
        <Box position="absolute" top={0} left={0} right={0} bottom={0} overflow="hidden">
          <Button key={`history:select:${commit.hash}`} plain onPress={choose}>
            {' '.repeat(Math.max(1, e.props.bodyColumns))}
          </Button>
        </Box>
      </Box>
    )
  }

  // The selected commit, as the lower part of the EGit History view: the commit text on the left, the files on the right
  const children = (hash: string) => shown.commits.filter(commit => commit.parents.includes(hash))
  const person = (title: string, name: string, email: string, at: number) => (
    <Box key={`detail:${title}`} flexDirection="row" columnGap={1} flexWrap="wrap">
      <Text size="footnote" weight="semibold">
        {title}:
      </Text>
      <Text size="footnote">{`${name} <${email}>`}</Text>
      <Text size="footnote" dimColor>
        {dateTime(at)}
      </Text>
    </Box>
  )
  const relation = (title: string, hashes: string[]) =>
    hashes.length > 0 && (
      <Box key={`detail:${title}`} flexDirection="row" columnGap={1} flexWrap="wrap">
        <Text size="footnote" weight="semibold">
          {title}:
        </Text>
        {hashes.map(hash => {
          const other = byHash.get(hash)
          return other === undefined ? (
            <Text key={`detail:${title}:${hash}`} mono size="footnote" dimColor>
              {hash.slice(0, 7)}
            </Text>
          ) : (
            link(`detail:${title}:${hash}`, `${other.short} ${other.subject}`, () => startSelect($, deps, hash))
          )
        })}
      </Box>
    )
  const detail =
    selected === undefined ? null : (
      <Box key="history:detail" flexDirection={isWide ? 'row' : 'column'} columnGap={2} borderStyle="single" borderDimColor marginTop={1}>
        <Box key="detail:text" flexDirection="column" flexGrow={1} flexShrink={1} minWidth={0} paddingX={1}>
          <Text mono size="footnote">
            commit {selected.hash}
          </Text>
          {person('Author', selected.author, selected.authorEmail, selected.authoredAt)}
          {person('Committer', selected.committer, selected.committerEmail, selected.committedAt)}
          {relation('Parent', selected.parents)}
          {relation('Child', children(selected.hash).map(commit => commit.hash))}
          {selected.refs.length > 0 && (
            <Box key="detail:refs" flexDirection="row" columnGap={1} flexWrap="wrap" alignItems="center">
              <Text size="footnote" weight="semibold">
                Refs:
              </Text>
              {selected.refs.map(ref => refLabel(selected, ref))}
            </Box>
          )}
          <Box key="detail:body" marginTop={1}>
            <Text size="footnote">{shown.detail?.hash === selected.hash ? shown.detail.body : selected.subject}</Text>
          </Box>
        </Box>
        <Box key="detail:files" flexDirection="column" width={isWide ? '40%' : undefined} paddingX={1}>
          {shown.detail?.hash !== selected.hash ? (
            <Text dimColor size="caption">
              Reading the changed files…
            </Text>
          ) : shown.detail.files.length === 0 ? (
            <Text dimColor size="caption">
              No files changed against the first parent.
            </Text>
          ) : (
            shown.detail.files.map(file => (
              <Box key={`detail:file:${file.path}`} flexDirection="row" columnGap={1}>
                <Box flexShrink={1} minWidth={0}>
                  <Button
                    key={`history:file:${file.path}`}
                    plain
                    onPress={() =>
                      void deps.findRepo(shown.repo).then(repo => repo !== undefined && deps.openCommitDiff(repo, selected, file.path))
                    }
                  >
                    <Text mono size="footnote" color={LINK_COLOR}>
                      {file.path}
                    </Text>
                  </Button>
                </Box>
                <Text size="caption" color="success">
                  {file.isBinary ? 'binary' : `+${file.added}`}
                </Text>
                {!file.isBinary && (
                  <Text size="caption" color="error">
                    −{file.removed}
                  </Text>
                )}
              </Box>
            ))
          )}
        </Box>
      </Box>
    )

  const first = shown.start + 1
  const last = shown.start + shown.commits.length
  return (
    <Box flexDirection="column">
      <Box key="history:toolbar" flexDirection="row" columnGap={2} alignItems="center" flexWrap="wrap">
        <Text weight="semibold">{shown.repo}</Text>
        {shown.scope === 'all' ? (
          <Text size="caption" weight="semibold">
            All branches
          </Text>
        ) : (
          link('history:scope:all', 'All branches', () => startReload($, deps, 'all', 0))
        )}
        {shown.scope === 'head' ? (
          <Text size="caption" weight="semibold">
            Current branch
          </Text>
        ) : (
          link('history:scope:head', 'Current branch', () => startReload($, deps, 'head', 0))
        )}
        <Box flexGrow={1} />
        <Text dimColor size="caption">
          read at {dateTime(shown.readAt).slice(11)}
        </Text>
        {link('history:reload', '↻ Reload', () => startReload($, deps, shown.scope, shown.start))}
        <Button key="history:close" role="dismiss" onPress={() => void $.ui.close({ id: HISTORY_PANE })}>
          <Text size="caption">Close</Text>
        </Button>
      </Box>
      <Box key="history:table" flexDirection="column" borderStyle="single" borderDimColor>
        {header}
        {shown.commits.length === 0 && (
          <Text dimColor size="caption">
            No commits.
          </Text>
        )}
        {shown.commits.map(row)}
      </Box>
      <Box key="history:pages" flexDirection="row" columnGap={2} alignItems="center">
        <Text dimColor size="caption">
          Commits {first}–{last}
        </Text>
        {shown.start > 0 &&
          link('history:newer', '◂ Newer', () =>
            startReload($, deps, shown.scope, Math.max(0, shown.start - HISTORY_PAGE)),
          )}
        {shown.hasMore &&
          link('history:older', 'Older ▸', () =>
            startReload($, deps, shown.scope, shown.start + HISTORY_PAGE),
          )}
      </Box>
      {detail}
    </Box>
  )
}
