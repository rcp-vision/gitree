import { expect, test } from 'claude-code/testing'
import type { On } from 'claude-code'

import { layoutGraph, rowSvg, textWidth } from '../hooks/graph'
import { parseRefs } from '../hooks/history'

const ROOT = '/home/dev/projects'

const PANE_PROPS = {
  isFocused: false,
  bodyColumns: 160,
  placement: 'dock',
  scroll: { offset: 0, bodyRows: 40 },
  view: {},
} as const

const LIST = { plugin: 'gitree', component: 'Pane', requestId: 'gitree', props: { ...PANE_PROPS, title: 'Repositories' } } as const
const HISTORY = {
  plugin: 'gitree',
  component: 'Pane',
  requestId: 'gitree-history',
  props: { ...PANE_PROPS, title: 'History demo' },
} as const
const DIFF = { plugin: 'gitree', component: 'Pane', requestId: 'gitree-diff', props: { ...PANE_PROPS, title: 'Compare demo' } } as const

type Run = { exitCode: number; stdout: string; stderr: string; isStdoutTruncated: false; isStderrTruncated: false }
const ok = (stdout: string, exitCode = 0): Run => ({ exitCode, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false })

// A merge: `m` joins `feature` (f) into main (b), both from the root `a`
const H = { m: 'm'.repeat(40), f: 'f'.repeat(40), b: 'b'.repeat(40), a: 'a'.repeat(40) }
const record = (hash: string, parents: string[], refs: string, subject: string) =>
  [hash, hash.slice(0, 7), parents.join(' '), 'Ada', 'ada@example.com', '1762682400', 'Bob', 'bob@example.com', '1762686000', refs, subject].join(
    '\x1f',
  ) + '\x1e'
const LOG = [
  record(H.m, [H.b, H.f], 'HEAD -> refs/heads/main, refs/remotes/origin/main, refs/remotes/origin/HEAD', 'Merge branch feature'),
  record(H.f, [H.a], 'tag: refs/tags/v1.0, refs/heads/feature', 'add feature'),
  record(H.b, [H.a], '', 'fix on main'),
  record(H.a, [], '', 'first commit'),
].join('\n')

const STATUS = ['# branch.head main', '# branch.upstream origin/main', '# branch.ab +0 -0', ''].join('\n')

