// The commit graph of the History pane, laid out as the EGit History view draws it: one lane per line of
// descent, a dot on the commit's lane, straight segments from the row's top edge to the dot and from the dot
// to the bottom edge. Lanes keep their place and their color while they live; a freed lane is reused.
import type { GraphEdge, GraphRow } from '../types'

/** A commit as the graph needs it: the full hash and the parents, first parent first. */
export type GraphCommit = { hash: string; parents: string[] }

/** The lane colors, in the order EGit hands them out: dark enough for a light background, readable on a dark one. */
export const LANE_COLORS = ['#2a5db0', '#c0392b', '#2e8b3e', '#b8860b', '#8e44ad', '#138d90', '#d35400', '#6d6875'] as const

/** Pixels of one lane and of one row of the graph. */
export const LANE_WIDTH = 14
export const ROW_HEIGHT = 22

function freeLane(lanes: (string | null)[]): number {
  const free = lanes.indexOf(null)
  return free === -1 ? lanes.length : free
}

/**
 * The graph rows of `commits`, given children before parents (`git log --date-order` or `--topo-order`).
 * A parent outside the list keeps its lane open to the bottom of the last row.
 */
export function layoutGraph(commits: GraphCommit[]): GraphRow[] {
  // The commit each lane waits for, and the color of each lane
  const lanes: (string | null)[] = []
  const colors: number[] = []
  let nextColor = 0
  const rows: GraphRow[] = []

  for (const commit of commits) {
    let lane = lanes.indexOf(commit.hash)
    const isTip = lane === -1
    if (isTip) {
      lane = freeLane(lanes)
      lanes[lane] = commit.hash
      colors[lane] = nextColor++ % LANE_COLORS.length
    }
    const color = colors[lane] ?? 0

    // Top half: every lane coming from the row above; the ones waiting for this commit converge into its dot
    const top: GraphEdge[] = []
    lanes.forEach((waited, index) => {
      if (waited === null) return
      if (waited === commit.hash) {
        if (!(isTip && index === lane)) top.push([index, lane, colors[index] ?? 0])
      } else {
        top.push([index, index, colors[index] ?? 0])
      }
    })
    lanes.forEach((waited, index) => {
      if (waited === commit.hash && index !== lane) lanes[index] = null
    })

    // Bottom half: the lanes passing by, then the first parent on the commit's own lane, then the other parents
    const passing = lanes.map((waited, index) => (waited !== null && index !== lane ? index : -1)).filter(index => index >= 0)
    const bottom: GraphEdge[] = passing.map(index => [index, index, colors[index] ?? 0])
    const [first, ...others] = commit.parents
    if (first === undefined) {
      lanes[lane] = null
    } else {
      lanes[lane] = first
      bottom.push([lane, lane, color])
    }
    for (const parent of others) {
      let target = lanes.indexOf(parent)
      if (target === -1) {
        target = freeLane(lanes)
        lanes[target] = parent
        colors[target] = nextColor++ % LANE_COLORS.length
      }
      bottom.push([lane, target, colors[target] ?? 0])
    }

    const lanesUsed = [lane, ...top.flatMap(edge => [edge[0], edge[1]]), ...bottom.flatMap(edge => [edge[0], edge[1]])]
    rows.push({ lane, color, top, bottom, width: Math.max(...lanesUsed) + 1, isMerge: commit.parents.length > 1 })
  }
  return rows
}

const center = (lane: number) => lane * LANE_WIDTH + LANE_WIDTH / 2

/** A ref label drawn in the graph, after the lanes, as EGit draws it: a box with a border, the name inside. */
export type SvgLabel = { name: string; color: string; fill: string; fillOpacity: number; isBold: boolean }

/** Pixels of a label: height, gap after it, padding, and the font size. */
const LABEL_HEIGHT = 16
const LABEL_GAP = 4
const LABEL_PADDING = 4
const FONT_SIZE = 11
/** Fonts with the metrics of Arial: Arimo and Liberation Sans on Linux, Arial elsewhere. */
const LABEL_FONT = "Arial, Helvetica, 'Liberation Sans', Arimo, sans-serif"

// Advance widths of Arial in thousandths of the font size, from space (32) to tilde (126); regular, then bold
const REGULAR =
  '278 278 355 556 556 889 667 191 333 333 389 584 278 333 278 278 556 556 556 556 556 556 556 556 556 556 278 278 584 584 584 556 ' +
  '1015 667 667 722 722 667 611 778 722 278 500 667 556 833 722 778 667 778 722 667 611 722 667 944 667 667 611 278 278 278 469 556 ' +
  '333 556 556 500 556 556 278 556 556 222 222 500 222 833 556 556 556 556 333 500 278 556 500 722 500 500 500 334 260 334 584'
