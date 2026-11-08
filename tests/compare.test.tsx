import { expect, test } from 'claude-code/testing'
import type { On } from 'claude-code'
import type { Engine } from 'claude-code/testing'

// The actions of a row, now links in its open body: "<branch>:menu" names a branch, "<repo>:repo:menu" a repo.
// A closed branch is opened to read them and closed again
type Shown = { key: string | undefined; text: string; props: Record<string, unknown> }
type Mounted = {
  press: (target: { key: string }) => Promise<unknown>
  findAll: (query: { type: string }) => Promise<Shown[]>
}
const BRANCH_ACTIONS = ['diff', 'diff-staged', 'diff-push', 'compare', 'push', 'pull']
const ACTION_LABELS: Record<string, string> = {
  diff: 'Compare unstaged',
  'diff-staged': 'Compare staged',
  'diff-push': 'Compare commits',
  compare: 'Compare commits',
  push: 'Push',
  pull: 'Pull',
  fetch: 'Fetch',
}
// What an action shows: its Button draws only blanks over the blue text, so it is named by its key
const labelOf = (button: Shown) => ACTION_LABELS[button.key?.split(':').pop() ?? ''] ?? button.text
function actionsOf(buttons: Shown[], key: string): Shown[] {
  const id = key.replace(/:menu$/, '')
  const repo = id.endsWith(':repo') ? id.slice(0, -':repo'.length) : null
  const suffixes = repo !== null ? ['fetch'] : BRANCH_ACTIONS
  const owner = repo ?? id
  return buttons.filter(button => suffixes.some(suffix => button.key === `${owner}:${suffix}`))
}
async function read(list: Mounted, key: string): Promise<{ actions: Shown[]; opened: boolean }> {
  let actions = actionsOf(await list.findAll({ type: 'Button' }), key)
  if (actions.length > 0 || key.endsWith(':repo:menu')) return { actions, opened: false }
  await list.press({ key: `${key.replace(/:menu$/, '')}:branch` })
  actions = actionsOf(await list.findAll({ type: 'Button' }), key)
  return { actions, opened: true }
}
async function offered(list: Mounted, key: string): Promise<string[]> {
  const { actions, opened } = await read(list, key)
  if (opened) await list.press({ key: `${key.replace(/:menu$/, '')}:branch` })
  return actions.map(labelOf)
}
async function pick(list: Mounted, key: string, label: string): Promise<void> {
  const { actions } = await read(list, key)
  const action = actions.find(button => labelOf(button) === label)
  if (action?.key === undefined) throw new Error(`no action ${label} for ${key}`)
  await list.press({ key: action.key })
}

const ROOT = '/home/dev/projects'

const PANE_PROPS = {
  isFocused: false,
  bodyColumns: 120,
  placement: 'dock',
  scroll: { offset: 0, bodyRows: 40 },
  view: {},
} as const

const LIST = {
  plugin: 'gitree',
  component: 'Pane',
  requestId: 'gitree',
  props: { ...PANE_PROPS, title: 'Repositories' },
} as const

const DIFF = {
  plugin: 'gitree',
  component: 'Pane',
  requestId: 'gitree-diff',
  props: { ...PANE_PROPS, title: 'Compare demo' },
} as const

// HEAD: 5 lines; working tree: line 2 changed and one line added at the end
const FULL_PATCH = [
  'diff --git a/src/a.ts b/src/a.ts',
  'index 1111111..2222222 100644',
  '--- a/src/a.ts',
  '+++ b/src/a.ts',
  '@@ -1,5 +1,6 @@',
  ' const a = 1',
  '-const b = 2',
  '+const b = 3',
  ' function f() {',
  '   return a + b',
  ' }',
  '+export default f',
  '',
].join('\n')

type Node = { type?: string; props?: Record<string, unknown>; children?: unknown[] }

