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
const OUTSIDE = '/srv/wt/feature-x'

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

const STATUS: Record<string, string> = {
  [`${ROOT}/app`]: ['# branch.head develop', '# branch.upstream origin/develop', '# branch.ab +0 -0', ''].join('\n'),
  [OUTSIDE]: ['# branch.head feature-x', '1 .M N... 100644 100644 100644 1111111 1111111 src/a.ts', ''].join('\n'),
}

// `app` has a worktree outside the session folder, two other branches with commits to push (one also behind)
// and one checked out in that worktree, which is not listed among the others
const WORKTREES = [
  `worktree ${ROOT}/app`, 'HEAD 1111111', 'branch refs/heads/develop', '',
  `worktree ${OUTSIDE}`, 'HEAD 2222222', 'branch refs/heads/feature-x', '',
  `worktree ${ROOT}/app/.claude/worktrees/agent`, 'HEAD 3333333', 'branch refs/heads/agent', '',
].join('\n')

const REFS = [
  ['develop', 'origin/develop', 'origin', 'refs/heads/develop', '', `${ROOT}/app`],
  ['feature-x', '', '', '', '', OUTSIDE],
  ['fix-y', 'origin/fix-y', 'origin', 'refs/heads/fix-y', 'ahead 2', ''],
  ['old', 'origin/old', 'origin', 'refs/heads/old', 'ahead 1, behind 40', ''],
  ['backup', '', '', '', '', ''],
]
  .map(fields => fields.join('\t'))
  .join('\n')

function engine(on: On, calls: string[][]): void {
  on('process.run', (_, e) => {
    calls.push([...e.argv])
    if (e.argv[0] === 'find') return { value: ok(`${ROOT}/app/.git\n`) }
    const path = e.argv[2] ?? ''
    if (e.argv.includes('worktree')) return { value: ok(path === `${ROOT}/app` ? WORKTREES : '') }
    if (e.argv.includes('for-each-ref')) return { value: ok(REFS) }
    if (e.argv.includes('log')) return { value: ok('abc1234\tfix: the first\t6 weeks ago\nabc5678\tfix: the second\t2 days ago\n') }
    if (e.argv.includes('status')) return { value: ok(STATUS[path] ?? '') }
    return { value: ok('') }
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

test('a worktree sits among the branches of its repo, says where it is, and Claude worktrees stay out', async ($, on) => {
  const calls: string[][] = []
  engine(on, calls)
  await open($)
  const list = await $.ui.mount({ ...LIST, surface: 'desktop' })
  // No section of its own: the repo counts it among its branches
  expect(await list.find({ type: 'Button', key: 'feature-x:toggle' })).toBeUndefined()
  expect(await list.find({ type: 'Text', text: '4' })).toBeDefined()
  expect((await list.find({ type: 'Svg' }))?.props.alt).toBe('branches')
  await list.press({ key: 'app:toggle' })
  expect((await list.find({ type: 'Button', key: 'feature-x:branch' }))?.text).toMatch(/feature-x/)
  // The path is a message of the open branch
  expect(await list.find({ type: 'Text', text: `worktree in ${OUTSIDE}` })).toBeUndefined()
  await list.press({ key: 'feature-x:branch' })
  expect(await list.find({ type: 'Text', text: `worktree in ${OUTSIDE}` })).toBeDefined()
  expect(await offered(list, 'feature-x:menu')).toEqual(['Compare unstaged', 'Push'])
  expect(await list.find({ type: 'Button', key: 'agent:branch' })).toBeUndefined()
  // The comparison of the worktree reads its own folder
  await pick(list, 'feature-x:menu', 'Compare unstaged')
  expect(calls.some(argv => argv.includes('diff') && argv.includes(OUTSIDE))).toBe(true)
  // The worktree shares the branches of app: no for-each-ref on it
  expect(calls.some(argv => argv.includes('for-each-ref') && argv.includes(OUTSIDE))).toBe(false)
  await list.unmount()
})

test('fetch all fetches the repo once, not its worktrees', async ($, on) => {
  const calls: string[][] = []
  engine(on, calls)
  await open($)
  const list = await $.ui.mount({ ...LIST, surface: 'desktop' })
  await list.press({ key: 'refresh' })
  const fetches = calls.filter(argv => argv.includes('fetch'))
  expect(fetches.length).toBe(1)
  expect(fetches[0]).toContain(`${ROOT}/app`)
  await list.unmount()
})

test('other branches with commits to push: one line each, Push or the reason, commits on opening', async ($, on) => {
  const calls: string[][] = []
  engine(on, calls)
  await open($)
  const list = await $.ui.mount({ ...LIST, surface: 'desktop' })
  await list.press({ key: 'app:toggle' })
  expect(await list.find({ type: 'Button', key: 'app#fix-y:branch' })).toBeDefined()
  expect(await list.find({ type: 'Button', key: 'app#feature-x:branch' })).toBeUndefined()
  expect(await list.find({ type: 'Button', key: 'app#backup:branch' })).toBeUndefined()
  // The commits are read only when a branch opens
  expect(calls.some(argv => argv.includes('log'))).toBe(false)
  expect(await offered(list, 'app#fix-y:menu')).toEqual(['Compare commits', 'Push'])
  // A branch that cannot be pushed has no Push among its actions
  expect(await offered(list, 'app#old:menu')).toEqual(['Compare commits'])

  await list.press({ key: 'app#fix-y:branch' })
  expect(calls.some(argv => argv.includes('log') && argv.includes('origin/fix-y..fix-y'))).toBe(true)
  expect(await list.find({ type: 'Text', text: 'fix: the first' })).toBeDefined()
  expect(await list.find({ type: 'Text', text: '6w' })).toBeDefined()
  expect(await list.find({ type: 'Text', text: '2d' })).toBeDefined()
  await pick(list, 'app#fix-y:menu', 'Push')
  expect(calls).toContainEqual(['git', '-C', `${ROOT}/app`, 'push', 'origin', 'fix-y'])
  // The reason it cannot be pushed is a message of the open branch
  await list.press({ key: 'app#old:branch' })
  expect(await list.find({ type: 'Text', text: "can't push, diverged" })).toBeDefined()
  await list.unmount()
})

test('a commit of another branch is compared with its parent', async ($, on) => {
  const calls: string[][] = []
  engine(on, calls)
  await open($)
  const list = await $.ui.mount({ ...LIST, surface: 'desktop' })
  await list.press({ key: 'app:toggle' })
  await list.press({ key: 'app#fix-y:branch' })
  await list.press({ key: 'app#fix-y@abc1234' })
  expect(calls.some(argv => argv.includes('diff') && argv.includes('abc1234^') && argv.includes('abc1234'))).toBe(true)
  await list.unmount()
})
