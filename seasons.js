// One year as a single phase p ∈ [0, 1): 0 is the first thaw of spring, 1 is spring again.

export const YEAR_SECONDS = 720 // a whole year passes in twelve minutes

const smooth = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t) }
const circ = (p, c) => { const d = Math.abs(p - c) % 1; return Math.min(d, 1 - d) }
const bump = (p, c, w) => smooth(w, 0, circ(p, c))

// Hour of day through the year, always moving forward. Spring mornings, long summer afternoons, an
// autumn that ends in a stretched sunset, a night into a short grey winter day, and a night back into spring.
const HOUR_KEYS = [[0, 9.5], [0.25, 12.5], [0.5, 16.2], [0.62, 17.6], [0.7, 19.3], [0.78, 32.5], [0.95, 40.8], [1, 57.5]]

function hourAt(p) {
  for (let i = 0; i < HOUR_KEYS.length - 1; i++) {
    const [p0, h0] = HOUR_KEYS[i], [p1, h1] = HOUR_KEYS[i + 1]
    if (p <= p1) return h0 + ((p - p0) / (p1 - p0)) * (h1 - h0)
  }
  return HOUR_KEYS[0][1]
}

export function seasonAt(phase) {
  const p = ((phase % 1) + 1) % 1
  // each weight peaks mid-season and hands over to its neighbour; the four always sum to one
  const weights = [0.125, 0.375, 0.625, 0.875].map((c) => smooth(0.25, 0, circ(p, c)))
  return {
    phase: p,
    hours: hourAt(p),
    doy: (69 + p * 365) % 365, // phase 0 is early March
    weights,
    rain: 0.85 * bump(p, 0.07, 0.09) + 0.35 * bump(p, 0.69, 0.05),
    petals: bump(p, 0.18, 0.08),
    petalsFloat: bump(p, 0.2, 0.11),
    leaves: bump(p, 0.6, 0.12),
    leavesFloat: bump(p, 0.63, 0.16),
    snow: bump(p, 0.87, 0.11),
    overcast: Math.min(1, 0.1 + 0.55 * bump(p, 0.06, 0.12) + 0.3 * bump(p, 0.69, 0.06) + 0.75 * bump(p, 0.87, 0.14)),
    breeze: Math.round(45 * weights[0] + 18 * weights[1] + 75 * weights[2] + 12 * weights[3]),
  }
}

export const SUBSEASONS = [
  '早春', '仲春', '暮春',
  '初夏', '盛夏', '夏末',
  '初秋', '仲秋', '深秋',
  '初冬', '隆冬', '冬末',
]

export const subseasonAt = (phase) => SUBSEASONS[Math.floor((((phase % 1) + 1) % 1) * 12) % 12]

// Lines that surface once a year, at these phases.
export const LINES = [
  [0.02, '冰面松开了，没有一点声音'],
  [0.13, '雨落在水面上，像有人在数数'],
  [0.27, '天光迟迟不走，像还有地方要去'],
  [0.4, '到处都绿了，什么也留不住'],
  [0.52, '第一片叶子落下，湖收下了它'],
  [0.66, '风带走的，水载着'],
  [0.79, '雪落进水里，成了水'],
  [0.9, '冰面下，湖还在做梦'],
]
export const RETURN_LINE = '……然后，又是春天'