// The node with that key in the drawn tree, and its parent
function keyed(tree: unknown, key: string, parent?: Node): { node: Node; parent: Node | undefined } | undefined {
  const node = tree as Node
  if (node === null || typeof node !== 'object') return undefined
  if (node.props?.key === key) return { node, parent }
  for (const child of node.children ?? []) {
    const found = keyed(child, key, node)
    if (found !== undefined) return found
  }
  return undefined
}

// The parts of a bar: space before the thumb, thumb, space after
async function barParts(desktop: { drawn: (scope: { in: string }) => Promise<unknown> }, key: string): Promise<Node[]> {
  const bar = keyed(await desktop.drawn({ in: 'compare' }), key)?.node
  return (bar?.children ?? []).filter((child): child is Node => child !== null && typeof child === 'object')
}

type Run = { exitCode: number; stdout: string; stderr: string; isStdoutTruncated: false; isStderrTruncated: false }

const ok = (stdout: string): Run => ({ exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false })

// Answers the mod's git commands like a `demo` repo with one changed file
function git(argv: readonly string[], fullPatch: string): Run {
  if (argv[0] === 'find') return ok(`${ROOT}/demo/.git\n`)
  if (argv.includes('status')) {
    return ok(
      [
        '# branch.head feature/x',
        '# branch.upstream origin/feature/x',
        '# branch.ab +0 -0',
        '1 .M N... 100644 100644 100644 1111111 1111111 src/a.ts',
        '',
      ].join('\n'),
    )
  }
  if (argv.includes('--numstat')) return ok('2\t1\tsrc/a.ts\n')
  if (argv.includes('ls-files')) return ok('')
  if (argv.includes('-U100000000')) return ok(fullPatch)
  if (argv.includes('-U6')) return ok(FULL_PATCH)
  return ok('')
}

