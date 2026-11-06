import { expect, test } from 'claude-code/testing'
import type { On } from 'claude-code'
import type { Engine } from 'claude-code/testing'

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
  props: { ...PANE_PROPS, title: 'Repository' },
} as const

const DIFF = {
  plugin: 'gitree',
  component: 'Pane',
  requestId: 'gitree-diff',
  props: { ...PANE_PROPS, title: 'Confronto demo' },
} as const

// HEAD: 5 righe; copia di lavoro: la riga 2 cambiata e una riga aggiunta in fondo
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

// Il nodo con quella chiave nell'albero disegnato, e il suo genitore
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

// Le parti di una barra: spazio prima del cursore, cursore, spazio dopo
async function barParts(desktop: { drawn: (scope: { in: string }) => Promise<unknown> }, key: string): Promise<Node[]> {
  const bar = keyed(await desktop.drawn({ in: 'compare' }), key)?.node
  return (bar?.children ?? []).filter((child): child is Node => child !== null && typeof child === 'object')
}

type Run = { exitCode: number; stdout: string; stderr: string; isStdoutTruncated: false; isStderrTruncated: false }

const ok = (stdout: string): Run => ({ exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false })

// Risponde ai comandi git del mod come un repo `demo` con un file cambiato
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
  // Niente sta sotto il mod: ogni hook qui fa le veci del motore
  on('process.run', (_, e) => ({ value: git(e.argv, fullPatch) }))
  // La cartella della sessione: i repo si cercano lì sotto
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
  await list.press({ key: 'demo:diff' })
  await list.unmount()
}

test('il confronto su desktop è il Client grafico, sul terminale le righe a Box e Text', async ($, on) => {
  engine(on)
  await openDiff($)

  const desktop = await $.ui.mount({ ...DIFF, surface: 'desktop' })
  expect(await desktop.find({ type: 'Client', key: 'compare' })).toBeDefined()
  expect(await desktop.find({ type: 'Button', key: 'diff:reload' })).toBeDefined()
  expect(await desktop.find({ type: 'Button', key: 'diff:close' })).toBeDefined()
  expect(await desktop.find({ type: 'Button', key: 'file:src/a.ts' })).toBeDefined()
  // Il file intero: anche le righe lontane dai blocchi, con i numeri di riga dei due lati
  expect(await desktop.find({ type: 'Text', text: /^HEAD$/, in: 'compare' })).toBeDefined()
  expect(await desktop.find({ type: 'Text', text: /^Copia di lavoro$/, in: 'compare' })).toBeDefined()
  expect(await desktop.find({ type: 'Text', text: /export default f/, in: 'compare' })).toBeDefined()
  expect(await desktop.find({ type: 'Text', text: /^6$/, in: 'compare' })).toBeDefined()
  // Le parole cambiate dentro le righe appaiate hanno lo sfondo proprio, il connettore il segno ≠
  const words = await desktop.findAll({ type: 'Text', in: 'compare' })
  const removed = words.find(word => word.props.backgroundColor === 'rgba(240, 140, 140, 0.45)')
  const added = words.find(word => word.props.backgroundColor === 'rgba(120, 200, 140, 0.45)')
  expect(removed?.text).toBe('2')
  expect(added?.text).toBe('3')
  expect(await desktop.find({ type: 'Text', text: /─≠─/, in: 'compare' })).toBeDefined()
  expect(await desktop.find({ type: 'Text', text: /─\+─/, in: 'compare' })).toBeDefined()
  expect(await desktop.find({ type: 'Text', text: /blocco 1 di 2/, in: 'compare' })).toBeDefined()
  await desktop.unmount()

  const terminal = await $.ui.mount({ ...DIFF, surface: 'terminal' })
  expect(await terminal.find({ type: 'Client' })).toBeUndefined()
  expect(await terminal.find({ type: 'Text', text: /^Copia di lavoro$/ })).toBeDefined()
  expect(await terminal.find({ type: 'Text', text: /const b = 3/ })).toBeDefined()
  expect(await terminal.find({ type: 'Button', key: 'diff:reload' })).toBeDefined()
  expect(await terminal.find({ type: 'Button', key: 'diff:close' })).toBeDefined()
  await terminal.unmount()
})

