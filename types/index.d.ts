export type RepoStatus = {
  /** Il percorso rispetto alla cartella della sessione; `path` è quello assoluto. */
  name: string
  path: string
  branch: string
  upstream: string | null
  ahead: number
  behind: number
  changed: number
  /** File con modifiche nell'indice e file con modifiche non ancora in stage: uno stesso file può contare in entrambi. */
  staged: number
  unstaged: number
  untracked: number
  error: string | null
}

export type RepoSnapshot = { updatedAt: number | null; repos: RepoStatus[] }

export type RepoAction = 'fetch' | 'pull' | 'push'

/** Le azioni git in corso, per nome del repo: la riga mostra «in corso» al posto dei pulsanti. */
export type RepoBusy = Record<string, RepoAction>

/**
 * Cosa confronta il pannello dei diff: `unstaged` l'indice con la copia di lavoro (non tracciati compresi),
 * `staged` HEAD con l'indice, `push` il punto di partenza dall'upstream con HEAD.
 */
export type DiffKind = 'unstaged' | 'staged' | 'push'

/** Un commit da pushare: hash abbreviato e oggetto. */
export type DiffCommit = { hash: string; subject: string }

/** Un file cambiato fra i due lati del confronto; un non tracciato ha tutte le righe aggiunte. */
export type DiffFile = { path: string; added: number; removed: number; isUntracked: boolean; isBinary: boolean }

/** Una riga di un lato del confronto: numero di riga nel file e testo; `isChanged` la evidenzia. */
export type DiffSide = { number: number; text: string; isChanged: boolean }

/** Una riga del confronto affiancato: un'intestazione di blocco, oppure i due lati (uno può mancare). */
export type DiffRow = { header: string } | { left: DiffSide | null; right: DiffSide | null }

/**
 * Un blocco cambiato del file intero, come lo appaia git: `[inizio a sinistra, righe a sinistra,
 * inizio a destra, righe a destra]`, con gli inizi contati da 0.
 */
export type CompareBlock = [number, number, number, number]

/**
 * Il file intero per il confronto grafico (`hooks/compare.tsx`): le righe di HEAD e della copia di
 * lavoro, i blocchi cambiati, e quanto è stato tagliato per stare nel limite dei `props` di `Client`.
 */
export type ComparePayload = {
  path: string
  /** Righe di HEAD, tabulazioni espanse; vuoto per un file non tracciato. */
  left: string[]
  /** Righe della copia di lavoro; vuoto per un file cancellato. */
  right: string[]
  blocks: CompareBlock[]
  /** Righe dei due file interi: maggiori di `left.length` e `right.length` se il confronto è tagliato. */
  leftTotal: number
  rightTotal: number
  isTruncated: boolean
  /** Righe accorciate perché più lunghe del massimo per riga. */
  longLines: number
  isUntracked: boolean
  /** I nomi dei due lati, ad esempio «HEAD» e «Copia di lavoro». */
  leftLabel: string
  rightLabel: string
}

/** L'ultimo giro di rotella sul pannello dei diff, passato al confronto grafico: `seq` lo distingue dal precedente. */
export type CompareWheel = { seq: number; by: number }

/** I `props` del modulo di superficie `hooks/compare.tsx`. */
/** `viewRows`: le righe che il pannello assegna al confronto, anche quando la regione ne riporta meno. */
export type CompareProps = ComparePayload & { readAt: number; wheel: CompareWheel; viewRows: number }

/** Il confronto mostrato nel pannello dei diff: il lato vecchio a sinistra, il nuovo a destra, come EGit. */
export type RepoDiff = {
  repo: string
  branch: string
  kind: DiffKind
  leftLabel: string
  rightLabel: string
  /** I commit da pushare, solo per `push`. */
  commits: DiffCommit[]
  readAt: number
  files: DiffFile[]
  selected: string | null
  rows: DiffRow[]
  hiddenRows: number
  /** Il file intero per il confronto grafico su desktop; null per un file binario o senza file scelto. */
  compare: ComparePayload | null
}

declare module 'claude-code' {
  interface PluginState {
    'gitree': {
      snapshot: Shaped<RepoSnapshot>
      busy: Shaped<RepoBusy>
      diff: Shaped<RepoDiff | null>
      wheel: Shaped<CompareWheel>
    }
  }
}
