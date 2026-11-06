// Confronto grafico in stile Compare Editor di EGit, disegnato da un `Client` sul desktop:
// il lato vecchio a sinistra, il nuovo a destra, una sola finestra di righe per i due lati (lo
// scorrimento è sincronizzato per costruzione), connettori al centro e righello a destra.
import type { ClientModule } from 'claude-code'

import type { CompareProps } from '../types'

type Kind = 'same' | 'mod' | 'del' | 'add'

/** Una riga allineata: indice nel file di sinistra e di destra (null = riga di riempimento). */
type Row = { l: number | null; r: number | null; kind: Kind; block: number }

type Segment = { text: string; isChanged: boolean }

/** Lo stato locale dell'istanza: `key` cambia col file o con una rilettura e riporta la vista al primo blocco. */
type View = { key: string; offset: number; col: number; wheelSeq: number; drag: Drag | null }

/** Un cursore afferrato: quale barra, e a quante celle dal suo inizio lo si tiene. */
type Drag = { bar: 'vertical' | 'horizontal'; grab: number }

// A destra del confronto: la colonna dei segni dei blocchi, poi la barra verticale
const MARKS_WIDTH = 3
const BAR_WIDTH = 2
const RULER = MARKS_WIDTH + BAR_WIDTH
// Il cursore della barra verticale non scende sotto queste righe, per restare da afferrare
const VERTICAL_THUMB_MIN = 2
const CENTER = 3
const WHEEL_ROWS = 3
const SHIFT_COLUMNS = 8
// Il minimo di righe che il pannello assegna al confronto (COMPARE_MIN_ROWS in register.tsx)
const MIN_TRUSTED_ROWS = 12
// Oltre questo prodotto di parole la riga appaiata si evidenzia tutta: il confronto parola per parola costa troppo
const WORD_DIFF_MAX = 40_000
// Sfondi pastello semitrasparenti, come nel pannello Repositories: reggono il tema chiaro e quello scuro
const HEADER_BACKGROUND = 'rgba(160, 180, 230, 0.16)'
const REMOVED_BACKGROUND = 'rgba(240, 160, 160, 0.22)'
const ADDED_BACKGROUND = 'rgba(140, 210, 160, 0.22)'
// Le parole cambiate dentro una riga appaiata: lo stesso tono, un po' più intenso
const REMOVED_WORD_BACKGROUND = 'rgba(240, 140, 140, 0.45)'
const ADDED_WORD_BACKGROUND = 'rgba(120, 200, 140, 0.45)'
const FILLER_BACKGROUND = 'rgba(160, 180, 230, 0.06)'
const CONNECTOR_BACKGROUND = 'rgba(160, 180, 230, 0.12)'
// Le barre di scorrimento: traccia tenue, cursore pieno più intenso. Anche senza colore: in verticale il cursore
// porta il segno di presa ≡ e la traccia è vuota, in tutte e due le barre
const TRACK_BACKGROUND = 'rgba(160, 180, 230, 0.10)'
const THUMB_BACKGROUND = 'rgba(160, 180, 230, 0.35)'
// Ogni colore ha il suo segno: tolte, aggiunte e cambiate si distinguono anche senza colori
const MARK: Record<Kind, string> = { same: ' ', mod: '≠', del: '−', add: '+' }
const MARK_COLOR = { same: undefined, mod: 'warning', del: 'error', add: 'success' } as const

function alignRows(props: CompareProps): { rows: Row[]; blockStarts: number[] } {
  const rows: Row[] = []
  const blockStarts: number[] = []
  let l = 0
  let r = 0
  const same = (untilL: number, untilR: number) => {
    while (l < untilL || r < untilR) {
      rows.push({ l: l < untilL ? l : null, r: r < untilR ? r : null, kind: 'same', block: -1 })
      if (l < untilL) l += 1
      if (r < untilR) r += 1
    }
  }
  props.blocks.forEach(([ls, lc, rs, rc], block) => {
    same(ls, rs)
    blockStarts.push(rows.length)
    for (let i = 0; i < Math.max(lc, rc); i += 1) {
      const hasLeft = i < lc
      const hasRight = i < rc
      rows.push({
        l: hasLeft ? ls + i : null,
        r: hasRight ? rs + i : null,
        kind: hasLeft && hasRight ? 'mod' : hasLeft ? 'del' : 'add',
        block,
      })
    }
    l = ls + lc
    r = rs + rc
  })
  same(props.left.length, props.right.length)
  return { rows, blockStarts }
}