test('i tasti e il righello spostano una sola finestra per i due lati', async ($, on) => {
  // Un file lungo: 200 righe uguali, poi un blocco cambiato
  const head = Array.from({ length: 200 }, (_, i) => ` riga ${i + 1}`)
  const patch = ['@@ -1,201 +1,201 @@', ...head, '-vecchia', '+nuova', ''].join('\n')
  engine(on, patch)
  await openDiff($)

  const desktop = await $.ui.mount({ ...DIFF, surface: 'desktop' })
  await desktop.resize({ columns: 100, rows: 22, in: 'compare' })
  // La vista parte dal primo blocco
  expect(await desktop.find({ type: 'Text', text: /^nuova$/, in: 'compare' })).toBeDefined()
  await desktop.key({ key: 'home', in: 'compare' })
  expect(await desktop.find({ type: 'Text', text: /righe 1–20 di 201/, in: 'compare' })).toBeDefined()
  expect(await desktop.find({ type: 'Text', text: /^nuova$/, in: 'compare' })).toBeUndefined()
  await desktop.key({ key: 'pagedown', in: 'compare' })
  expect(await desktop.find({ type: 'Text', text: /righe 20–39 di 201/, in: 'compare' })).toBeDefined()
  // Ogni riga mostrata ha lo stesso numero a sinistra e a destra: lo scorrimento è condiviso
  const numbers = await desktop.findAll({ type: 'Text', text: /^20$/, in: 'compare' })
  expect(numbers).toHaveLength(2)
  await desktop.key({ key: 'n', in: 'compare' })
  expect(await desktop.find({ type: 'Text', text: /^nuova$/, in: 'compare' })).toBeDefined()
  // Un clic in cima al righello riporta all'inizio del file
  await desktop.pointer({ type: 'down', x: 99, y: 1, button: 'left', in: 'compare' })
  await desktop.pointer({ type: 'up', x: 99, y: 1, button: 'left', in: 'compare' })
  expect(await desktop.find({ type: 'Text', text: /righe 1–20 di 201/, in: 'compare' })).toBeDefined()
  await desktop.unmount()
})

test('un file oltre il limite dei props è tagliato e il pannello lo dice', async ($, on) => {
  const lines = Array.from({ length: 3000 }, (_, i) => `+${'x'.repeat(60)} ${i}`)
  engine(on, ['@@ -0,0 +1,3000 @@', ...lines, ''].join('\n'))
  await openDiff($)

  const desktop = await $.ui.mount({ ...DIFF, surface: 'desktop' })
  const notice = await desktop.find({ type: 'Text', text: /Confronto tagliato/ })
  expect(notice?.text).toMatch(/di 3000 della copia di lavoro/)
  const client = await desktop.find({ type: 'Client', key: 'compare' })
  expect(JSON.stringify(client?.props.props).length).toBeLessThan(100_000)
  await desktop.unmount()
})

test('la rotella sul pannello scorre il confronto quando il pannello non ha altro da scorrere', async ($, on) => {
  const head = Array.from({ length: 200 }, (_, i) => ` riga ${i + 1}`)
  engine(on, ['@@ -1,201 +1,201 @@', ...head, '-vecchia', '+nuova', ''].join('\n'))
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
  // Due scatti di rotella, tre righe ciascuno
  expect(await desktop.find({ type: 'Text', text: /righe 7–26 di 201/, in: 'compare' })).toBeDefined()
  await desktop.unmount()
})

test('la barra verticale: il cursore si trascina, un clic sulla traccia porta la vista lì', async ($, on) => {
  const head = Array.from({ length: 200 }, (_, i) => ` riga ${i + 1}`)
  engine(on, ['@@ -1,201 +1,201 @@', ...head, '-vecchia', '+nuova', ''].join('\n'))
  await openDiff($)

  const desktop = await $.ui.mount({ ...DIFF, surface: 'desktop' })
  await desktop.resize({ columns: 100, rows: 22, in: 'compare' })
  await desktop.key({ key: 'home', in: 'compare' })
  // 20 righe in vista su 201: una sola traccia alta 20 righe, il cursore alto 2 in cima; righe corte, niente barra
  // orizzontale
  expect((await desktop.find({ type: 'Box', key: 'compare:track', in: 'compare' }))?.props.height).toBe(20)
  const [above, grip] = await barParts(desktop, 'compare:track')
  expect(above?.props?.height).toBe(0)
  expect(grip?.props).toMatchObject({ key: 'compare:thumb', height: 2 })
  expect(await desktop.find({ type: 'Box', key: 'compare:hbar', in: 'compare' })).toBeUndefined()
  // Afferrato in cima e trascinato a metà traccia
  await desktop.pointer({ type: 'down', x: 99, y: 1, button: 'left', in: 'compare' })
  await desktop.pointer({ type: 'move', x: 99, y: 10, button: 'left', in: 'compare' })
  await desktop.pointer({ type: 'up', x: 99, y: 10, button: 'left', in: 'compare' })
  expect(await desktop.find({ type: 'Text', text: /righe 92–111 di 201/, in: 'compare' })).toBeDefined()
  expect((await barParts(desktop, 'compare:track'))[0]?.props?.height).toBe(9)
  // Rilasciato, il puntatore non trascina più
  await desktop.pointer({ type: 'move', x: 99, y: 3, in: 'compare' })
  expect(await desktop.find({ type: 'Text', text: /righe 92–111 di 201/, in: 'compare' })).toBeDefined()
  // Un clic in fondo alla traccia porta la vista alla fine del file
  await desktop.pointer({ type: 'down', x: 99, y: 20, button: 'left', in: 'compare' })
  await desktop.pointer({ type: 'up', x: 99, y: 20, button: 'left', in: 'compare' })
  expect(await desktop.find({ type: 'Text', text: /righe 182–201 di 201/, in: 'compare' })).toBeDefined()
  expect(await desktop.find({ type: 'Text', text: /^nuova$/, in: 'compare' })).toBeDefined()
  await desktop.unmount()
})

