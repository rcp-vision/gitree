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

const LIST = {
  plugin: 'gitree',
  component: 'Pane',
  requestId: 'gitree',
  props: {
    isFocused: false,
    bodyColumns: 44,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 40 },
    view: {},
    title: 'Repositories',
  },
} as const

type Run = { exitCode: number; stdout: string; stderr: string; isStdoutTruncated: false; isStderrTruncated: false }

const ok = (stdout: string): Run => ({ exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false })

// `app` has changes and commits to push and pull; `docs` is clean on main
const BASE_STATUS: Record<string, string> = {
  app: ['# branch.head develop', '# branch.upstream origin/develop', '# branch.ab +9 -24',
    '1 .M N... 100644 100644 100644 1111111 1111111 src/a.ts', '? new.txt', ''].join('\n'),
  docs: ['# branch.head main', '# branch.upstream origin/main', '# branch.ab +0 -0', ''].join('\n'),
}

// A test can replace one repo's status
function engine(on: On, overrides: Record<string, string> = {}): void {
  const status = { ...BASE_STATUS, ...overrides }
  on('process.run', (_, e) => {
    if (e.argv[0] === 'find') return { value: ok(`${ROOT}/app/.git\n${ROOT}/docs/.git\n`) }
    const repo = e.argv.includes(`${ROOT}/docs`) ? 'docs' : 'app'
    return { value: ok(e.argv.includes('status') ? (status[repo] ?? '') : '') }
  })
  on('session.cwd', () => ({ value: ROOT }))
  on('clock.now', () => ({ value: Date.UTC(2026, 10, 7, 10, 0, 0) }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.toast', () => ({ value: undefined }))
  on('ui.log', () => ({ value: undefined }))
}

async function open($: Engine): Promise<void> {
  await $.command.run({
    command: 'gitree',
    args: '',
    origin: { kind: 'composer' },
    presentation: { isFullscreen: true, columns: 120 },
  })
}

test('a closed section shows name, counters and branch on two lines, with nothing else', async ($, on) => {
  engine(on)
  await open($)
  const list = await $.ui.mount({ ...LIST, surface: 'desktop' })
  expect((await list.find({ type: 'Button', key: 'app:toggle' }))?.text).toMatch(/app/)
  expect(await list.find({ type: 'Text', text: '●2' })).toBeDefined()
  expect(await list.find({ type: 'Text', text: '↑9' })).toBeDefined()
  expect(await list.find({ type: 'Text', text: '↓24' })).toBeDefined()
  expect(await list.find({ type: 'Text', text: 'develop' })).toBeDefined()
  expect(await list.find({ type: 'Button', key: 'app:diff' })).toBeUndefined()
  expect(await list.find({ type: 'Button', key: 'app:push' })).toBeUndefined()
  await list.unmount()
})

test('an open section lists the branch with its messages, and the actions in its menu', async ($, on) => {
  engine(on)
  await open($)
  const list = await $.ui.mount({ ...LIST, surface: 'desktop' })
  await list.press({ key: 'app:toggle' })
  expect(await list.find({ type: 'Text', text: '2 unstaged files' })).toBeDefined()
  expect(await list.find({ type: 'Text', text: '9 commits to push' })).toBeDefined()
  expect(await list.find({ type: 'Text', text: '24 commits to pull' })).toBeDefined()
  // The current branch starts open: its actions are links under its messages, no button at the end of the row
  expect(await offered(list, 'app:menu')).toEqual(['Compare unstaged', 'Compare commits', 'Push', 'Pull'])
  expect(await list.find({ type: 'Button', key: 'app:menu' })).toBeUndefined()
  // Fetch closes the open repo card
  expect(await offered(list, 'app:repo:menu')).toEqual(['Fetch'])
  await list.press({ key: 'app:toggle' })
  expect(await list.find({ type: 'Button', key: 'app:diff' })).toBeUndefined()
  await list.unmount()
})

test('a branch with no upstream has no pill and no message, and its menu still offers Push', async ($, on) => {
  const app = ['# branch.head fraguid/blotter', '1 .M N... 100644 100644 100644 1111111 1111111 src/a.ts', '']
  engine(on, { app: app.join('\n') })
  await open($)
  const list = await $.ui.mount({ ...LIST, surface: 'desktop' })
  expect(await list.find({ type: 'Text', text: 'no upstream' })).toBeUndefined()
  await list.press({ key: 'app:toggle' })
  expect(await list.find({ type: 'Text', text: 'Not on the remote yet' })).toBeUndefined()
  expect(await offered(list, 'app:menu')).toContain('Push')
  await list.unmount()
})

test('a clean repo is a section like the others, with a check, its branch in sync and Fetch', async ($, on) => {
  engine(on)
  await open($)
  const list = await $.ui.mount({ ...LIST, surface: 'desktop' })
  expect(await list.find({ type: 'Button', key: 'clean:toggle' })).toBeUndefined()
  expect((await list.find({ type: 'Button', key: 'docs:toggle' }))?.text).toMatch(/docs/)
  expect(await list.find({ type: 'Text', text: '✓' })).toBeDefined()
  await list.press({ key: 'docs:toggle' })
  expect(await list.find({ type: 'Text', text: 'In sync with origin/main' })).toBeDefined()
  expect(await offered(list, 'docs:repo:menu')).toEqual(['Fetch'])
  await list.unmount()
})