const BOLD =
  '278 333 474 556 556 889 722 238 333 333 389 584 278 333 278 278 556 556 556 556 556 556 556 556 556 556 333 333 584 584 584 611 ' +
  '975 722 722 722 722 667 611 778 722 278 556 722 611 833 722 778 667 778 722 667 611 722 667 944 667 667 611 333 278 333 584 556 ' +
  '333 556 611 556 611 556 333 611 611 278 278 556 278 889 611 611 611 611 389 556 333 611 556 778 556 556 500 389 280 389 584'
const ADVANCES = { regular: REGULAR.split(' ').map(Number), bold: BOLD.split(' ').map(Number) }

/** The width in pixels of `text` in the label font; a character outside ASCII counts as a digit. */
export function textWidth(text: string, isBold: boolean): number {
  const advances = isBold ? ADVANCES.bold : ADVANCES.regular
  let total = 0
  for (const char of text) total += advances[(char.codePointAt(0) ?? 0) - 32] ?? 556
  return (total * FONT_SIZE) / 1000
}

function escapeXml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

/** The width in pixels of a label drawn by `rowSvg`, gap included. */
export function labelWidth(label: SvgLabel): number {
  return Math.ceil(textWidth(label.name, label.isBold)) + LABEL_PADDING * 2 + LABEL_GAP
}

/** The width in pixels of the SVG of a row: its lanes and its labels. */
export function rowSvgWidth(row: GraphRow, labels: SvgLabel[] = []): number {
  const lanes = row.width * LANE_WIDTH
  return labels.length === 0 ? lanes : lanes + LABEL_GAP + labels.reduce((sum, label) => sum + labelWidth(label), 0)
}

/**
 * The SVG of one row: segments 2 px wide, a dot of the lane's color with a dark ring, then the ref labels.
 * Everything stays in one picture of ROW_HEIGHT pixels, so every row of the table has the same height and the lanes
 * join from one row to the next. Colors are attributes, since a <style> may be stripped.
 */
export function rowSvg(row: GraphRow, labels: SvgLabel[] = []): string {
  const width = rowSvgWidth(row, labels)
  const middle = ROW_HEIGHT / 2
  const line = (x1: number, y1: number, x2: number, y2: number, color: number) =>
    `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="${LANE_COLORS[color]}"/>`
  const segments = [
    ...row.top.map(([from, to, color]) => line(center(from), 0, center(to), middle, color)),
    ...row.bottom.map(([from, to, color]) => line(center(from), middle, center(to), ROW_HEIGHT, color)),
  ]
  const radius = row.isMerge ? 4.5 : 4
  let x = row.width * LANE_WIDTH + LABEL_GAP
  const boxes = labels.map(label => {
    const boxWidth = labelWidth(label) - LABEL_GAP
    const nameWidth = boxWidth - LABEL_PADDING * 2
    const top = (ROW_HEIGHT - LABEL_HEIGHT) / 2
    const box =
      `<rect x="${x + 0.5}" y="${top + 0.5}" width="${boxWidth - 1}" height="${LABEL_HEIGHT - 1}" rx="3" ` +
      `fill="${label.fill}" fill-opacity="${label.fillOpacity}" stroke="${label.color}"/>` +
      `<text x="${x + LABEL_PADDING}" y="${top + LABEL_HEIGHT - 4.5}" textLength="${nameWidth}" lengthAdjust="spacingAndGlyphs" ` +
      `fill="${label.color}"${label.isBold ? ' font-weight="bold"' : ''}>${escapeXml(label.name)}</text>`
    x += boxWidth + LABEL_GAP
    return box
  })
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${ROW_HEIGHT}" viewBox="0 0 ${width} ${ROW_HEIGHT}">` +
    `<g stroke-width="2" stroke-linecap="round" fill="none">${segments.join('')}</g>` +
    `<circle cx="${center(row.lane)}" cy="${middle}" r="${radius}" fill="${LANE_COLORS[row.color]}" stroke="#20232a" stroke-width="1.2"/>` +
    (boxes.length > 0 ? `<g font-family="${LABEL_FONT}" font-size="${FONT_SIZE}">${boxes.join('')}</g>` : '') +
    '</svg>'
  )
}

/**
 * The same row in characters, for a surface without vectors: `●` on the commit's lane, `│` for the lanes passing by,
 * `╮` and `╯` where a lane opens or closes beside it.
 */
export function rowGlyphs(row: GraphRow): string {
  const cells: string[] = Array.from({ length: row.width }, () => ' ')
  for (const [from, to] of row.top) cells[from] = from === to ? '│' : from > to ? '╯' : '╰'
  for (const [from, to] of row.bottom) {
    if (from === to) {
      if (cells[from] === ' ') cells[from] = '│'
    } else if (cells[to] === ' ') {
      cells[to] = to > from ? '╮' : '╭'
    }
  }
  cells[row.lane] = '●'
  return cells.join(' ')
}
