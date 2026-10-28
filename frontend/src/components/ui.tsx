import type { ReactNode } from 'react'

export function PageHeader({
  eyebrow,
  title,
  lede,
  actions,
}: {
  eyebrow?: string
  title: string
  lede?: ReactNode
  actions?: ReactNode
}) {
  return (
    <div className="section-head">
      {eyebrow ? <div className="eyebrow">{eyebrow}</div> : null}
      <div className="spread">
        <h1>{title}</h1>
        {actions ? <div className="row">{actions}</div> : null}
      </div>
      {lede ? <p className="lede">{lede}</p> : null}
    </div>
  )
}

export function Section({
  eyebrow,
  title,
  description,
  actions,
  children,
}: {
  eyebrow?: string
  title: string
  description?: ReactNode
  actions?: ReactNode
  children: ReactNode
}) {
  return (
    <section className="section">
      <div className="spread section-head">
        <div>
          {eyebrow ? <div className="eyebrow">{eyebrow}</div> : null}
          <h2>{title}</h2>
          {description ? <p>{description}</p> : null}
        </div>
        {actions ? <div className="row">{actions}</div> : null}
      </div>
      {children}
    </section>
  )
}

type Tone =
  | 'neutral'
  | 'success'
  | 'error'
  | 'warning'
  | 'lavender'
  | 'sky'
  | 'solid'
  | 'green'
  | 'orange'
  | 'gray'

export function Badge({ tone = 'neutral', children }: { tone?: Tone; children: ReactNode }) {
  const cls =
    tone === 'green'
      ? 'badge badge-success'
      : tone === 'orange'
        ? 'badge badge-warning'
        : `badge badge-${tone}`
  return <span className={cls}>{children}</span>
}

export function Tag({ tone = 'lavender', children }: { tone?: Tone; children: ReactNode }) {
  const map: Record<string, string> = {
    neutral: 'tag',
    lavender: 'tag',
    gray: 'tag tag-gray',
    green: 'tag tag-green',
    orange: 'tag tag-orange',
  }
  return <span className={map[tone] ?? 'tag'}>{children}</span>
}

export function Stat({
  label,
  value,
  sub,
}: {
  label: string
  value: ReactNode
  sub?: ReactNode
}) {
  return (
    <div className="stat">
      <div className="stat-label">{label}</div>
      <div className="stat-value">{value}</div>
      {sub ? <div className="stat-sub">{sub}</div> : null}
    </div>
  )
}

export function Meter({
  value,
  tone = 'primary',
  label,
}: {
  value: number
  tone?: 'primary' | 'green' | 'orange' | 'navy'
  label?: string
}) {
  const pct = Math.max(0, Math.min(1, value)) * 100
  const fillCls =
    tone === 'green'
      ? 'meter-fill green'
      : tone === 'orange'
        ? 'meter-fill orange'
        : tone === 'navy'
          ? 'meter-fill navy'
          : 'meter-fill'
  return (
    <div>
      <div className="meter">
        <div className={fillCls} style={{ width: `${pct}%` }} />
      </div>
      {label ? <div className="meter-label">{label}</div> : null}
    </div>
  )
}

export function Notice({
  tone = 'plain',
  title,
  children,
}: {
  tone?: 'plain' | 'synthetic' | 'warning' | 'success' | 'dark'
  title?: ReactNode
  children: ReactNode
}) {
  const cls =
    tone === 'synthetic'
      ? 'notice notice-synthetic'
      : tone === 'warning'
        ? 'notice notice-warning'
        : tone === 'success'
          ? 'notice notice-success'
          : tone === 'dark'
            ? 'notice notice-dark'
            : 'notice'
  return (
    <div className={cls}>
      {title ? (
        <>
          <strong>{title}</strong>{' '}
        </>
      ) : null}
      {children}
    </div>
  )
}

export function KeyValues({ items }: { items: { key: string; value: ReactNode }[] }) {
  return (
    <dl className="kv">
      {items.map((item) => (
        <div key={item.key} style={{ display: 'contents' }}>
          <dt>{item.key}</dt>
          <dd>{item.value}</dd>
        </div>
      ))}
    </dl>
  )
}

export function Card({
  children,
  className = '',
}: {
  children: ReactNode
  className?: string
}) {
  return <div className={`card ${className}`.trim()}>{children}</div>
}
