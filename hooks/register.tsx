import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type {
  CompareBlock,
  ComparePayload,
  CompareWheel,
  DiffCommit,
  DiffFile,
  DiffKind,
  DiffRow,
  RepoAction,
  RepoBusy,
  RepoDiff,
  RepoStatus,
} from '../types'

const PANE = 'gitree'
const DIFF_PANE = 'gitree-diff'
// Il confronto grafico riceve il file intero nei props del Client, che ne tengono al più 100.000 caratteri:
// oltre questo budget le righe si fermano e il pannello lo dice
const COMPARE_BUDGET = 90_000
// Una riga oltre questa lunghezza (un file minificato) si accorcia: da sola consumerebbe il budget
const COMPARE_LINE_MAX = 1_000
const TAB_WIDTH = 4
// Altezza del confronto grafico quando il pannello non dice quante righe ha
const COMPARE_DEFAULT_ROWS = 30
const COMPARE_MIN_ROWS = 12
const COMPARE_MAX_ROWS = 80
// Righe tolte e aggiunte nel confronto a Box e Text: pastello come le altre tinte del pannello
const REMOVED_BACKGROUND = 'rgba(240, 160, 160, 0.22)'
const ADDED_BACKGROUND = 'rgba(140, 210, 160, 0.22)'
// Oltre queste righe il confronto si ferma e lo dice: un diff enorme non va disegnato riga per riga
const DIFF_MAX_ROWS = 800
// Righe di contesto attorno a ogni blocco cambiato, come nel confronto di EGit con le parti uguali compresse
const DIFF_CONTEXT = 6
const TITLE = 'Repositories'
// I repo si cercano sotto la cartella della sessione, a qualunque profondità entro SEARCH_DEPTH; queste cartelle
// non si esplorano: dipendenze, worktree di Claude, ambienti, cache
const SEARCH_DEPTH = '8'
const SEARCH_DEPTH_LEVELS = Number(SEARCH_DEPTH)
const SKIPPED_FOLDERS = ['node_modules', '.claude', '.direnv', '.gradle', '.venv', 'venv']
const EVERY_MS = 30_000
// I commit da pushare elencati sopra il confronto: oltre, il pannello dice quanti ne restano
const COMMITS_MAX = 50
// Un repo su uno di questi branch, pulito e allineato, non è «in lavorazione»
const BASE_BRANCHES = ['master', 'main', 'develop']
// Larghezze delle colonne della tabella; lo stato prende il resto
const COLUMNS = { repo: '22%', branch: '30%', actions: '24%' } as const
// Sfondi pastello semitrasparenti: restano leggibili sia col tema chiaro sia con quello scuro
const HEADER_BACKGROUND = 'rgba(160, 180, 230, 0.16)'
const STRIPE_BACKGROUND = 'rgba(170, 215, 200, 0.07)'
// I pulsanti della tabella: bordo sottile grigio scuro e uno sfondo pastello per azione. Il Button nativo non accetta
// né bordo né colore, quindi li porta il Box attorno, alto una riga: il desktop disegna il bordo come una linea
const CHIP_BORDER = '#3a3a3a'
const CHIP_BACKGROUNDS = {
  change: 'rgba(250, 215, 140, 0.55)',
  push: 'rgba(170, 200, 245, 0.55)',
  pull: 'rgba(170, 225, 185, 0.55)',
  fetch: 'rgba(215, 215, 232, 0.6)',
} as const
// Fetch, pull e push passano dal GitLab e possono chiedere la passphrase della chiave
const ACTION_TIMEOUT_MS = 180_000
// La chiave chiede la passphrase a ogni connessione: una connessione SSH condivisa per host, tenuta aperta 2 minuti,
// fa sì che un fetch di tutti i repo la chieda una volta per host e non una per repo
const GIT_ENV = {
  GIT_SSH_COMMAND: 'ssh -o ControlMaster=auto -o ControlPath=/tmp/gitree-ssh-%C -o ControlPersist=120',
}

// Su Windows l'ambiente resta quello di git: l'OpenSSH di sistema rifiuta ControlMaster e il fetch fallirebbe
function gitEnv(path: string): typeof GIT_ENV | undefined {
  return isWindowsPath(path) ? undefined : GIT_ENV
}