test('la barra orizzontale: compare con le righe larghe, si trascina e risponde al clic sulla traccia', async ($, on) => {
  const wide = `inizio${'.'.repeat(120)}FINE`
  engine(on, ['@@ -1,3 +1,3 @@', ` ${wide}`, '-vecchia', '+nuova', ' fine', ''].join('\n'))
  await openDiff($)

  const desktop = await $.ui.mount({ ...DIFF, surface: 'desktop' })
  // 100 colonne: 43 di testo per lato su righe di 130, traccia di 95 celle, cursore di 31
  await desktop.resize({ columns: 100, rows: 22, in: 'compare' })
  expect((await desktop.find({ type: 'Box', key: 'compare:hthumb', in: 'compare' }))?.props.width).toBe(31)
  expect(await desktop.find({ type: 'Text', text: /FINE/, in: 'compare' })).toBeUndefined()
  // La barra sta sotto le 19 righe del confronto: riga 20 della regione
  await desktop.pointer({ type: 'down', x: 0, y: 20, button: 'left', in: 'compare' })
  await desktop.pointer({ type: 'move', x: 32, y: 20, button: 'left', in: 'compare' })
  await desktop.pointer({ type: 'up', x: 32, y: 20, button: 'left', in: 'compare' })
  expect(await desktop.find({ type: 'Text', text: /colonne 45–87 di 130/, in: 'compare' })).toBeDefined()
  // Un clic in fondo alla traccia porta la vista alla fine delle righe
  await desktop.pointer({ type: 'down', x: 94, y: 20, button: 'left', in: 'compare' })
  await desktop.pointer({ type: 'up', x: 94, y: 20, button: 'left', in: 'compare' })
  expect(await desktop.find({ type: 'Text', text: /colonne 88–130 di 130/, in: 'compare' })).toBeDefined()
  expect(await desktop.findAll({ type: 'Text', text: /FINE/, in: 'compare' })).toHaveLength(2)
  await desktop.unmount()
})

test('la barra verticale sta a destra dei due lati e risponde solo dove è disegnata', async ($, on) => {
  const head = Array.from({ length: 200 }, (_, i) => ` riga ${i + 1}`)
  engine(on, ['@@ -1,201 +1,201 @@', ...head, '-vecchia', '+nuova', ''].join('\n'))
  await openDiff($)

  const desktop = await $.ui.mount({ ...DIFF, surface: 'desktop' })
  await desktop.resize({ columns: 100, rows: 22, in: 'compare' })
  await desktop.key({ key: 'home', in: 'compare' })
  const tree = await desktop.drawn({ in: 'compare' })
  // Nessun elemento in posizione assoluta: il desktop lo ancorerebbe altrove
  expect(JSON.stringify(tree)).not.toContain('absolute')
  // La riga del corpo: prima le righe dei due lati (98 colonne), ultima la traccia (2 colonne)
  const body = keyed(tree, 'compare:track')?.parent
  const parts = (body?.children ?? []).filter((child): child is Node => child !== null && typeof child === 'object')
  expect(parts).toHaveLength(2)
  expect(parts[0]?.props?.width).toBe(98)
  expect(JSON.stringify(parts[0])).toContain('riga 1')
  expect(parts[1]?.props).toMatchObject({ key: 'compare:track', width: 2, height: 20 })
  // Un clic sulla colonna dei segni, appena a sinistra della barra, non sposta la vista; sulla barra sì
  await desktop.pointer({ type: 'down', x: 97, y: 20, button: 'left', in: 'compare' })
  await desktop.pointer({ type: 'up', x: 97, y: 20, button: 'left', in: 'compare' })
  expect(await desktop.find({ type: 'Text', text: /righe 1–20 di 201/, in: 'compare' })).toBeDefined()
  await desktop.pointer({ type: 'down', x: 98, y: 20, button: 'left', in: 'compare' })
  await desktop.pointer({ type: 'up', x: 98, y: 20, button: 'left', in: 'compare' })
  expect(await desktop.find({ type: 'Text', text: /righe 182–201 di 201/, in: 'compare' })).toBeDefined()
  await desktop.unmount()
})