function tokens(text: string): string[] {
  return text.match(/[\p{L}\p{N}_]+|\s+|[^\p{L}\p{N}_\s]/gu) ?? []
}

// Le parole cambiate fra due righe appaiate: prefisso e suffisso comuni tolti, LCS sul resto
function wordDiff(before: string, after: string): [Segment[], Segment[]] {
  const a = tokens(before)
  const b = tokens(after)
  let prefix = 0
  while (prefix < a.length && prefix < b.length && a[prefix] === b[prefix]) prefix += 1
  let suffix = 0
  while (
    suffix < a.length - prefix &&
    suffix < b.length - prefix &&
    a[a.length - 1 - suffix] === b[b.length - 1 - suffix]
  ) {
    suffix += 1
  }
  const midA = a.slice(prefix, a.length - suffix)
  const midB = b.slice(prefix, b.length - suffix)
  const keptA = midA.map(() => false)
  const keptB = midB.map(() => false)
  if (midA.length * midB.length <= WORD_DIFF_MAX) {
    const width = midB.length + 1
    const table = new Array<number>((midA.length + 1) * width).fill(0)
    for (let i = midA.length - 1; i >= 0; i -= 1) {
      for (let j = midB.length - 1; j >= 0; j -= 1) {
        table[i * width + j] =
          midA[i] === midB[j]
            ? (table[(i + 1) * width + j + 1] ?? 0) + 1
            : Math.max(table[(i + 1) * width + j] ?? 0, table[i * width + j + 1] ?? 0)
      }
    }
    let i = 0
    let j = 0
    while (i < midA.length && j < midB.length) {
      if (midA[i] === midB[j]) {
        keptA[i] = true
        keptB[j] = true
        i += 1
        j += 1
      } else if ((table[(i + 1) * width + j] ?? 0) >= (table[i * width + j + 1] ?? 0)) {
        i += 1
      } else {
        j += 1
      }
    }
  }
  const segments = (all: string[], kept: boolean[]): Segment[] => {
    const out: Segment[] = []
    all.forEach((token, index) => {
      const middle = index - prefix
      const isChanged = middle >= 0 && middle < kept.length && !kept[middle] && token.trim().length > 0
      const last = out[out.length - 1]
      if (last !== undefined && last.isChanged === isChanged) last.text += token
      else out.push({ text: token, isChanged })
    })
    return out
  }
  return [segments(a, keptA), segments(b, keptB)]
}

// La parte di riga visibile con lo scorrimento orizzontale, segmenti compresi
function clip(segments: Segment[], from: number, width: number): Segment[] {
  const out: Segment[] = []
  let position = 0
  for (const segment of segments) {
    const start = position
    const end = position + segment.text.length
    const visibleStart = Math.max(start, from)
    const visibleEnd = Math.min(end, from + width)
    if (visibleStart < visibleEnd) {
      out.push({ text: segment.text.slice(visibleStart - start, visibleEnd - start), isChanged: segment.isChanged })
    }
    position = end
  }
  return out
}

function clamp(value: number, low: number, high: number): number {
  return Math.min(Math.max(value, low), high)
}

// Il cursore di una barra lunga `track` celle: tanto lungo quanto la parte in vista (`shown` di `total`),
// all'inizio quando la vista è in cima, alla fine quando è in fondo
function thumb(track: number, shown: number, total: number, position: number, maxPosition: number, minSize = 1) {
  const size = total <= shown ? track : clamp(Math.round((track * shown) / total), Math.min(minSize, track), track)
  const start = maxPosition === 0 ? 0 : Math.round((position / maxPosition) * (track - size))
  return { start, size }
}

// La posizione della vista che mette l'inizio del cursore nella cella `start` della traccia
function positionFor(start: number, track: number, size: number, maxPosition: number): number {
  return track === size ? 0 : Math.round((clamp(start, 0, track - size) / (track - size)) * maxPosition)
}

