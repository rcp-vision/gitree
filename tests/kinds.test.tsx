import { expect, test } from 'claude-code/testing'
import type { On } from 'claude-code'
import type { Engine } from 'claude-code/testing'

const ROOT = '/home/dev/projects'
const BASE = 'abc1234abc1234abc1234abc1234abc1234abc12'

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

const PATCH = ['@@ -1,2 +1,2 @@', ' same', '-older', '+newer', ''].join('\n')

type Run = { exitCode: number; stdout: string; stderr: string; isStdoutTruncated: false; isStderrTruncated: false }

const ok = (stdout: string): Run => ({ exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false })

// A `demo` repo with a file staged and modified again, an untracked file and two unpushed commits
function git(argv: readonly string[], status: string): Run {
  if (argv[0] === 'find') return ok(`${ROOT}/demo/.git\n`)
  if (argv.includes('status')) return ok(status)
  if (argv.includes('merge-base')) return ok(`${BASE}\n`)
  if (argv.includes('log')) return ok('a1b2c3d\tbump version\ne4f5a6b\tfix login form\n')
  if (argv.includes('--numstat')) {
    if (argv.includes('--cached')) return ok('1\t1\tsrc/staged.ts\n')
    if (argv.includes(BASE)) return ok('3\t0\tbuild.gradle\n')
    return ok('1\t1\tsrc/staged.ts\n')
  }
  if (argv.includes('ls-files')) return ok('added.txt\n')
  return ok(PATCH)
}

const MIXED = [
  '# branch.head feature/x',
  '# branch.upstream origin/feature/x',
  '# branch.ab +2 -0',
  '1 MM N... 100644 100644 100644 1111111 2222222 src/staged.ts',
  '? added.txt',
  '',
].join('\n')

function engine(on: On, status = MIXED): string[][] {
  const calls: string[][] = []
  on('process.run', (_, e) => {
    calls.push([...e.argv])
    return { value: git(e.argv, status) }
  })
  on('session.cwd', () => ({ value: ROOT }))
  on('clock.now', () => ({ value: Date.UTC(2026, 10, 5, 10, 0, 0) }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.toast', () => ({ value: undefined }))
  on('ui.log', () => ({ value: undefined }))
  return calls
}

async function press($: Engine, key: string): Promise<void> {
  await $.command.run({
    command: 'gitree',
    args: '',
    origin: { kind: 'composer' },
    presentation: { isFullscreen: true, columns: 120 },
  })
  const list = await $.ui.mount({ ...LIST, surface: 'desktop' })
  await list.press({ key })
  await list.unmount()
}

test('with staged and unstaged changes, the row offers Unstaged, Staged and Unpushed', async ($, on) => {
  engine(on)
  await press($, 'demo:diff')
  const list = await $.ui.mount({ ...LIST, surface: 'desktop' })
  // Unstaged also counts the untracked file, as in the EGit Git Staging view
  expect((await list.find({ type: 'Button', key: 'demo:diff' }))?.text).toBe('Unstaged 2')
  expect((await list.find({ type: 'Button', key: 'demo:diff-staged' }))?.text).toBe('Staged 1')
  expect((await list.find({ type: 'Button', key: 'demo:diff-push' }))?.text).toBe('Unpushed 2')
  await list.unmount()
})

test('only unstaged changes and nothing to push: Unstaged stays alone', async ($, on) => {
  const status = ['# branch.head feature/x', '# branch.upstream origin/feature/x', '# branch.ab +0 -0',
    '1 .M N... 100644 100644 100644 1111111 1111111 src/a.ts', ''].join('\n')
  engine(on, status)
  await press($, 'demo:diff')
  const list = await $.ui.mount({ ...LIST, surface: 'desktop' })
  expect(await list.find({ type: 'Button', key: 'demo:diff' })).toBeDefined()
  expect(await list.find({ type: 'Button', key: 'demo:diff-staged' })).toBeUndefined()
  expect(await list.find({ type: 'Button', key: 'demo:diff-push' })).toBeUndefined()
  await list.unmount()
})

test('staged compares HEAD with the index, without untracked files', async ($, on) => {
  const calls = engine(on)
  await press($, 'demo:diff-staged')
  const desktop = await $.ui.mount({ ...DIFF, surface: 'desktop' })
  expect(await desktop.find({ type: 'Text', text: /^HEAD$/, in: 'compare' })).toBeDefined()
  expect(await desktop.find({ type: 'Text', text: /^Index$/, in: 'compare' })).toBeDefined()
  expect(await desktop.find({ type: 'Button', key: 'file:added.txt' })).toBeUndefined()
  expect(calls.some(argv => argv.includes('--cached') && argv.includes('src/staged.ts'))).toBe(true)
  await desktop.unmount()
})

test('unstaged compares the index with the working tree, with untracked files', async ($, on) => {
  const calls = engine(on)
  await press($, 'demo:diff')
  const desktop = await $.ui.mount({ ...DIFF, surface: 'desktop' })
  expect(await desktop.find({ type: 'Text', text: /^Index$/, in: 'compare' })).toBeDefined()
  expect(await desktop.find({ type: 'Text', text: /^Working tree$/, in: 'compare' })).toBeDefined()
  expect(await desktop.find({ type: 'Button', key: 'file:added.txt' })).toBeDefined()
  const fileDiff = calls.find(argv => argv.includes('-U100000000'))
  expect(fileDiff).toBeDefined()
  expect(fileDiff?.includes('HEAD')).toBe(false)
  expect(fileDiff?.includes('--cached')).toBe(false)
  await desktop.unmount()
})

test('unpushed compares the point where the branch left the upstream with HEAD and lists the commits', async ($, on) => {
  const calls = engine(on)
  await press($, 'demo:diff-push')
  const desktop = await $.ui.mount({ ...DIFF, surface: 'desktop' })
  expect(await desktop.find({ type: 'Text', text: /^origin\/feature\/x$/, in: 'compare' })).toBeDefined()
  expect(await desktop.find({ type: 'Text', text: /^HEAD$/, in: 'compare' })).toBeDefined()
  expect(await desktop.find({ type: 'Text', text: /^a1b2c3d$/ })).toBeDefined()
  expect(await desktop.find({ type: 'Text', text: /fix login form/ })).toBeDefined()
  expect(await desktop.find({ type: 'Button', key: 'file:build.gradle' })).toBeDefined()
  expect(calls.some(argv => argv.includes('merge-base') && argv.includes('origin/feature/x'))).toBe(true)
  expect(calls.some(argv => argv.includes('ls-files'))).toBe(false)
  await desktop.unmount()
})