function engine(on: On): string[][] {
  const calls: string[][] = []
  on('process.run', (_, e) => {
    const argv = [...e.argv]
    calls.push(argv)
    if (argv[0] === 'find') return { value: ok(`${ROOT}/demo/.git\n`) }
    if (argv.includes('status')) return { value: ok(STATUS) }
    if (argv.includes('--date-order')) return { value: ok(LOG) }
    if (argv.includes('show')) return { value: ok('Merge branch feature\n\nBrings the feature to main.\n') }
    if (argv.includes('--numstat')) return { value: ok('3\t1\tsrc/feature.ts\n') }
    if (argv.includes('rev-parse')) return { value: ok('', argv.some(arg => arg.startsWith(H.a.slice(0, 7))) ? 1 : 0) }
    return { value: ok(['@@ -1,1 +1,1 @@', '-old', '+new', ''].join('\n')) }
  })
  on('session.cwd', () => ({ value: ROOT }))
  on('clock.now', () => ({ value: Date.UTC(2026, 10, 12, 10, 0, 0) }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.toast', () => ({ value: undefined }))
  on('ui.log', () => ({ value: undefined }))
  return calls
}

test('the graph keeps a lane per line of descent and converges the lanes into the common parent', () => {
  const rows = layoutGraph([
    { hash: 'm', parents: ['b', 'f'] },
    { hash: 'f', parents: ['a'] },
    { hash: 'b', parents: ['a'] },
    { hash: 'a', parents: [] },
  ])
  // The merge opens a second lane for its second parent
  expect(rows[0]?.lane).toBe(0)
  expect(rows[0]?.isMerge).toBe(true)
  expect(rows[0]?.bottom).toContainEqual([0, 1, rows[0]?.bottom.find(edge => edge[1] === 1)?.[2]])
  // The feature commit sits on the second lane, main passes beside it
  expect(rows[1]?.lane).toBe(1)
  expect(rows[1]?.top.some(([from, to]) => from === 0 && to === 0)).toBe(true)
  expect(rows[2]?.lane).toBe(0)
  // The root collects both lanes and closes them
  expect(rows[3]?.lane).toBe(0)
  expect(rows[3]?.top.some(([from, to]) => from === 1 && to === 0)).toBe(true)
  expect(rows[3]?.bottom).toEqual([])
  // A lane keeps its color from the merge down to the root
  expect(rows[1]?.color).toBe(rows[0]?.bottom.find(edge => edge[1] === 1)?.[2])
})

test('a straight history stays on one lane', () => {
  const rows = layoutGraph([
    { hash: 'c', parents: ['b'] },
    { hash: 'b', parents: ['a'] },
    { hash: 'a', parents: [] },
  ])
  expect(rows.map(row => row.lane)).toEqual([0, 0, 0])
  expect(rows.map(row => row.width)).toEqual([1, 1, 1])
})

test('a label is as wide as its letters in Arial, so its name is drawn without stretching', () => {
  // Narrow letters take less room than wide ones of the same count
  expect(textWidth('fix/ill', false)).toBeLessThan(textWidth('MMMMMMM', false))
  // 'develop' in Arial 11 px: 556+556+500+556+222+556+556 thousandths
  expect(Math.abs(textWidth('develop', false) - (3502 * 11) / 1000) < 1e-9).toBe(true)
  expect(textWidth('develop', true)).toBeGreaterThan(textWidth('develop', false))
  const row = { lane: 0, color: 0, top: [], bottom: [], width: 1, isMerge: false }
  const svg = rowSvg(row, [{ name: 'develop', color: '#000', fill: '#fff', fillOpacity: 1, isBold: false }])
  expect(svg).toContain(`textLength="${Math.ceil((3502 * 11) / 1000)}"`)
  expect(svg).toContain('font-family="Arial')
})

test('ref labels name the current branch, the local and remote branches and the tags, without origin/HEAD', () => {
  expect(parseRefs('HEAD -> refs/heads/main, refs/remotes/origin/main, refs/remotes/origin/HEAD, tag: refs/tags/v1, refs/heads/x')).toEqual([
    { name: 'main', kind: 'head', isCurrent: true },
    { name: 'origin/main', kind: 'remote', isCurrent: false },
    { name: 'v1', kind: 'tag', isCurrent: false },
    { name: 'x', kind: 'head', isCurrent: false },
  ])
  expect(parseRefs('HEAD')).toEqual([{ name: 'HEAD', kind: 'detached', isCurrent: true }])
})

test('History opens the graph of every branch, the selected commit with its files, and a file its comparison', async ($, on) => {
  const calls = engine(on)
  await $.command.run({ command: 'gitree', args: '', origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 160 } })
  const list = await $.ui.mount({ ...LIST, surface: 'desktop' })
  await list.press({ key: 'demo:toggle' })
  await list.press({ key: 'demo:history' })
  await list.unmount()

  const log = calls.find(argv => argv.includes('--date-order'))
  expect(log).toContain('--branches')
  expect(log).toContain('--remotes')
  expect(log).toContain('--tags')

  const history = await $.ui.mount({ ...HISTORY, surface: 'desktop' })
  const graphs = await history.findAll({ type: 'Svg' })
  expect(graphs.length).toBe(4)
  expect(await history.find({ type: 'Text', text: /^Merge branch feature$/ })).toBeDefined()
  // On the desktop the ref labels are drawn in the row's graph picture: its alt text names them
  const labels = graphs.map(graph => String(graph.props.alt).split(', '))
  expect(labels.some(names => names.includes('origin/main'))).toBe(true)
  expect(labels.some(names => names.includes('v1.0'))).toBe(true)
  expect(labels.some(names => names.includes('origin/HEAD'))).toBe(false)
  // The newest commit is selected: its message, its parents and its files
  expect(await history.find({ type: 'Text', text: /Brings the feature to main/ })).toBeDefined()
  expect(await history.find({ type: 'Button', key: `detail:Parent:${H.f}` })).toBeDefined()
  expect(await history.find({ type: 'Button', key: 'history:file:src/feature.ts' })).toBeDefined()

  // Another row selects its commit
  await history.press({ key: `history:select:${H.b}` })
  expect(await history.find({ type: 'Button', key: `detail:Child:${H.m}` })).toBeDefined()

  await history.press({ key: 'history:file:src/feature.ts' })
  await history.unmount()
  const compare = await $.ui.mount({ ...DIFF, surface: 'desktop' })
  expect(await compare.find({ type: 'Text', text: /^bbbbbbb\^$/, in: 'compare' })).toBeDefined()
  await compare.unmount()
})

test('the History pane draws the graph in characters on the terminal', async ($, on) => {
  engine(on)
  await $.command.run({ command: 'gitree', args: '', origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 160 } })
  const list = await $.ui.mount({ ...LIST, surface: 'terminal' })
  await list.press({ key: 'demo:toggle' })
  await list.press({ key: 'demo:history' })
  await list.unmount()
  const history = await $.ui.mount({ ...HISTORY, surface: 'terminal' })
  expect(await history.find({ type: 'Text', text: /^● │$/ })).toBeDefined()
  expect(await history.find({ type: 'Text', text: /^\[main\]$/ })).toBeDefined()
  await history.unmount()
})