function engine(on: On, fullPatch = FULL_PATCH): void {
  // Nothing sits below the mod: every hook here stands in for the engine
  on('process.run', (_, e) => ({ value: git(e.argv, fullPatch) }))
  // The session folder: repos are searched below it
  on('session.cwd', () => ({ value: ROOT }))
  on('clock.now', () => ({ value: Date.UTC(2026, 10, 5, 10, 0, 0) }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.toast', () => ({ value: undefined }))
  on('ui.log', () => ({ value: undefined }))
}

async function openDiff($: Engine): Promise<void> {
  await $.command.run({
    command: 'gitree',
    args: '',
    origin: { kind: 'composer' },
    presentation: { isFullscreen: true, columns: 120 },
  })
  const list = await $.ui.mount({ ...LIST, surface: 'desktop' })
  // Sections start closed: open the repo before pressing what is inside it
  await list.press({ key: 'demo:toggle' })
  await pick(list, 'demo:menu', 'Compare unstaged')
  await list.unmount()
}

test('on desktop the comparison is the graphical Client, on the terminal the Box and Text rows', async ($, on) => {
  engine(on)
  await openDiff($)

  const desktop = await $.ui.mount({ ...DIFF, surface: 'desktop' })
  expect(await desktop.find({ type: 'Client', key: 'compare' })).toBeDefined()
  expect(await desktop.find({ type: 'Button', key: 'diff:reload' })).toBeDefined()
  expect(await desktop.find({ type: 'Button', key: 'diff:close' })).toBeDefined()
  expect(await desktop.find({ type: 'Button', key: 'file:src/a.ts' })).toBeDefined()
  // The whole file: also the lines far from the blocks, with the line numbers of both sides
  expect(await desktop.find({ type: 'Text', text: /^HEAD$/, in: 'compare' })).toBeDefined()
  expect(await desktop.find({ type: 'Text', text: /^Working tree$/, in: 'compare' })).toBeDefined()
  expect(await desktop.find({ type: 'Text', text: /export default f/, in: 'compare' })).toBeDefined()
  expect(await desktop.find({ type: 'Text', text: /^6$/, in: 'compare' })).toBeDefined()
  // Changed words inside paired lines have their own background, the connector the ≠ mark
  const words = await desktop.findAll({ type: 'Text', in: 'compare' })
  const removed = words.find(word => word.props.backgroundColor === 'rgba(240, 140, 140, 0.45)')
  const added = words.find(word => word.props.backgroundColor === 'rgba(120, 200, 140, 0.45)')
  expect(removed?.text).toBe('2')
  expect(added?.text).toBe('3')
  expect(await desktop.find({ type: 'Text', text: /─≠─/, in: 'compare' })).toBeDefined()
  expect(await desktop.find({ type: 'Text', text: /─\+─/, in: 'compare' })).toBeDefined()
  expect(await desktop.find({ type: 'Text', text: /block 1 of 2/, in: 'compare' })).toBeDefined()
  await desktop.unmount()

  const terminal = await $.ui.mount({ ...DIFF, surface: 'terminal' })
  expect(await terminal.find({ type: 'Client' })).toBeUndefined()
  expect(await terminal.find({ type: 'Text', text: /^Working tree$/ })).toBeDefined()
  expect(await terminal.find({ type: 'Text', text: /const b = 3/ })).toBeDefined()
  expect(await terminal.find({ type: 'Button', key: 'diff:reload' })).toBeDefined()
  expect(await terminal.find({ type: 'Button', key: 'diff:close' })).toBeDefined()
  await terminal.unmount()
})

test('keys and the ruler move a single window for both sides', async ($, on) => {
  // A long file: 200 equal lines, then one changed block
  const head = Array.from({ length: 200 }, (_, i) => ` line ${i + 1}`)
  const patch = ['@@ -1,201 +1,201 @@', ...head, '-older', '+newer', ''].join('\n')
  engine(on, patch)
  await openDiff($)

  const desktop = await $.ui.mount({ ...DIFF, surface: 'desktop' })
  await desktop.resize({ columns: 100, rows: 22, in: 'compare' })
  // The view starts at the first block
  expect(await desktop.find({ type: 'Text', text: /^newer$/, in: 'compare' })).toBeDefined()
  await desktop.key({ key: 'home', in: 'compare' })
  expect(await desktop.find({ type: 'Text', text: /lines 1–20 of 201/, in: 'compare' })).toBeDefined()
  expect(await desktop.find({ type: 'Text', text: /^newer$/, in: 'compare' })).toBeUndefined()
  await desktop.key({ key: 'pagedown', in: 'compare' })
  expect(await desktop.find({ type: 'Text', text: /lines 20–39 of 201/, in: 'compare' })).toBeDefined()
  // Every shown row has the same number on the left and on the right: scrolling is shared
  const numbers = await desktop.findAll({ type: 'Text', text: /^20$/, in: 'compare' })
  expect(numbers).toHaveLength(2)
  await desktop.key({ key: 'n', in: 'compare' })
  expect(await desktop.find({ type: 'Text', text: /^newer$/, in: 'compare' })).toBeDefined()
  // A click at the top of the ruler goes back to the start of the file
  await desktop.pointer({ type: 'down', x: 99, y: 1, button: 'left', in: 'compare' })
  await desktop.pointer({ type: 'up', x: 99, y: 1, button: 'left', in: 'compare' })
  expect(await desktop.find({ type: 'Text', text: /lines 1–20 of 201/, in: 'compare' })).toBeDefined()
  await desktop.unmount()
})

test('a file over the props limit is truncated and the pane says so', async ($, on) => {
  const lines = Array.from({ length: 3000 }, (_, i) => `+${'x'.repeat(60)} ${i}`)
  engine(on, ['@@ -0,0 +1,3000 @@', ...lines, ''].join('\n'))
  await openDiff($)

  const desktop = await $.ui.mount({ ...DIFF, surface: 'desktop' })
  const notice = await desktop.find({ type: 'Text', text: /Comparison truncated/ })
  expect(notice?.text).toMatch(/of 3000 lines of the working tree/)
  const client = await desktop.find({ type: 'Client', key: 'compare' })
  expect(JSON.stringify(client?.props.props).length).toBeLessThan(100_000)
  await desktop.unmount()
})

test('the wheel on the pane scrolls the comparison when the pane has nothing else to scroll', async ($, on) => {
  const head = Array.from({ length: 200 }, (_, i) => ` line ${i + 1}`)
  engine(on, ['@@ -1,201 +1,201 @@', ...head, '-older', '+newer', ''].join('\n'))
  await openDiff($)

  const desktop = await $.ui.mount({ ...DIFF, surface: 'desktop' })
  await desktop.resize({ columns: 100, rows: 22, in: 'compare' })
  await desktop.key({ key: 'home', in: 'compare' })
  const result = await $.ui.scroll({
    component: 'Pane',
    requestId: 'gitree-diff',
    offset: 0,
    by: 2,
    bodyRows: 40,
    contentRows: 30,
    origin: { kind: 'person' },
    pointer: { column: 10, row: 12 },
  })
  expect(result.deny).toBeUndefined()
  // Two wheel notches, three lines each
  expect(await desktop.find({ type: 'Text', text: /lines 7–26 of 201/, in: 'compare' })).toBeDefined()
  await desktop.unmount()
})

test('the vertical bar: the thumb drags, a click on the track moves the view there', async ($, on) => {
  const head = Array.from({ length: 200 }, (_, i) => ` line ${i + 1}`)
  engine(on, ['@@ -1,201 +1,201 @@', ...head, '-older', '+newer', ''].join('\n'))
  await openDiff($)

  const desktop = await $.ui.mount({ ...DIFF, surface: 'desktop' })
  await desktop.resize({ columns: 100, rows: 22, in: 'compare' })
  await desktop.key({ key: 'home', in: 'compare' })
  // 20 of 201 lines in view: a single track 20 rows high, the thumb 2 rows high at the top; short lines, no
  // horizontal bar
  expect((await desktop.find({ type: 'Box', key: 'compare:track', in: 'compare' }))?.props.height).toBe(20)
  const [above, grip] = await barParts(desktop, 'compare:track')
  expect(above?.props?.height).toBe(0)
  expect(grip?.props).toMatchObject({ key: 'compare:thumb', height: 2 })
  expect(await desktop.find({ type: 'Box', key: 'compare:hbar', in: 'compare' })).toBeUndefined()
  // Grabbed at the top and dragged to mid-track
  await desktop.pointer({ type: 'down', x: 99, y: 1, button: 'left', in: 'compare' })
  await desktop.pointer({ type: 'move', x: 99, y: 10, button: 'left', in: 'compare' })
  await desktop.pointer({ type: 'up', x: 99, y: 10, button: 'left', in: 'compare' })
  expect(await desktop.find({ type: 'Text', text: /lines 92–111 of 201/, in: 'compare' })).toBeDefined()
  expect((await barParts(desktop, 'compare:track'))[0]?.props?.height).toBe(9)
  // Once released, the pointer no longer drags
  await desktop.pointer({ type: 'move', x: 99, y: 3, in: 'compare' })
  expect(await desktop.find({ type: 'Text', text: /lines 92–111 of 201/, in: 'compare' })).toBeDefined()
  // A click at the bottom of the track moves the view to the end of the file
  await desktop.pointer({ type: 'down', x: 99, y: 20, button: 'left', in: 'compare' })
  await desktop.pointer({ type: 'up', x: 99, y: 20, button: 'left', in: 'compare' })
  expect(await desktop.find({ type: 'Text', text: /lines 182–201 of 201/, in: 'compare' })).toBeDefined()
  expect(await desktop.find({ type: 'Text', text: /^newer$/, in: 'compare' })).toBeDefined()
  await desktop.unmount()
})

test('the horizontal bar: appears with wide lines, drags and responds to a click on the track', async ($, on) => {
  const wide = `begins${'.'.repeat(120)}LAST`
  engine(on, ['@@ -1,3 +1,3 @@', ` ${wide}`, '-older', '+newer', ' end', ''].join('\n'))
  await openDiff($)

  const desktop = await $.ui.mount({ ...DIFF, surface: 'desktop' })
  // 100 columns: 43 of text on each side for lines of 130, track of 95 cells, thumb of 31
  await desktop.resize({ columns: 100, rows: 22, in: 'compare' })
  expect((await desktop.find({ type: 'Box', key: 'compare:hthumb', in: 'compare' }))?.props.width).toBe(31)
  expect(await desktop.find({ type: 'Text', text: /LAST/, in: 'compare' })).toBeUndefined()
  // The bar sits below the 19 comparison rows: row 20 of the region
  await desktop.pointer({ type: 'down', x: 0, y: 20, button: 'left', in: 'compare' })
  await desktop.pointer({ type: 'move', x: 32, y: 20, button: 'left', in: 'compare' })
  await desktop.pointer({ type: 'up', x: 32, y: 20, button: 'left', in: 'compare' })
  expect(await desktop.find({ type: 'Text', text: /columns 45–87 of 130/, in: 'compare' })).toBeDefined()
  // A click at the end of the track moves the view to the end of the lines
  await desktop.pointer({ type: 'down', x: 94, y: 20, button: 'left', in: 'compare' })
  await desktop.pointer({ type: 'up', x: 94, y: 20, button: 'left', in: 'compare' })
  expect(await desktop.find({ type: 'Text', text: /columns 88–130 of 130/, in: 'compare' })).toBeDefined()
  expect(await desktop.findAll({ type: 'Text', text: /LAST/, in: 'compare' })).toHaveLength(2)
  await desktop.unmount()
})

test('the vertical bar sits right of the two sides and responds only where it is drawn', async ($, on) => {
  const head = Array.from({ length: 200 }, (_, i) => ` line ${i + 1}`)
  engine(on, ['@@ -1,201 +1,201 @@', ...head, '-older', '+newer', ''].join('\n'))
  await openDiff($)

  const desktop = await $.ui.mount({ ...DIFF, surface: 'desktop' })
  await desktop.resize({ columns: 100, rows: 22, in: 'compare' })
  await desktop.key({ key: 'home', in: 'compare' })
  const tree = await desktop.drawn({ in: 'compare' })
  // No element with absolute position: the desktop would anchor it elsewhere
  expect(JSON.stringify(tree)).not.toContain('absolute')
  // The body row: first the rows of the two sides (98 columns), last the track (2 columns)
  const body = keyed(tree, 'compare:track')?.parent
  const parts = (body?.children ?? []).filter((child): child is Node => child !== null && typeof child === 'object')
  expect(parts).toHaveLength(2)
  expect(parts[0]?.props?.width).toBe(98)
  expect(JSON.stringify(parts[0])).toContain('line 1')
  expect(parts[1]?.props).toMatchObject({ key: 'compare:track', width: 2, height: 20 })
  // A click on the marks column, just left of the bar, does not move the view; on the bar it does
  await desktop.pointer({ type: 'down', x: 97, y: 20, button: 'left', in: 'compare' })
  await desktop.pointer({ type: 'up', x: 97, y: 20, button: 'left', in: 'compare' })
  expect(await desktop.find({ type: 'Text', text: /lines 1–20 of 201/, in: 'compare' })).toBeDefined()
  await desktop.pointer({ type: 'down', x: 98, y: 20, button: 'left', in: 'compare' })
  await desktop.pointer({ type: 'up', x: 98, y: 20, button: 'left', in: 'compare' })
  expect(await desktop.find({ type: 'Text', text: /lines 182–201 of 201/, in: 'compare' })).toBeDefined()
  await desktop.unmount()
})