// Cambia il tag quando cambiano i campi di RepoStatus: scarta quanto salvato da una versione precedente
const snapshot = atom({ plugin: 'gitree', key: 'snapshot' } as const, { updatedAt: null, repos: [] }, {
  shape: 'snapshot-3',
})
const busy = atom({ plugin: 'gitree', key: 'busy' } as const, {} as RepoBusy, { shape: 'busy-1' })
const diff = atom({ plugin: 'gitree', key: 'diff' } as const, null as RepoDiff | null, { shape: 'diff-4' })
const wheel = atom({ plugin: 'gitree', key: 'wheel' } as const, { seq: 0, by: 0 } as CompareWheel, {
  shape: 'wheel-1',
})

let isRefreshing = false
// Il motivo per cui il Client del confronto ha fallito: il pannello torna al confronto a Box e Text fino a «Rileggi»
let compareFault: string | null = null

// Un percorso Windows: lettera di unità o percorso di rete. Lì `find` è un altro programma (cerca testo nei file)
// e l'OpenSSH di sistema non ha la connessione condivisa
function isWindowsPath(path: string): boolean {
  return /^[A-Za-z]:[\\/]/.test(path) || path.startsWith('\\\\')
}

// Oltre queste cartelle lette la ricerca su Windows si ferma: una sessione aperta su un disco intero non blocca il pannello
const WALK_MAX_DIRS = 4_000

// Su Windows i repo si cercano leggendo le cartelle con $.fs: un repo trovato non si esplora, i link non si seguono
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

// La cartella della sessione e ogni repo annidato: `.git` è una cartella, o un file per worktree e submodule
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

// La cartella più profonda che contiene tutti i repo: se stanno tutti sotto `git/`, i nomi partono da lì e la
// colonna Repo non ripete un prefisso uguale per tutti. Un repo solo, o la cartella della sessione fra i repo,
// danno la cartella sopra quella del repo più alto
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

// I nomi si calcolano con la barra; git riceve il percorso com'è, con la barra rovesciata su Windows
function slashed(path: string): string {
  return path.replace(/\\/g, '/')
}

// Il nome mostrato: il percorso rispetto alla cartella comune, o l'ultimo pezzo
function repoName(base: string, original: string): string {
  const root = slashed(base)
  const path = slashed(original)
  if (path.startsWith(`${root}/`)) return path.slice(root.length + 1)
  return path.slice(path.lastIndexOf('/') + 1) || path
}

// Legge lo stato senza fetch: ahead e behind sono rispetto al remote come era all'ultimo fetch
async function repoStatus($: EngineInterface, base: string, path: string): Promise<RepoStatus> {
  const name = repoName(base, path)
  const status: RepoStatus = {
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
    return { ...status, error: run.stderr.trim().split('\n')[0] ?? 'git status fallito' }
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
      // XY: X lo stato nell'indice, Y nella copia di lavoro; il punto vuol dire invariato
      status.changed += 1
      if (line[2] !== '.') status.staged += 1
      if (line[3] !== '.') status.unstaged += 1
    } else if (line.startsWith('u ')) {
      // Un conflitto si risolve nella copia di lavoro
      status.changed += 1
      status.unstaged += 1
    }
  }
  return status
}

