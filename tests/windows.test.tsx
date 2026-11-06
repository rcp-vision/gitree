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

// Due repo sotto `git\`, uno con node_modules (da non leggere), una cartella senza repo
const TREE: Record<string, Entry[]> = {
  [ROOT]: [dir('git'), dir('documenti'), file('note.txt')],
  [`${ROOT}\\git`]: [dir('app'), dir('docs')],
  [`${ROOT}\\git\\app`]: [dir('.git'), dir('src'), dir('node_modules')],
  [`${ROOT}\\git\\docs`]: [file('.git'), file('README.md')],
  [`${ROOT}\\documenti`]: [file('a.docx')],
}

type Run = { exitCode: number; stdout: string; stderr: string; isStdoutTruncated: false; isStderrTruncated: false }

const ok = (stdout: string): Run => ({ exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false })

function engine(on: On): { listed: string[]; runs: { argv: string[]; env: unknown }[] } {
  const listed: string[] = []
  const runs: { argv: string[]; env: unknown }[] = []
  on('fs.list', (_, e) => {
    // Il kit gira su Linux e antepone la sua cartella a `C:\…`, che lì non è assoluto; su Windows arriva com'è
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

test('su Windows i repo si trovano leggendo le cartelle, senza find, e i nomi partono dalla cartella comune', async (
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
  // Un repo trovato non si esplora
  expect(listed).not.toContain(`${ROOT}\\git\\app\\src`)
  expect(listed).not.toContain(`${ROOT}\\git\\app\\node_modules`)
  expect(runs.some(run => run.argv.includes(`${ROOT}\\git\\docs`))).toBe(true)

  const list = await $.ui.mount({ ...LIST, surface: 'desktop' })
  expect(await list.find({ type: 'Text', text: /^app$/ })).toBeDefined()
  expect(await list.find({ type: 'Text', text: /^docs$/ })).toBeDefined()
  await list.unmount()
})

test('su Windows fetch non imposta la connessione SSH condivisa', async ($, on) => {
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
