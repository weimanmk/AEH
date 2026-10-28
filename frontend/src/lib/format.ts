export function formatDateTime(iso: string | null | undefined): string {
  if (iso === null || iso === undefined) return '—'
  const parsed = Date.parse(iso)
  if (Number.isNaN(parsed)) return iso
  return new Date(parsed).toISOString().slice(0, 16).replace('T', ' ') + ' UTC'
}

export function formatDate(iso: string | null | undefined): string {
  if (iso === null || iso === undefined) return '—'
  const parsed = Date.parse(iso)
  if (Number.isNaN(parsed)) return iso
  return new Date(parsed).toISOString().slice(0, 10)
}

export function percent(value: number | null | undefined, digits = 0): string {
  if (value === null || value === undefined || Number.isNaN(value)) return '—'
  return `${(value * 100).toFixed(digits)}%`
}

export function daysLabel(days: number | null | undefined): string {
  if (days === null || days === undefined || Number.isNaN(days)) return '—'
  if (days < 1) return `${(days * 24).toFixed(1)} 小时`
  return `${days.toFixed(1)} 天`
}