async function refresh($: EngineInterface): Promise<void> {
  if (isRefreshing) {
    return
  }
  isRefreshing = true
  try {
    const root = await $.session.cwd()
    const paths = await listRepos($, root)
    const base = commonParent(paths) || root
    const repos: RepoStatus[] = []
    for (const path of paths) {
      try {
        repos.push(await repoStatus($, base, path))
      } catch (error) {
        repos.push({
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
    await update($, snapshot, () => ({ updatedAt, repos }))
  } finally {
    isRefreshing = false
  }
}

function actionArgv(repo: RepoStatus, action: RepoAction): string[] {
  const git = ['git', '-C', repo.path]
  if (action === 'fetch') return [...git, 'fetch', '--prune']
  // Solo fast-forward: un pull dal pannello non crea mai un merge
  if (action === 'pull') return [...git, 'pull', '--ff-only']
  return repo.upstream === null ? [...git, 'push', '-u', 'origin', 'HEAD'] : [...git, 'push']
}

// Parte solo dal pulsante della riga: è la persona a chiedere l'azione, il pannello non la lancia mai da sé
async function runAction($: EngineInterface, repo: RepoStatus, action: RepoAction): Promise<void> {
  const current = await read($, busy)
  if (current[repo.name] !== undefined) {
    return
  }
  await update($, busy, state => ({ ...state, [repo.name]: action }))
  $.ui.toast(`${repo.name}: ${action} in corso, può chiedere la passphrase della chiave`)
  try {
    const run = await $.process.run(actionArgv(repo, action), { timeoutMs: ACTION_TIMEOUT_MS, env: gitEnv(repo.path) })
    const detail = (run.exitCode === 0 ? run.stdout || run.stderr : run.stderr).trim().split('\n').pop() ?? ''
    $.ui.toast(
      run.exitCode === 0
        ? `${repo.name}: ${action} riuscito${detail ? ` (${detail})` : ''}`
        : `${repo.name}: ${action} fallito, ${detail || `codice ${run.exitCode}`}`,
    )
  } catch (error) {
    $.ui.toast(`${repo.name}: ${action} non eseguito, ${String(error)}`)
  } finally {
    await update($, busy, state => {
      const { [repo.name]: _done, ...rest } = state
      return rest
    })
    await refresh($)
  }
}

// I due lati di un confronto come argomenti di git diff: nessuno è l'indice contro la copia di lavoro,
// --cached HEAD contro l'indice, un solo commit quel commit contro la copia di lavoro
type DiffSides = { revs: string[]; withUntracked: boolean }

// I file cambiati fra i due lati, più i non tracciati quando il lato nuovo è la copia di lavoro
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

// Il diff unificato diventa righe affiancate: i blocchi di righe tolte e aggiunte si appaiano riga per riga
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
      rows.push({ header: `righe ${hunk[1]} → ${hunk[2]}${hunk[3] ?? ''}` })
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

// Un non tracciato si confronta con un file vuoto; --no-index esce con 1 quando i file differiscono
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

// Il diff con contesto completo è un solo blocco @@ che contiene il file intero: le righe con lo spazio
// stanno nei due lati, quelle con - e + formano i blocchi cambiati
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

// Taglia il confronto alla prima riga allineata che sfora il budget dei props: i due lati si fermano nello
// stesso punto, così la parte mostrata resta appaiata come nel file intero
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
  // Avanza riga per riga fino a `untilL`/`untilR`; false appena il budget finisce
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
  // Contesto enorme: git mette il file intero in un solo blocco, allineato col suo algoritmo di diff
  const run = await $.process.run(fileDiffArgv(path, file, sides, '-U100000000'), { timeoutMs: 15_000 })
  return fitCompare(parseFullDiff(run.stdout), file.path, file.isUntracked, labels)
}

// I due lati e i commit per ogni tipo di confronto. I commit da pushare partono dal punto in cui il branch si è
// staccato dall'upstream: i commit arrivati sul remote e non ancora pullati non entrano nel confronto
async function diffPlan(
  $: EngineInterface,
  repo: RepoStatus,
  kind: DiffKind,
): Promise<{ sides: DiffSides; labels: [string, string]; commits: DiffCommit[] }> {
  if (kind === 'staged') {
    return { sides: { revs: ['--cached'], withUntracked: false }, labels: ['HEAD', 'Indice'], commits: [] }
  }
  if (kind === 'unstaged') {
    // Senza nulla in stage l'indice coincide con HEAD: il lato sinistro si chiama come lo conosce chi legge
    const left = repo.staged > 0 ? 'Indice' : 'HEAD'
    return { sides: { revs: [], withUntracked: true }, labels: [left, 'Copia di lavoro'], commits: [] }
  }
  if (repo.upstream === null) throw new Error('il branch non ha upstream')
  const mergeBase = await $.process.run(['git', '-C', repo.path, 'merge-base', 'HEAD', repo.upstream], {
    timeoutMs: 15_000,
  })
  const base = mergeBase.stdout.trim()
  if (mergeBase.exitCode !== 0 || base.length === 0) throw new Error(`nessun antenato comune con ${repo.upstream}`)
  const log = await $.process.run(
    ['git', '-C', repo.path, 'log', '--format=%h%x09%s', `-n${COMMITS_MAX}`, `${base}..HEAD`],
    { timeoutMs: 15_000 },
  )
  const commits = log.stdout
    .split('\n')
    .filter((line: string) => line.length > 0)
    .map((line: string) => {
      const [hash = '', ...subject] = line.split('\t')
      return { hash, subject: subject.join('\t') }
    })
  return { sides: { revs: [base, 'HEAD'], withUntracked: false }, labels: [repo.upstream, 'HEAD'], commits }
}

// Il confronto si legge alla pressione e si conserva: il pannello lo ridisegna senza rilanciare git
async function showDiff($: EngineInterface, repo: RepoStatus, kind: DiffKind, selected?: string): Promise<void> {
  const path = repo.path
  const { sides, labels, commits } = await diffPlan($, repo, kind)
  const files = await changedFiles($, path, sides)
  const file = files.find(one => one.path === selected) ?? files.find(one => !one.isBinary) ?? null
  const [rows, compare] =
    file === null || file.isBinary
      ? [[], null]
      : await Promise.all([fileRows($, path, file, sides), fileCompare($, path, file, sides, labels)])
  const readAt = await $.clock.now()
  await update($, diff, () => ({
    repo: repo.name,
    branch: repo.branch,
    kind,
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
  // focus: il link porta subito sulla scheda del confronto, non la apre dietro a Repositories
  await $.ui.open({ id: DIFF_PANE, title: `Confronto ${repo.name}`, focus: true })
}

function startShowDiff($: EngineInterface, repo: RepoStatus, kind: DiffKind, selected?: string): void {
  showDiff($, repo, kind, selected).catch(error => $.ui.toast(`${repo.name}: confronto non letto, ${String(error)}`))
}

let isFetchingAll = false

// Uno dopo l'altro: il primo fetch verso un host apre la connessione condivisa, gli altri la riusano
async function fetchAll($: EngineInterface): Promise<void> {
  if (isFetchingAll) {
    return
  }
  isFetchingAll = true
  try {
    const { repos } = await read($, snapshot)
    $.ui.toast(`Fetch di ${repos.length} repository: la passphrase può servire una volta per host`)
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
        ? `Fetch riuscito su ${repos.length} repository`
        : `Fetch fallito su ${failed.length} di ${repos.length}: ${failed.join(', ')}`,
    )
  } finally {
    isFetchingAll = false
    await refresh($)
  }
}

function startFetchAll($: EngineInterface): void {
  fetchAll($).catch(error => $.ui.log(`gitree: fetch di tutti: ${String(error)}`, { to: 'debug' }))
}

function startAction($: EngineInterface, repo: RepoStatus, action: RepoAction): void {
  runAction($, repo, action).catch(error => $.ui.log(`gitree: ${action} ${repo.name}: ${String(error)}`, { to: 'debug' }))
}

// Dal timer, da un pulsante o dopo un comando: un errore finisce nel log di debug, non fa cadere chi chiama
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
    !BASE_BRANCHES.includes(repo.branch) ||
    repo.upstream === null
  )
}

// Lo stato è sempre scritto per esteso: il colore lo rinforza, non lo sostituisce
function describe(repo: RepoStatus): string {
  if (repo.error !== null) {
    return `errore: ${repo.error}`
  }
  // Unstaged, Staged e Da pushare sono i link accanto: qui resta solo ciò che non ha un confronto
  const parts: string[] = []
  if (repo.upstream === null) parts.push(repo.ahead > 0 ? `senza upstream, ${repo.ahead} commit locali` : 'senza upstream')
  if (repo.behind > 0) parts.push(`${repo.behind} da pullare`)
  if (parts.length > 0) return parts.join(', ')
  return repo.changed + repo.untracked + repo.ahead > 0 ? '' : 'pulito'
}

function color(repo: RepoStatus): 'error' | 'warning' | 'suggestion' | 'success' {
  if (repo.error !== null) return 'error'
  if (repo.changed > 0 || repo.untracked > 0) return 'warning'
  if (repo.ahead > 0 || repo.behind > 0 || repo.upstream === null) return 'suggestion'
  return 'success'
}

// «righe della copia di lavoro», «dell'indice», «di HEAD», «di origin/develop»
function ofSide(label: string): string {
  if (label === 'Copia di lavoro') return 'della copia di lavoro'
  if (label === 'Indice') return "dell'indice"
  return `di ${label}`
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
      description: 'Mostra repo, branch e stato dei repository git nella cartella della sessione',
    })
    void $.ui.open({ id: PANE, title: TITLE })
    refreshInBackground($)
    $.clock.every(EVERY_MS, () => refreshInBackground($))

    return next(e)
  })

  on('command.run', { command: 'gitree' }, async $ => {
    await $.ui.open({ id: PANE, title: TITLE })
    await refresh($)

    return { text: 'Pannello Repositories aperto e aggiornato.' }
  })

  // Dopo un comando git in sessione lo stato cambia: non aspettare il prossimo giro del timer
  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    const ran = await next(e)
    if (typeof e.command === 'string' && /\bgit\b/.test(e.command)) {
      refreshInBackground($)
    }

    return ran
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    const { updatedAt, repos } = await read($, snapshot)
    const running = await read($, busy)
    // In lavorazione prima, poi i puliti: tutti hanno almeno il fetch
    const rows = [...repos.filter(isInProgress), ...repos.filter(repo => !isInProgress(repo))]
    // Il terminale non sempre disegna i colori con trasparenza: lì niente sfondi
    const hasBackgrounds = e.surface !== 'terminal'
    // Compatto in altezza: niente bordi per cella né margini verticali, un solo bordo attorno alla tabella
    const cell = { paddingX: 1 } as const
    // Sul desktop un Button semplice dentro un Box con il bordo; sul terminale il pulsante del terminale, «[ etichetta ]»,
    // perché lì il bordo aggiungerebbe due righe a ogni riga della tabella
    const chip = (key: string, label: string, tint: keyof typeof CHIP_BACKGROUNDS, onPress: () => void) =>
      hasBackgrounds ? (
        <Box
          key={`${key}:chip`}
          borderStyle="single"
          borderColor={CHIP_BORDER}
          backgroundColor={CHIP_BACKGROUNDS[tint]}
          paddingX="xs"
          height={1}
          alignItems="center"
          flexShrink={0}
        >
          <Button key={key} plain onPress={onPress} hover={{ underline: true }}>
            <Text size="caption">{label}</Text>
          </Button>
        </Box>
      ) : (
        <Button key={key} onPress={onPress}>
          <Text size="caption">{label}</Text>
        </Button>
      )

    return (
      <Box flexDirection="column">
        {updatedAt === null && <Text dimColor size="footnote">Lettura dei repository in corso…</Text>}
        <Box flexDirection="column" borderStyle="single" borderDimColor>
        {rows.length > 0 && (
          <Box flexDirection="row" key="header" backgroundColor={hasBackgrounds ? HEADER_BACKGROUND : undefined}>
            <Box {...cell} width={COLUMNS.repo}>
              <Text weight="semibold" size="footnote">Repo</Text>
            </Box>
            <Box {...cell} width={COLUMNS.branch}>
              <Text weight="semibold" size="footnote">Branch</Text>
            </Box>
            <Box {...cell} flexGrow={1}>
              <Text weight="semibold" size="footnote">Stato</Text>
            </Box>
            <Box {...cell} width={COLUMNS.actions}>
              <Text weight="semibold" size="footnote">Azioni</Text>
            </Box>
          </Box>
        )}
        {rows.map((repo, index) => {
          const isClean = !isInProgress(repo)
          const action = running[repo.name]
          return (
            <Box
              flexDirection="row"
              key={repo.name}
              backgroundColor={hasBackgrounds && index % 2 === 1 ? STRIPE_BACKGROUND : undefined}
            >
              <Box {...cell} width={COLUMNS.repo}>
                <Text dimColor={isClean} size="footnote">{repo.name}</Text>
              </Box>
              <Box {...cell} width={COLUMNS.branch}>
                <Text mono dimColor={isClean} size="footnote">
                  {repo.branch}
                </Text>
              </Box>
              <Box {...cell} flexGrow={1} flexDirection="row" columnGap={1} alignItems="center">
                {/* Come nella vista Git Staging di EGit: i non tracciati stanno fra gli unstaged */}
                {repo.unstaged + repo.untracked > 0 &&
                  chip(`${repo.name}:diff`, `Unstaged ${repo.unstaged + repo.untracked}`, 'change', () =>
                    startShowDiff($, repo, 'unstaged'),
                  )}
                {repo.staged > 0 &&
                  chip(`${repo.name}:diff-staged`, `Staged ${repo.staged}`, 'change', () =>
                    startShowDiff($, repo, 'staged'),
                  )}
                {repo.ahead > 0 &&
                  repo.upstream !== null &&
                  chip(`${repo.name}:diff-push`, `Da pushare ${repo.ahead}`, 'push', () =>
                    startShowDiff($, repo, 'push'),
                  )}
                {describe(repo).length > 0 && (
                  <Text color={isClean ? undefined : color(repo)} dimColor={isClean} size="footnote">
                    {describe(repo)}
                  </Text>
                )}
              </Box>
              <Box {...cell} width={COLUMNS.actions} flexDirection="row" columnGap={1} alignItems="center">
                {action !== undefined && <Text dimColor size="footnote">{action} in corso…</Text>}
                {action === undefined &&
                  chip(`${repo.name}:fetch`, 'Fetch', 'fetch', () => startAction($, repo, 'fetch'))}
                {action === undefined &&
                  repo.behind > 0 &&
                  chip(`${repo.name}:pull`, 'Pull', 'pull', () => startAction($, repo, 'pull'))}
                {action === undefined && (repo.ahead > 0 || repo.upstream === null) && repo.error === null && (
                  <Button
                    key={`${repo.name}:push`}
                    variant="primary"
                    onPress={() => startAction($, repo, 'push')}
                  >
                    <Text size="caption">Push</Text>
                  </Button>
                )}
              </Box>
            </Box>
          )
        })}
        </Box>
        <Box flexDirection="row" columnGap={1}>
          <Button key="refresh" onPress={() => startFetchAll($)}>
            <Text size="caption">Aggiorna (fetch di tutti)</Text>
          </Button>
          {updatedAt !== null && (
            <Text dimColor size="caption">
              letto alle {clockTime(updatedAt)}; push e pull rispetto all'ultimo fetch
            </Text>
          )}
        </Box>
      </Box>
    )
  })

  on('ui.render', { component: 'Pane', requestId: DIFF_PANE }, async ($, e) => {
    const table = $.ui.resolve(e)
    const { Box, Text, Button } = table
    const shown = await read($, diff)
    if (shown === null) {
      return <Text dimColor>Scegli Unstaged, Staged o Da pushare nel pannello Repositories.</Text>
    }
    const { repos } = await read($, snapshot)
    const repo = repos.find(one => one.name === shown.repo)
    const selected = shown.files.find(file => file.path === shown.selected)
    // Il confronto grafico solo sul desktop; terminale, vscode e mobile, o un Client guasto, usano le righe a Box e Text
    const Client = e.surface === 'desktop' && 'Client' in table ? table.Client : undefined
    const compare = Client !== undefined && compareFault === null ? shown.compare : null
    const scrolled = await read($, wheel)
    // Il confronto prende l'altezza che resta nel pannello: titolo, elenco dei file col bordo, avvisi, pulsanti
    const roomRows = e.props.scroll.bodyRows
    const commitRows = shown.commits.length > 0 ? shown.commits.length + 3 : 0
    const otherRows = 1 + commitRows + Math.max(1, shown.files.length) + 2 + 2 + 1
    const compareRows =
      roomRows > 0
        ? Math.min(COMPARE_MAX_ROWS, Math.max(COMPARE_MIN_ROWS, roomRows - otherRows))
        : COMPARE_DEFAULT_ROWS
    // Come nel confronto di EGit: a sinistra il lato vecchio, a destra il nuovo, le righe cambiate evidenziate
    const half = { width: '50%', flexDirection: 'row', columnGap: 1, paddingX: 1 } as const
    // Il terminale non sempre disegna la trasparenza: lì le chiavi di tema dei diff e nessuna tinta d'intestazione
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
            letto alle {clockTime(shown.readAt)}
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
            {repo !== undefined && repo.ahead > shown.commits.length && (
              <Text dimColor size="caption">
                … altri {repo.ahead - shown.commits.length} commit
              </Text>
            )}
          </Box>
        )}
        <Box flexDirection="column" borderStyle="single" borderDimColor>
          {shown.files.length === 0 && (
            <Text dimColor size="caption">
              Nessuna differenza fra {shown.leftLabel} e {shown.rightLabel}.
            </Text>
          )}
          {shown.files.map(file => (
            <Box flexDirection="row" columnGap={1} key={`f:${file.path}`}>
              <Button
                key={`file:${file.path}`}
                plain
                onPress={() => repo !== undefined && startShowDiff($, repo, shown.kind, file.path)}
              >
                <Text mono size="footnote" weight={file.path === shown.selected ? 'bold' : undefined}>
                  {file.path === shown.selected ? '▸ ' : '  '}
                  {file.path}
                </Text>
              </Button>
              <Text size="caption" color="success">
                {file.isUntracked ? 'nuovo' : file.isBinary ? 'binario' : `+${file.added}`}
              </Text>
              {!file.isUntracked && !file.isBinary && (
                <Text size="caption" color="error">
                  −{file.removed}
                </Text>
              )}
            </Box>
          ))}
        </Box>
        {selected?.isBinary === true && <Text dimColor>File binario: nessun confronto riga per riga.</Text>}
        {Client !== undefined && compareFault !== null && (
          <Text dimColor size="caption">
            Confronto grafico non disponibile ({compareFault}): mostrate le righe cambiate con il contesto.
          </Text>
        )}
        {compare !== null && compare.isTruncated && (
          <Text color="warning" size="caption">
            Confronto tagliato: mostrate {compare.left.length} di {compare.leftTotal} righe {ofSide(compare.leftLabel)} e{' '}
            {compare.right.length} di {compare.rightTotal} {ofSide(compare.rightLabel)}, il limite del pannello è di
            100.000 caratteri.
          </Text>
        )}
        {compare !== null && compare.longLines > 0 && (
          <Text dimColor size="caption">
            {compare.longLines} righe più lunghe di {COMPARE_LINE_MAX} caratteri sono accorciate.
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
            … altre {shown.hiddenRows} righe non mostrate
          </Text>
        )}
        <Box flexDirection="row" columnGap={1}>
          {repo !== undefined && (
            <Button
              key="diff:reload"
              onPress={() => {
                // Rileggi ritenta anche il confronto grafico dopo un guasto del Client
                compareFault = null
                startShowDiff($, repo, shown.kind, shown.selected ?? undefined)
              }}
            >
              <Text size="caption">Rileggi</Text>
            </Button>
          )}
          <Button key="diff:close" role="dismiss" onPress={() => void $.ui.close({ id: DIFF_PANE })}>
            <Text size="caption">Chiudi</Text>
          </Button>
        </Box>
      </Box>
    )
  })

  // La rotella sul pannello dei diff scorre il confronto grafico, quando il pannello sta tutto nel suo spazio
  // e non ha niente da scorrere per conto suo; altrimenti scorre il pannello come sempre
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
    // Un errore qui non deve bloccare lo scorrimento del pannello
    const isTaken = await takeWheel().catch(error => {
      $.ui.log(`gitree: rotella sul confronto: ${String(error)}`, { to: 'debug' })
      return false
    })

    return isTaken ? {} : next(e)
  })

  // Il Client del confronto ha fallito: il motore ridisegna il pannello, che torna alle righe a Box e Text
  on('ui.fault', async ($, e, next) => {
    if (e.requestId === DIFF_PANE) {
      compareFault = e.reason
      $.ui.log(`gitree: confronto grafico (${e.phase}): ${e.reason}`, { to: 'debug' })
    }

    return next(e)
  })
}
