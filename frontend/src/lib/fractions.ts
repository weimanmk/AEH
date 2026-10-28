/** 分数解析与比较（纯前端、无副作用；仅用于演示判分）。 */

export interface Fraction {
  n: number
  d: number
}

/** 解析 `a/b` 或整数；无法解析时返回 null。 */
export function parseFraction(raw: string): Fraction | null {
  const s = raw.trim().replace(/／/g, '/').replace(/\s+/g, '')
  if (s === '') return null
  if (/^-?\d+$/.test(s)) {
    return { n: Number.parseInt(s, 10), d: 1 }
  }
  const match = /^(-?\d+)\/(-?\d+)$/.exec(s)
  if (!match) return null
  const n = Number.parseInt(match[1], 10)
  let d = Number.parseInt(match[2], 10)
  if (d === 0) return null
  if (d < 0) {
    return { n: -n, d: -d }
  }
  return { n, d }
}

/** 交叉相乘判等（避免浮点误差）。 */
export function fractionEquals(a: Fraction, b: Fraction): boolean {
  return a.n * b.d === b.n * a.d
}

function gcd(a: number, b: number): number {
  let x = Math.abs(a)
  let y = Math.abs(b)
  while (y !== 0) {
    const t = y
    y = x % y
    x = t
  }
  return x
}

export function simplify(f: Fraction): Fraction {
  const g = gcd(f.n, f.d) || 1
  return { n: f.n / g, d: f.d / g }
}

export function formatFraction(f: Fraction): string {
  const s = simplify(f)
  return s.d === 1 ? `${s.n}` : `${s.n}/${s.d}`
}

export function formatPercent(value: number | null | undefined, digits = 1): string {
  if (value === null || value === undefined || Number.isNaN(value)) return '—'
  return `${(value * 100).toFixed(digits)}%`
}

export function formatNumber(value: number, digits = 2): string {
  return value.toFixed(digits)
}
