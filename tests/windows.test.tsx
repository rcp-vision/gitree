import { expect, test } from 'claude-code/testing'
import type { On } from 'claude-code'

const ROOT = 'C:\\Users\\dev\\repos'

const LIST = {
  plugin: 'gitree',
  component: 'Pane',
  requestId: 'gitree',
  props: {
    isFocused: false,
    bodyColumns: 120,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 40 },
    view: {},
    title: 'Repositories',
  },
} as const

type Entry = { name: string; kind: 'file' | 'dir' | 'other'; size: number; mtimeMs: number; isLink: boolean }

const dir = (name: string): Entry => ({ name, kind: 'dir', size: 0, mtimeMs: 0, isLink: false })
const file = (name: string): Entry => ({ name, kind: 'file', size: 1, mtimeMs: 0, isLink: false })

// Two repos under `git\`, one with node_modules (not to be read), a folder without repos
const TREE: Record<string, Entry[]> = {
  [ROOT]: [dir('git'), dir('documents'), file('notes.txt')],
  [`${ROOT}\\git`]: [dir('app'), dir('docs')],
  [`${ROOT}\\git\\app`]: [dir('.git'), dir('src'), dir('node_modules')],
  [`${ROOT}\\git\\docs`]: [file('.git'), file('README.md')],
  [`${ROOT}\\documents`]: [file('a.docx')],
}

type Run = { exitCode: number; stdout: string; stderr: string; isStdoutTruncated: false; isStderrTruncated: false }

const ok = (stdout: string): Run => ({ exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false })

function engine(on: On): { listed: string[]; runs: { argv: string[]; env: unknown }[] } {
  const listed: string[] = []
  const runs: { argv: string[]; env: unknown }[] = []
  on('fs.list', (_, e) => {
    // The kit runs on Linux and prepends its folder to `C:\…`, which is not absolute there; on Windows it arrives as is
    const path = e.path.slice(e.path.indexOf('C:\\'))
    listed.push(path)
    return { value: TREE[path] ?? [] }
  })
  on('process.run', (_, e) => {
    runs.push({ argv: [...e.argv], env: e.init?.env })
    if (e.argv.includes('status')) {
      return {
        value: ok(['# branch.head develop', '# branch.upstream origin/develop', '# branch.ab +1 -0', ''].join('\n')),
      }
    }
    return { value: ok('') }
  })
  on('session.cwd', () => ({ value: ROOT }))
  on('clock.now', () => ({ value: Date.UTC(2026, 10, 5, 10, 0, 0) }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.toast', () => ({ value: undefined }))
  on('ui.log', () => ({ value: undefined }))
  return { listed, runs }
}

test('on Windows repos are found by reading folders, without find, and names start from the common folder', async (
  $,
  on,
) => {
  const { listed, runs } = engine(on)
  await $.command.run({
    command: 'gitree',
    args: '',
    origin: { kind: 'composer' },
    presentation: { isFullscreen: true, columns: 120 },
  })
  expect(runs.some(run => run.argv[0] === 'find')).toBe(false)
  // A found repo is not explored
  expect(listed).not.toContain(`${ROOT}\\git\\app\\src`)
  expect(listed).not.toContain(`${ROOT}\\git\\app\\node_modules`)
  expect(runs.some(run => run.argv.includes(`${ROOT}\\git\\docs`))).toBe(true)

  const list = await $.ui.mount({ ...LIST, surface: 'desktop' })
  expect(await list.find({ type: 'Text', text: /^app$/ })).toBeDefined()
  expect(await list.find({ type: 'Text', text: /^docs$/ })).toBeDefined()
  await list.unmount()
})

test('on Windows fetch does not set up the shared SSH connection', async ($, on) => {
  const { runs } = engine(on)
  await $.command.run({
    command: 'gitree',
    args: '',
    origin: { kind: 'composer' },
    presentation: { isFullscreen: true, columns: 120 },
  })
  const list = await $.ui.mount({ ...LIST, surface: 'desktop' })
  await list.press({ key: 'docs:fetch' })
  await list.unmount()
  const fetch = runs.find(run => run.argv.includes('fetch'))
  expect(fetch).toBeDefined()
  expect(fetch?.env).toBeUndefined()
})