const Compare: ClientModule<CompareProps, View> = (props, surface) => {
  const { Box, Text } = surface.elements
  const { rows, blockStarts } = alignRows(props)
  const columns = surface.columns > 0 ? surface.columns : 120
  const numberWidth = String(Math.max(props.leftTotal, props.rightTotal, 1)).length + 1
  const sideWidth = Math.max(10, Math.floor((columns - RULER - CENTER) / 2))
  const textWidth = Math.max(1, sideWidth - numberWidth - 1)
  // La barra orizzontale c'è solo se almeno una riga è più larga della sua colonna
  const longest = Math.max(0, ...props.left.map(line => line.length), ...props.right.map(line => line.length))
  const maxCol = Math.max(0, longest - textWidth)
  const hasHorizontalBar = maxCol > 0
  // Sul desktop la regione può riportare l'altezza di quanto ha già disegnato, non quella assegnata, e il confronto
  // si restringe a ogni disegno fino a tre righe. Il pannello non assegna mai meno di MIN_TRUSTED_ROWS: sotto,
  // vale l'altezza assegnata (`viewRows`)
  const totalRows = surface.rows >= MIN_TRUSTED_ROWS ? surface.rows : props.viewRows > 0 ? props.viewRows : 30
  // Intestazione, riga di stato e, se serve, barra orizzontale
  const bodyRows = Math.max(3, totalRows - 2 - (hasHorizontalBar ? 1 : 0))
  const maxOffset = Math.max(0, rows.length - bodyRows)
  const trackWidth = sideWidth * 2 + CENTER
  const key = `${props.path}@${props.readAt}`

  let view = surface.state
  if (view === undefined || view.key !== key) {
    // Non limitata qui: la regione può ancora cambiare altezza, il limite si applica al disegno
    const first = blockStarts[0] ?? 0
    view = { key, offset: Math.max(0, first - 3), col: 0, wheelSeq: props.wheel.seq, drag: null }
    surface.setState(view)
  } else if (view.wheelSeq !== props.wheel.seq) {
    view = { ...view, wheelSeq: props.wheel.seq, offset: clamp(view.offset + props.wheel.by * WHEEL_ROWS, 0, maxOffset) }
    surface.setState(view)
  }

  // Più gesti prima del ridisegno si sommano: ognuno parte dall'ultimo stato chiesto
  let latest = view
  const change = (next: Partial<View>) => {
    latest = { ...latest, ...next }
    latest.offset = clamp(latest.offset, 0, maxOffset)
    latest.col = clamp(latest.col, 0, maxCol)
    surface.setState(latest)
  }
  const nextBlock = (direction: 1 | -1) => {
    const anchor = latest.offset + 3
    const target =
      direction === 1
        ? blockStarts.find(start => start > anchor)
        : [...blockStarts].reverse().find(start => start < anchor)
    if (target !== undefined) change({ offset: target - 3 })
  }

  // I cursori delle due barre: lunghi quanto la parte in vista, nella posizione della vista
  const verticalThumb = thumb(bodyRows, bodyRows, rows.length, clamp(latest.offset, 0, maxOffset), maxOffset, VERTICAL_THUMB_MIN)
  const horizontalThumb = thumb(trackWidth, textWidth, longest, clamp(latest.col, 0, maxCol), maxCol)
  // Porta l'inizio del cursore in `start`, misurato in celle della traccia
  const moveVertical = (start: number) => change({ offset: positionFor(start, bodyRows, verticalThumb.size, maxOffset) })
  const moveHorizontal = (start: number) => change({ col: positionFor(start, trackWidth, horizontalThumb.size, maxCol) })

  surface.onKey(event => {
    const page = Math.max(1, bodyRows - 1)
    if (event.key === 'up' || event.key === 'k') change({ offset: latest.offset - 1 })
    else if (event.key === 'down' || event.key === 'j') change({ offset: latest.offset + 1 })
    else if (event.key === 'pageup') change({ offset: latest.offset - page })
    else if (event.key === 'pagedown' || event.key === ' ') change({ offset: latest.offset + page })
    else if (event.key === 'home') change({ offset: 0 })
    else if (event.key === 'end') change({ offset: maxOffset })
    else if (event.key === 'left') change({ col: latest.col - SHIFT_COLUMNS })
    else if (event.key === 'right') change({ col: latest.col + SHIFT_COLUMNS })
    else if (event.key === 'n') nextBlock(1)
    else if (event.key === 'p') nextBlock(-1)
  })

  // Un clic sul cursore lo afferra dove lo si prende; un clic sulla traccia vi centra il cursore e lo afferra
  // al centro. Il trascinamento sposta il cursore, e con lui la vista, finché il pulsante non si rilascia
  const horizontalRow = 1 + bodyRows
  surface.onPointer(event => {
    const drag = latest.drag ?? null
    if (event.type === 'down' && event.button === 'left') {
      if (event.x >= columns - BAR_WIDTH && event.y >= 1 && event.y <= bodyRows && maxOffset > 0) {
        const y = event.y - 1
        const isOnThumb = y >= verticalThumb.start && y < verticalThumb.start + verticalThumb.size
        const grab = isOnThumb ? y - verticalThumb.start : Math.floor(verticalThumb.size / 2)
        latest = { ...latest, drag: { bar: 'vertical', grab } }
        moveVertical(y - grab)
      } else if (hasHorizontalBar && event.y === horizontalRow && event.x < trackWidth) {
        const isOnThumb = event.x >= horizontalThumb.start && event.x < horizontalThumb.start + horizontalThumb.size
        const grab = isOnThumb ? event.x - horizontalThumb.start : Math.floor(horizontalThumb.size / 2)
        latest = { ...latest, drag: { bar: 'horizontal', grab } }
        moveHorizontal(event.x - grab)
      }
    } else if (event.type === 'move' && drag !== null) {
      if (drag.bar === 'vertical') moveVertical(event.y - 1 - drag.grab)
      else moveHorizontal(event.x - drag.grab)
    } else if (event.type === 'up' && drag !== null) {
      change({ drag: null })
    }
  })

  const offset = clamp(view.offset, 0, maxOffset)
  const col = clamp(view.col, 0, maxCol)
  const visible = rows.slice(offset, offset + bodyRows)
  const shownVertical = thumb(bodyRows, bodyRows, rows.length, offset, maxOffset, VERTICAL_THUMB_MIN)
  const shownHorizontal = thumb(trackWidth, textWidth, longest, col, maxCol)

  const side = (row: Row, which: 'left' | 'right') => {
    const index = which === 'left' ? row.l : row.r
    const lines = which === 'left' ? props.left : props.right
    const isChanged = row.kind !== 'same'
    const background =
      index === null
        ? isChanged
          ? FILLER_BACKGROUND
          : undefined
        : isChanged
          ? which === 'left'
            ? REMOVED_BACKGROUND
            : ADDED_BACKGROUND
          : undefined
    let segments: Segment[] = [{ text: index === null ? '' : (lines[index] ?? ''), isChanged: false }]
    if (row.kind === 'mod' && row.l !== null && row.r !== null) {
      segments = wordDiff(props.left[row.l] ?? '', props.right[row.r] ?? '')[which === 'left' ? 0 : 1]
    }
    const shown = clip(segments, col, textWidth)
    const word = which === 'left' ? REMOVED_WORD_BACKGROUND : ADDED_WORD_BACKGROUND
    return (
      <Box width={sideWidth} height={1} flexDirection="row" flexShrink={0} overflow="hidden" backgroundColor={background}>
        <Box width={numberWidth} flexShrink={0} justifyContent="flex-end">
          <Text mono dimColor wrap="truncate">
            {index === null ? ' ' : String(index + 1)}
          </Text>
        </Box>
        <Box width={textWidth} marginLeft={1} flexShrink={0} overflow="hidden">
          <Text mono wrap="truncate">
            {shown.length === 0
              ? ' '
              : shown.map(segment =>
                  segment.isChanged ? (
                    <Text mono backgroundColor={word}>
                      {segment.text}
                    </Text>
                  ) : (
                    segment.text
                  ),
                )}
          </Text>
        </Box>
      </Box>
    )
  }

  // Il connettore centrale: lega i due lati di un blocco, con il segno del cambiamento
  const connector = (row: Row, rowIndex: number) => {
    const isBlockStart = row.kind !== 'same' && blockStarts[row.block] === rowIndex
    return (
      <Box width={CENTER} height={1} flexShrink={0} backgroundColor={row.kind === 'same' ? undefined : CONNECTOR_BACKGROUND}>
        <Text mono color={MARK_COLOR[row.kind]} wrap="truncate">
          {isBlockStart ? `─${MARK[row.kind]}─` : ` ${MARK[row.kind]} `}
        </Text>
      </Box>
    )
  }

  // A destra di ogni riga il segno dei blocchi in quella fetta del file
  const marks = (y: number) => {
    // Un file più corto della finestra si riassume riga per riga, allineato alle righe accanto
    const isShort = rows.length <= bodyRows
    const from = isShort ? y : Math.floor((y * rows.length) / bodyRows)
    const to = isShort ? y + 1 : Math.max(from + 1, Math.floor(((y + 1) * rows.length) / bodyRows))
    let kind: Kind = 'same'
    let hasDel = false
    let hasAdd = false
    for (let i = from; i < Math.min(to, rows.length); i += 1) {
      const current = rows[i]?.kind
      if (current === 'del') hasDel = true
      else if (current === 'add') hasAdd = true
      else if (current === 'mod') hasDel = hasAdd = true
    }
    if (hasDel && hasAdd) kind = 'mod'
    else if (hasDel) kind = 'del'
    else if (hasAdd) kind = 'add'
    return (
      <Box width={MARKS_WIDTH} height={1} flexShrink={0}>
        <Text mono color={MARK_COLOR[kind]} wrap="truncate">
          {from >= rows.length ? '   ' : ` ${MARK[kind]} `}
        </Text>
      </Box>
    )
  }

  // Il cursore di una barra: un blocco pieno con il segno di presa ≡ al centro, che lo distingue dalla traccia
  // vuota anche senza colore
  const grip = (key: string, width: number, height: number) => (
    <Box
      key={key}
      width={width}
      height={height}
      flexShrink={0}
      backgroundColor={THUMB_BACKGROUND}
      alignItems="center"
      justifyContent="center"
    >
      <Text mono dimColor>
        ≡
      </Text>
    </Box>
  )

  const leftTitle = props.leftTotal === 0 ? `${props.leftLabel} (file non presente)` : props.leftLabel
  const rightTitle = props.rightTotal === 0 ? `${props.rightLabel} (file cancellato)` : props.rightLabel
  const currentBlock = blockStarts.filter(start => start <= offset + 3).length
  const position =
    rows.length === 0
      ? 'nessuna riga da confrontare'
      : `righe ${offset + 1}–${Math.min(offset + bodyRows, rows.length)} di ${rows.length}` +
        ` · blocco ${Math.max(1, currentBlock)} di ${blockStarts.length}` +
        (col > 0 ? ` · colonne ${col + 1}–${col + textWidth} di ${longest}` : '')

  return (
    <Box flexDirection="column" width={columns}>
      <Box flexDirection="row" height={1} backgroundColor={HEADER_BACKGROUND}>
        <Box width={sideWidth} flexShrink={0} paddingX={1}>
          <Text weight="semibold" size="footnote" wrap="truncate">
            {leftTitle}
          </Text>
        </Box>
        <Box width={CENTER} flexShrink={0} />
        <Box width={sideWidth} flexShrink={0} paddingX={1}>
          <Text weight="semibold" size="footnote" wrap="truncate">
            {rightTitle}
          </Text>
        </Box>
      </Box>
      <Box flexDirection="row" height={bodyRows}>
        <Box flexDirection="column" width={columns - BAR_WIDTH} flexShrink={0}>
          {Array.from({ length: bodyRows }, (_, y) => {
            const row = visible[y]
            return (
              <Box flexDirection="row" height={1}>
                {row === undefined ? <Box width={trackWidth} flexShrink={0} /> : side(row, 'left')}
                {row === undefined ? null : connector(row, offset + y)}
                {row === undefined ? null : side(row, 'right')}
                {marks(y)}
              </Box>
            )
          })}
        </Box>
        {/* La barra verticale, a destra dei due lati: una sola traccia alta quanto la finestra, divisa in spazio
            sopra, cursore e spazio sotto. Niente posizione assoluta: il desktop la ancora altrove */}
        <Box
          key="compare:track"
          flexDirection="column"
          width={BAR_WIDTH}
          height={bodyRows}
          flexShrink={0}
          backgroundColor={TRACK_BACKGROUND}
        >
          <Box width={BAR_WIDTH} height={shownVertical.start} flexShrink={0} />
          {grip('compare:thumb', BAR_WIDTH, shownVertical.size)}
          <Box width={BAR_WIDTH} flexGrow={1} />
        </Box>
      </Box>
      {hasHorizontalBar && (
        // La barra orizzontale, con la stessa grafica: traccia alta una riga, spazio a sinistra, cursore, spazio a destra
        <Box flexDirection="row" height={1}>
          <Box key="compare:hbar" flexDirection="row" width={trackWidth} height={1} flexShrink={0} backgroundColor={TRACK_BACKGROUND}>
            <Box width={shownHorizontal.start} height={1} flexShrink={0} />
            {grip('compare:hthumb', shownHorizontal.size, 1)}
            <Box height={1} flexGrow={1} />
          </Box>
        </Box>
      )}
      <Box flexDirection="row" height={1}>
        <Text dimColor size="caption" wrap="truncate">
          {position}
        </Text>
      </Box>
    </Box>
  )
}

export default Compare
