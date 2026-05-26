import { useState, useRef, useCallback, useEffect, Component } from 'react'
import type { ReactNode } from 'react'
import { createPortal } from 'react-dom'

// ─── Error Boundary ───────────────────────────────────────────────────────────

export class ErrorBoundary extends Component<
  { children: ReactNode },
  { error: Error | null }
> {
  state = { error: null }
  static getDerivedStateFromError(error: Error) { return { error } }
  render() {
    if (this.state.error) {
      return (
        <div style={{ padding: 32, color: '#ef4444', fontFamily: 'monospace', background: '#0d0d0f', height: '100%', overflow: 'auto' }}>
          <div style={{ fontWeight: 700, fontSize: 16, marginBottom: 12 }}>App crashed</div>
          <pre style={{ fontSize: 12, whiteSpace: 'pre-wrap' }}>
            {(this.state.error as Error).message}{'\n\n'}{(this.state.error as Error).stack}
          </pre>
          <button onClick={() => this.setState({ error: null })} style={{ marginTop: 16, padding: '6px 16px', background: '#ef4444', border: 'none', borderRadius: 6, color: '#fff', cursor: 'pointer' }}>
            Retry
          </button>
        </div>
      )
    }
    return this.props.children as ReactNode
  }
}

// ─── Types ───────────────────────────────────────────────────────────────────

interface ApiCandidate {
  tcgplayer_product_id: number
  image_url: string
  phash: string
  hamming_distance: number
  name: string
  set_name: string
}

interface BreakEntry {
  id: string
  file: File
  previewUrl: string
  scanUrl?: string
  status: 'queued' | 'identifying' | 'done' | 'back_detected' | 'error'
  confidence?: 'high' | 'medium' | 'none' | 'back'
  needsReview?: boolean
  tcgplayerId?: number
  cardName?: string
  cardNumber?: string
  setName?: string
  candidateImageUrl?: string
  allCandidates?: ApiCandidate[]
  pairedFrontId?: string
  errorMsg?: string
  overrideName?: string
}

interface BreakInstance {
  front: BreakEntry
  back?: BreakEntry
}

interface BreakCard {
  key: string
  tcgplayerId?: number
  cardName: string
  cardNumber?: string
  setName?: string
  instances: BreakInstance[]
}

interface ApiResponse {
  scan_id: string
  confidence: 'high' | 'medium' | 'none' | 'back'
  match_method: string
  match_source: string
  needs_review: boolean
  back_detected: boolean
  front_image: string
  candidates: ApiCandidate[]
}

// ─── Constants ───────────────────────────────────────────────────────────────

const IDENTIFY_URL = 'https://ev-api.futuregadgetlabs.com/v1/scan/identify'
const MAX_CONCURRENT = 3
const BACK_WAIT_TIMEOUT = 3000
const BACK_WAIT_POLL = 500

// ─── Pure helpers ─────────────────────────────────────────────────────────────

function makeId(): string {
  return 'be_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 6)
}

function extractCardNumber(name: string): string | undefined {
  const m = name.match(/\((\d{4})\)/)
  return m ? m[1] : undefined
}

async function callIdentifyApi(file: File, setCode: string): Promise<ApiResponse> {
  async function post(restrict: string): Promise<ApiResponse> {
    const fd = new FormData()
    fd.append('image', file)
    // restrict_set must be a form field — ev-api proxies the body but strips query params
    if (restrict) fd.append('restrict_set', restrict)
    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), 90_000)
    try {
      const res = await fetch(IDENTIFY_URL, { method: 'POST', body: fd, signal: ctrl.signal })
      if (!res.ok) {
        const text = await res.text().catch(() => res.statusText)
        throw new Error(`API ${res.status}: ${text}`)
      }
      return (await res.json()) as ApiResponse
    } finally {
      clearTimeout(timer)
    }
  }

  const result = await post(setCode.trim())
  // If the set restriction returned zero candidates (set not yet indexed), fall back to global search
  if (setCode.trim() && !result.back_detected && (!result.candidates || result.candidates.length === 0)) {
    return post('')
  }
  return result
}

function groupEntries(entries: BreakEntry[]): BreakCard[] {
  const byId = new Map<string, BreakEntry>()
  for (const e of entries) byId.set(e.id, e)
  const cards = new Map<string, BreakCard>()
  for (const entry of entries) {
    if (entry.status !== 'done') continue
    const displayName = entry.overrideName ?? entry.cardName ?? 'Unknown'
    const key = entry.tcgplayerId ? entry.tcgplayerId.toString() : displayName
    if (!cards.has(key)) {
      cards.set(key, { key, tcgplayerId: entry.tcgplayerId, cardName: displayName, cardNumber: entry.cardNumber, setName: entry.setName, instances: [] })
    }
    cards.get(key)!.instances.push({ front: entry, back: undefined })
  }
  for (const entry of entries) {
    if (entry.status !== 'back_detected' || !entry.pairedFrontId) continue
    const front = byId.get(entry.pairedFrontId)
    if (!front) continue
    const displayName = front.overrideName ?? front.cardName ?? 'Unknown'
    const key = front.tcgplayerId ? front.tcgplayerId.toString() : displayName
    const card = cards.get(key)
    if (!card) continue
    const inst = card.instances.find(i => i.front.id === front.id)
    if (inst && !inst.back) inst.back = entry
  }
  return Array.from(cards.values())
}

function buildCSV(entries: BreakEntry[]): string {
  const cards = groupEntries(entries)
  const rows: string[] = ['card_name,card_number,set_name,tcgplayer_id,quantity,front_image_urls,back_image_urls']
  const q = (s: string) => `"${s.replace(/"/g, '""')}"`
  for (const card of cards) {
    const fronts = card.instances.map(i => i.front.scanUrl ?? '').join('|')
    const backs = card.instances.map(i => i.back?.scanUrl ?? '').join('|')
    rows.push([q(card.cardName), q(card.cardNumber ?? ''), q(card.setName ?? ''), card.tcgplayerId?.toString() ?? '', card.instances.length.toString(), q(fronts), q(backs)].join(','))
  }
  return rows.join('\n')
}

function downloadCSV(csv: string) {
  const blob = new Blob([csv], { type: 'text/csv' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = `break-export-${Date.now()}.csv`
  a.click()
  URL.revokeObjectURL(url)
}

// ─── Status chip ─────────────────────────────────────────────────────────────

function StatusChip({ status }: { status: BreakEntry['status'] }) {
  const map: Record<BreakEntry['status'], { label: string; color: string }> = {
    queued: { label: 'Queued', color: 'var(--text-dim)' },
    identifying: { label: 'Identifying…', color: 'var(--warning)' },
    done: { label: 'Done', color: 'var(--success)' },
    back_detected: { label: 'Card Back', color: 'var(--purple)' },
    error: { label: 'Error', color: 'var(--danger)' },
  }
  const { label, color } = map[status]
  return (
    <span style={{ fontSize: 11, fontWeight: 600, color, background: color + '22', border: `1px solid ${color}44`, borderRadius: 4, padding: '1px 6px', whiteSpace: 'nowrap' }}>
      {label}
    </span>
  )
}

// ─── Correction Panel ─────────────────────────────────────────────────────────

function CorrectionPanel({
  entry,
  onSelect,
  onOverride,
  onClose,
}: {
  entry: BreakEntry
  onSelect: (candidate: ApiCandidate) => void
  onOverride: (name: string) => void
  onClose: () => void
}) {
  const [search, setSearch] = useState('')
  const [overrideVal, setOverrideVal] = useState(entry.overrideName ?? entry.cardName ?? '')
  const inputRef = useRef<HTMLInputElement>(null)
  const candidates = entry.allCandidates ?? []

  const filtered = candidates.filter(c =>
    !search || c.name.toLowerCase().includes(search.toLowerCase()) || c.set_name.toLowerCase().includes(search.toLowerCase())
  )

  useEffect(() => {
    inputRef.current?.focus()
  }, [])

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { onClose(); return }
      const n = parseInt(e.key)
      if (!isNaN(n) && n >= 1 && n <= 9) {
        const c = filtered[n - 1]
        if (c) onSelect(c)
      }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [filtered, onSelect, onClose])

  return (
    <div style={{ background: 'var(--surface-2)', border: '1px solid var(--primary)', borderRadius: 8, padding: 16, marginTop: 8 }}>
      {/* Header */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
        <span style={{ fontSize: 13, fontWeight: 700, color: 'var(--primary)', textTransform: 'uppercase', letterSpacing: '0.06em' }}>
          Correct Identification
        </span>
        <button onClick={onClose} style={{ background: 'none', border: 'none', color: 'var(--text-dim)', fontSize: 20, cursor: 'pointer', lineHeight: 1, padding: '0 4px' }}>×</button>
      </div>

      {/* Search */}
      <input
        ref={inputRef}
        value={search}
        onChange={e => setSearch(e.target.value)}
        placeholder="Search candidates… (1–9 to pick, Esc to close)"
        style={{ width: '100%', background: 'var(--bg)', border: '1px solid var(--border)', borderRadius: 6, color: 'var(--text)', padding: '7px 10px', fontSize: 13, fontFamily: 'inherit', marginBottom: 12 }}
      />

      {/* Candidates grid */}
      {candidates.length === 0 ? (
        <div style={{ fontSize: 12, color: 'var(--text-dim)', padding: '12px 0' }}>No candidates returned by API for this scan</div>
      ) : (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, maxHeight: 420, overflowY: 'auto', marginBottom: 12 }}>
          {filtered.map((c, i) => (
            <div
              key={c.tcgplayer_product_id}
              onClick={() => onSelect(c)}
              title={`${c.name} — ${c.set_name}`}
              style={{ cursor: 'pointer', border: '1px solid var(--border)', borderRadius: 6, overflow: 'hidden', width: 110, flexShrink: 0, position: 'relative' }}
              onMouseEnter={e => { e.currentTarget.style.borderColor = 'var(--primary)' }}
              onMouseLeave={e => { e.currentTarget.style.borderColor = 'var(--border)' }}
            >
              {i < 9 && (
                <div style={{ position: 'absolute', top: 3, left: 3, background: 'rgba(0,0,0,0.75)', color: '#fff', fontSize: 11, fontWeight: 700, borderRadius: 4, padding: '1px 5px' }}>
                  {i + 1}
                </div>
              )}
              <img
                src={c.image_url}
                alt=""
                onError={e => { e.currentTarget.style.display = 'none' }}
                style={{ width: 108, height: 151, objectFit: 'cover', display: 'block' }}
              />
              <div style={{ padding: '4px 6px', background: 'var(--surface)' }}>
                <div style={{ fontSize: 10, fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: 'var(--text)' }}>{c.name}</div>
                <div style={{ fontSize: 10, color: 'var(--text-dim)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{c.set_name}</div>
              </div>
            </div>
          ))}
          {filtered.length === 0 && (
            <div style={{ fontSize: 12, color: 'var(--text-dim)' }}>No matches for "{search}"</div>
          )}
        </div>
      )}

      {/* Manual override */}
      <div style={{ borderTop: '1px solid var(--border)', paddingTop: 10, display: 'flex', gap: 8 }}>
        <input
          value={overrideVal}
          onChange={e => setOverrideVal(e.target.value)}
          placeholder="Or type card name manually…"
          style={{ flex: 1, background: 'var(--bg)', border: '1px solid var(--border)', borderRadius: 6, color: 'var(--text)', padding: '6px 10px', fontSize: 12, fontFamily: 'inherit' }}
        />
        <button
          onClick={() => { onOverride(overrideVal); onClose() }}
          style={{ background: 'var(--surface-2)', border: '1px solid var(--border)', borderRadius: 6, color: 'var(--text)', padding: '6px 14px', fontSize: 12, cursor: 'pointer', fontFamily: 'inherit', flexShrink: 0 }}
        >
          Set name
        </button>
      </div>
    </div>
  )
}

// ─── Queue Item ───────────────────────────────────────────────────────────────

function QueueItem({
  entry,
  onOverride,
  onCorrect,
  imgScale = 1,
}: {
  entry: BreakEntry
  onOverride: (id: string, name: string) => void
  onCorrect: (id: string, candidate: ApiCandidate) => void
  imgScale?: 1 | 2 | 4
}) {
  const [correcting, setCorrecting] = useState(false)
  const canCorrect = entry.status === 'done' || (entry.status === 'back_detected' && !!entry.pairedFrontId)
  const sw = 80 * imgScale, sh = 112 * imgScale
  const cw = 60 * imgScale, ch = 84 * imgScale

  return (
    <div style={{ padding: '8px 0', borderBottom: '1px solid var(--border)' }}>
      <div style={{ display: 'flex', gap: 8, alignItems: 'flex-start' }}>
        {/* Scan preview */}
        <div style={{ flexShrink: 0, textAlign: 'center' }}>
          <img
            src={entry.previewUrl}
            alt=""
            style={{ width: sw, height: sh, objectFit: 'cover', borderRadius: 4, border: '1px solid var(--border)', display: 'block' }}
          />
          <span style={{ fontSize: 9, color: '#4ade80', fontWeight: 600 }}>📷 scan</span>
        </div>
        <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 4 }}>
          <div style={{ fontSize: 11, color: 'var(--text-dim)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={entry.file.name}>
            {entry.file.name}
          </div>
          <StatusChip status={entry.status} />
          {entry.status === 'done' && entry.cardName && (
            <div style={{ fontSize: 11, color: 'var(--text)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={entry.overrideName ?? entry.cardName}>
              {entry.overrideName ? <em>{entry.overrideName}</em> : entry.cardName}
            </div>
          )}
          {entry.status === 'done' && entry.setName && (
            <div style={{ fontSize: 10, color: 'var(--text-dim)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {entry.setName}
            </div>
          )}
          {entry.status === 'back_detected' && (
            <div style={{ fontSize: 11, color: 'var(--purple)' }}>
              {entry.pairedFrontId ? 'Paired with front' : 'No front found'}
            </div>
          )}
          {entry.status === 'error' && entry.errorMsg && (
            <div style={{ fontSize: 11, color: 'var(--danger)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={entry.errorMsg}>
              {entry.errorMsg}
            </div>
          )}
          {/* Correct button */}
          {canCorrect && (
            <button
              onClick={() => setCorrecting(c => !c)}
              style={{
                background: correcting ? 'rgba(99,102,241,0.2)' : 'var(--surface-2)',
                border: `1px solid ${correcting ? 'var(--primary)' : 'var(--border)'}`,
                borderRadius: 4, color: correcting ? 'var(--primary)' : 'var(--text-dim)',
                padding: '2px 8px', fontSize: 10, cursor: 'pointer', fontFamily: 'inherit',
                alignSelf: 'flex-start', marginTop: 2,
              }}
            >
              {correcting ? 'Close' : '✎ Correct'}
            </button>
          )}
        </div>

        {/* Stock image from TCGPlayer */}
        {entry.status === 'done' && entry.candidateImageUrl && (
          <div style={{ flexShrink: 0, textAlign: 'center' }}>
            <img
              src={entry.candidateImageUrl}
              alt=""
              onError={e => { e.currentTarget.style.display = 'none' }}
              style={{ width: cw, height: ch, objectFit: 'cover', borderRadius: 4, border: '1px solid var(--border)', display: 'block' }}
            />
            <span style={{ fontSize: 9, color: 'var(--primary)', fontWeight: 600 }}>stock</span>
          </div>
        )}
      </div>

      {/* Correction panel */}
      {correcting && (
        <>
          <div style={{ marginTop: 8, display: 'flex', gap: 12, alignItems: 'flex-start', flexWrap: 'wrap' }}>
            <div style={{ textAlign: 'center', flexShrink: 0 }}>
              <img
                src={entry.previewUrl}
                alt=""
                style={{ width: 300, height: 420, objectFit: 'contain', borderRadius: 6, border: '2px solid #4ade80', background: '#000', display: 'block' }}
              />
              <span style={{ fontSize: 10, color: '#4ade80', fontWeight: 600 }}>📷 your scan</span>
            </div>
            {entry.candidateImageUrl && (
              <div style={{ textAlign: 'center', flexShrink: 0 }}>
                <img
                  src={entry.candidateImageUrl}
                  alt=""
                  onError={e => { e.currentTarget.style.display = 'none' }}
                  style={{ width: 300, height: 420, objectFit: 'contain', borderRadius: 6, border: '2px solid var(--border)', background: '#000', display: 'block' }}
                />
                <span style={{ fontSize: 10, color: 'var(--primary)', fontWeight: 600 }}>stock — current match</span>
              </div>
            )}
          </div>
          <CorrectionPanel
            entry={entry}
            onSelect={c => { onCorrect(entry.id, c); setCorrecting(false) }}
            onOverride={name => { onOverride(entry.id, name); setCorrecting(false) }}
            onClose={() => setCorrecting(false)}
          />
        </>
      )}
    </div>
  )
}

// ─── Drop Zone ────────────────────────────────────────────────────────────────

function DropZone({ onFiles }: { onFiles: (files: File[]) => void }) {
  const [dragging, setDragging] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)

  function handleFileList(fileList: FileList | null) {
    if (!fileList) return
    const images = Array.from(fileList).filter(f => f.type.startsWith('image/'))
    if (images.length) onFiles(images)
  }

  return (
    <div
      onDragOver={e => { e.preventDefault(); setDragging(true) }}
      onDragLeave={() => setDragging(false)}
      onDrop={e => { e.preventDefault(); setDragging(false); handleFileList(e.dataTransfer.files) }}
      onClick={() => inputRef.current?.click()}
      style={{ border: `2px dashed ${dragging ? 'var(--primary)' : 'var(--border)'}`, borderRadius: 8, padding: '20px 16px', textAlign: 'center', background: dragging ? '#6366f111' : 'var(--surface)', transition: 'border-color 0.15s, background 0.15s', cursor: 'pointer' }}
    >
      <div style={{ fontSize: 24, marginBottom: 6 }}>📂</div>
      <div style={{ color: 'var(--text-dim)', fontSize: 12, marginBottom: 8 }}>Drop card scans here</div>
      <button
        onClick={e => { e.stopPropagation(); inputRef.current?.click() }}
        style={{ background: 'var(--surface-2)', border: '1px solid var(--border)', borderRadius: 6, color: 'var(--text)', padding: '5px 14px', fontSize: 12 }}
      >
        Browse…
      </button>
      <input ref={inputRef} type="file" accept="image/*" multiple style={{ display: 'none' }} onChange={e => { handleFileList(e.target.files); e.target.value = '' }} />
    </div>
  )
}

// ─── Instance thumbnails ──────────────────────────────────────────────────────

function InstanceThumbs({ inst, imgScale = 1 }: { inst: BreakInstance; imgScale?: 1 | 2 | 4 }) {
  const hasBoth = !!inst.back
  const tw = 56 * imgScale, th = 78 * imgScale
  return (
    <div style={{ display: 'flex', gap: 4, alignItems: 'flex-end', background: 'var(--surface-2)', borderRadius: 6, padding: '4px 6px', border: `1px solid ${hasBoth ? 'var(--success)' : 'var(--border)'}` }}>
      <div style={{ textAlign: 'center' }}>
        <img
          src={inst.front.previewUrl}
          alt=""
          onError={e => { if (inst.front.scanUrl) e.currentTarget.src = inst.front.scanUrl }}
          style={{ width: tw, height: th, objectFit: 'cover', borderRadius: 3, border: '1px solid var(--border)', display: 'block' }}
        />
        <span style={{ fontSize: 9, color: '#4ade80', fontWeight: 600 }}>📷 front</span>
      </div>
      {inst.back ? (
        <div style={{ textAlign: 'center' }}>
          <img
            src={inst.back.previewUrl}
            alt=""
            onError={e => { if (inst.back?.scanUrl) e.currentTarget.src = inst.back.scanUrl }}
            style={{ width: tw, height: th, objectFit: 'cover', borderRadius: 3, border: '1px solid var(--border)', display: 'block' }}
          />
          <span style={{ fontSize: 9, color: '#4ade80', fontWeight: 600 }}>📷 back</span>
        </div>
      ) : (
        <div style={{ textAlign: 'center' }}>
          <div style={{ width: tw, height: th, borderRadius: 3, border: '1px dashed var(--border)', background: 'var(--surface)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            <span style={{ fontSize: 16, opacity: 0.3 }}>?</span>
          </div>
          <span style={{ fontSize: 9, color: 'var(--text-dim)' }}>none</span>
        </div>
      )}
    </div>
  )
}

// ─── Card Row ─────────────────────────────────────────────────────────────────

function CardRow({ card, imgScale = 1 }: { card: BreakCard; imgScale?: 1 | 2 | 4 }) {
  const hasAnyBack = card.instances.some(i => i.back)
  const allPaired = card.instances.every(i => i.back)
  const borderColor = allPaired ? 'var(--success)' : hasAnyBack ? '#2e6e3a' : 'var(--border)'
  const hw = 80 * imgScale, hh = 112 * imgScale

  const heroSrc = card.instances[0]?.front.candidateImageUrl ?? card.instances[0]?.front.previewUrl
  const heroIsStock = !!card.instances[0]?.front.candidateImageUrl

  return (
    <div style={{ background: 'var(--surface)', border: `1px solid ${borderColor}`, borderRadius: 8, padding: 12, marginBottom: 8 }}>
      <div style={{ display: 'flex', gap: 12, alignItems: 'flex-start' }}>
        <div style={{ flexShrink: 0, textAlign: 'center' }}>
          <img
            src={heroSrc}
            alt=""
            onError={e => {
              const img = e.currentTarget
              const fallback = card.instances[0]?.front.previewUrl
              if (fallback && img.src !== fallback) img.src = fallback
            }}
            style={{ width: hw, height: hh, objectFit: 'cover', borderRadius: 4, border: '1px solid var(--border)', display: 'block' }}
          />
          <span style={{ fontSize: 9, fontWeight: 600, color: heroIsStock ? 'var(--primary)' : '#4ade80' }}>
            {heroIsStock ? 'stock' : '📷 scan'}
          </span>
        </div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
            <span style={{ fontWeight: 700, fontSize: 14, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{card.cardName}</span>
            <span style={{ background: 'var(--primary)', color: '#fff', borderRadius: 12, padding: '1px 8px', fontSize: 12, fontWeight: 600, flexShrink: 0 }}>×{card.instances.length}</span>
          </div>
          {card.setName && <div style={{ color: 'var(--text-dim)', fontSize: 12, marginBottom: 2 }}>{card.setName}</div>}
          {card.cardNumber && <div style={{ color: 'var(--text-dim)', fontSize: 11, marginBottom: 6 }}>#{card.cardNumber}</div>}
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginTop: 4 }}>
            {card.instances.map((inst, idx) => <InstanceThumbs key={idx} inst={inst} imgScale={imgScale} />)}
          </div>
        </div>
      </div>
    </div>
  )
}

// ─── Set / Commander Picker ───────────────────────────────────────────────────

const MARKET_API = 'https://market.futuregadgetlabs.com'

interface MarketSet {
  id: string
  game: string
  code: string
  name: string
  release_date?: string
  card_count?: number
  image_url?: string
}

interface SealedProduct {
  id: string
  set_id: string | null
  game: string
  product_type: string
  qualifier: string | null
  name: string
  image_url: string | null
  display_key: string
}

type PickerGame = 'mtg' | 'pokemon'
type PickerCategory = 'set' | 'commander'

function ToggleGroup({ options, active, onChange, activeColor }: { options: { value: string; label: string }[]; active: string; onChange: (v: string) => void; activeColor: string }) {
  return (
    <div style={{ display: 'flex', background: 'var(--surface-2)', border: '1px solid var(--border)', borderRadius: 6, overflow: 'hidden', flexShrink: 0 }}>
      {options.map(o => (
        <button key={o.value} onClick={() => onChange(o.value)} style={{ padding: '5px 10px', border: 'none', fontFamily: 'inherit', background: active === o.value ? activeColor : 'transparent', color: active === o.value ? '#fff' : 'var(--text-dim)', fontWeight: active === o.value ? 700 : 400, fontSize: 12, cursor: 'pointer' }}>
          {o.label}
        </button>
      ))}
    </div>
  )
}

function DeckRow({ label, sublabel, imageUrl, onClick }: { label: string; sublabel?: string; imageUrl?: string; onClick: () => void }) {
  return (
    <div onClick={onClick} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '8px 12px', cursor: 'pointer', borderLeft: '2px solid transparent' }} onMouseEnter={e => { e.currentTarget.style.background = 'rgba(255,255,255,0.05)' }} onMouseLeave={e => { e.currentTarget.style.background = 'transparent' }}>
      {imageUrl ? (
        <img src={imageUrl} alt="" style={{ width: 36, height: 36, objectFit: 'contain', flexShrink: 0, borderRadius: 3 }} />
      ) : (
        <div style={{ width: 36, height: 36, flexShrink: 0, background: 'var(--surface-2)', borderRadius: 3, border: '1px solid var(--border)' }} />
      )}
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 12, fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{label}</div>
        {sublabel && <div style={{ fontSize: 10, color: 'var(--text-dim)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{sublabel}</div>}
      </div>
    </div>
  )
}

function SetPicker({ selectedCode, onSelect }: { selectedCode: string; onSelect: (code: string, setName: string, game: string, deckName?: string) => void }) {
  const [open, setOpen] = useState(false)
  const [game, setGame] = useState<PickerGame>('mtg')
  const [category, setCategory] = useState<PickerCategory>('set')
  const [search, setSearch] = useState('')
  const [sets, setSets] = useState<MarketSet[]>([])
  const [setsLoading, setSetsLoading] = useState(false)
  const [cmdStep, setCmdStep] = useState<'set' | 'deck'>('set')
  const [cmdSet, setCmdSet] = useState<MarketSet | null>(null)
  const [decks, setDecks] = useState<SealedProduct[]>([])
  const [decksLoading, setDecksLoading] = useState(false)
  const [selectedName, setSelectedName] = useState('')
  const [selectedDeck, setSelectedDeck] = useState('')
  const btnRef = useRef<HTMLButtonElement>(null)
  const dropRef = useRef<HTMLDivElement>(null)
  const [dropPos, setDropPos] = useState<{ top: number; left: number } | null>(null)

  useEffect(() => {
    setSetsLoading(true)
    fetch(`${MARKET_API}/v1/sets?game=${game}`)
      .then(r => r.json())
      .then((d: { sets: MarketSet[] }) => setSets(d.sets ?? []))
      .catch(() => setSets([]))
      .finally(() => setSetsLoading(false))
  }, [game])

  useEffect(() => {
    if (!cmdSet) return
    setDecksLoading(true)
    fetch(`${MARKET_API}/v1/sets/${game}/${encodeURIComponent(cmdSet.code)}/sealed`)
      .then(r => r.json())
      .then((d: { sealed: SealedProduct[] }) => setDecks((d.sealed ?? []).filter(p => p.product_type === 'commander_deck')))
      .catch(() => setDecks([]))
      .finally(() => setDecksLoading(false))
  }, [cmdSet, game])

  useEffect(() => {
    if (!open) return
    const handler = (e: MouseEvent) => {
      if (btnRef.current?.contains(e.target as Node)) return
      if (dropRef.current?.contains(e.target as Node)) return
      setOpen(false); setSearch('')
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [open])

  const clearSelection = (g = game) => { setSelectedName(''); setSelectedDeck(''); onSelect('', '', g) }

  const handleGameSwitch = (g: PickerGame) => {
    setGame(g); setSearch('')
    if (g === 'pokemon') setCategory('set')
    if (selectedCode) clearSelection(g)
  }

  const handleCategorySwitch = (cat: PickerCategory) => {
    setCategory(cat); setSearch(''); setCmdStep('set'); setCmdSet(null); setDecks([])
    if (selectedCode) clearSelection()
  }

  const handleToggle = () => {
    if (!open && btnRef.current) {
      const rect = btnRef.current.getBoundingClientRect()
      setDropPos({ top: rect.bottom + 4, left: rect.left })
    }
    setOpen(o => !o)
    if (open) setSearch('')
  }

  const handleSelectSet = (s: MarketSet) => {
    setSelectedName(s.name); setSelectedDeck(''); setSearch('')
    setOpen(false); setDropPos(null)
    onSelect(s.code, s.name, s.game)
  }

  const handlePickCmdSet = (s: MarketSet) => { setCmdSet(s); setCmdStep('deck'); setSearch('') }

  const handleSelectDeck = (s: MarketSet, deck: SealedProduct | null) => {
    setSelectedName(s.name); setSelectedDeck(deck?.name ?? ''); setSearch('')
    setOpen(false); setDropPos(null)
    onSelect(s.code, s.name, s.game, deck?.name)
  }

  const filteredSets = sets.filter(s => { const q = search.toLowerCase(); return !q || s.name.toLowerCase().includes(q) || s.code.toLowerCase().includes(q) })
  const filteredDecks = decks.filter(d => !search || d.name.toLowerCase().includes(search.toLowerCase()))

  const dropdown = dropPos && (
    <div ref={dropRef} style={{ position: 'fixed', top: dropPos.top, left: dropPos.left, width: 380, maxHeight: 480, zIndex: 9999, background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 8, boxShadow: '0 8px 24px rgba(0,0,0,0.5)', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
      <div style={{ padding: '8px 10px', borderBottom: '1px solid var(--border)', flexShrink: 0 }}>
        <input value={search} onChange={e => setSearch(e.target.value)} placeholder={category === 'commander' && cmdStep === 'deck' ? 'Search decks…' : 'Search by name or code…'} style={{ width: '100%', background: 'var(--bg)', border: '1px solid var(--border)', borderRadius: 5, color: 'var(--text)', padding: '5px 8px', fontSize: 12, fontFamily: 'inherit' }} />
      </div>
      {category === 'commander' && cmdStep === 'deck' && (
        <div style={{ padding: '6px 12px', borderBottom: '1px solid var(--border)', flexShrink: 0 }}>
          <button onClick={() => { setCmdStep('set'); setCmdSet(null); setDecks([]); setSearch('') }} style={{ background: 'none', border: 'none', color: 'var(--primary)', fontSize: 12, cursor: 'pointer', fontFamily: 'inherit', padding: 0 }}>← All sets</button>
          <div style={{ fontSize: 11, color: 'var(--text-dim)', marginTop: 2, fontWeight: 600 }}>{cmdSet?.name}</div>
        </div>
      )}
      <div style={{ overflowY: 'auto', flex: 1 }}>
        {category === 'commander' && cmdStep === 'deck' && cmdSet && (
          decksLoading ? (
            <div style={{ padding: 16, color: 'var(--text-dim)', fontSize: 12, textAlign: 'center' }}>Loading…</div>
          ) : (
            <>
              <DeckRow label="All decks in set" sublabel={`Identify cards from any deck in ${cmdSet.code.toUpperCase()}`} onClick={() => handleSelectDeck(cmdSet, null)} />
              {filteredDecks.length === 0 && <div style={{ padding: '8px 16px', color: 'var(--text-dim)', fontSize: 12 }}>No commander decks found for this set</div>}
              {filteredDecks.map(d => <DeckRow key={d.id} label={d.name} sublabel={d.qualifier ?? undefined} imageUrl={d.image_url ?? undefined} onClick={() => handleSelectDeck(cmdSet, d)} />)}
            </>
          )
        )}
        {(category === 'set' || (category === 'commander' && cmdStep === 'set')) && (
          setsLoading ? (
            <div style={{ padding: 16, color: 'var(--text-dim)', fontSize: 12, textAlign: 'center' }}>Loading…</div>
          ) : filteredSets.length === 0 ? (
            <div style={{ padding: 16, color: 'var(--text-dim)', fontSize: 12, textAlign: 'center' }}>No sets found</div>
          ) : filteredSets.map(s => {
            const isSelected = category === 'set' && s.code === selectedCode
            return (
              <div key={s.id} onClick={() => category === 'set' ? handleSelectSet(s) : handlePickCmdSet(s)} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '8px 12px', cursor: 'pointer', background: isSelected ? 'rgba(99,102,241,0.12)' : 'transparent', borderLeft: isSelected ? '2px solid var(--primary)' : '2px solid transparent' }} onMouseEnter={e => { e.currentTarget.style.background = 'rgba(255,255,255,0.05)' }} onMouseLeave={e => { e.currentTarget.style.background = isSelected ? 'rgba(99,102,241,0.12)' : 'transparent' }}>
                {s.image_url && <img src={s.image_url} alt="" style={{ width: 20, height: 20, objectFit: 'contain', flexShrink: 0, opacity: 0.8 }} />}
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 12, fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{s.name}</div>
                  <div style={{ fontSize: 10, color: 'var(--text-dim)' }}>{s.code.toUpperCase()}{s.card_count != null ? ` · ${s.card_count} cards` : ''}{s.release_date ? ` · ${s.release_date.slice(0, 7)}` : ''}</div>
                </div>
                {category === 'commander' && <span style={{ color: 'var(--text-dim)', fontSize: 12, flexShrink: 0 }}>›</span>}
              </div>
            )
          })
        )}
      </div>
      {selectedCode && (
        <div style={{ padding: '8px 12px', borderTop: '1px solid var(--border)', flexShrink: 0 }}>
          <button onClick={() => { clearSelection(); setOpen(false); setDropPos(null) }} style={{ width: '100%', background: 'none', border: '1px solid var(--border)', borderRadius: 5, color: 'var(--text-dim)', padding: '4px 0', fontSize: 11, cursor: 'pointer', fontFamily: 'inherit' }}>Clear selection</button>
        </div>
      )}
    </div>
  )

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
      <ToggleGroup options={[{ value: 'mtg', label: 'MTG' }, { value: 'pokemon', label: 'Pokémon' }]} active={game} onChange={v => handleGameSwitch(v as PickerGame)} activeColor="var(--primary)" />
      {game === 'mtg' && (
        <ToggleGroup options={[{ value: 'set', label: 'Set' }, { value: 'commander', label: 'Commander' }]} active={category} onChange={v => handleCategorySwitch(v as PickerCategory)} activeColor="var(--purple)" />
      )}
      <button ref={btnRef} onClick={handleToggle} style={{ display: 'flex', alignItems: 'center', gap: 8, background: selectedCode ? 'rgba(99,102,241,0.15)' : 'var(--surface-2)', border: `1px solid ${selectedCode ? 'var(--primary)' : 'var(--border)'}`, borderRadius: 6, color: 'var(--text)', padding: '5px 10px', fontSize: 13, cursor: 'pointer', minWidth: 180, maxWidth: 320, fontFamily: 'inherit' }}>
        <span style={{ flex: 1, textAlign: 'left', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {selectedCode ? (
            <><span style={{ color: 'var(--text-dim)', fontSize: 11 }}>{selectedCode} · </span>{selectedName}{selectedDeck && <span style={{ color: 'var(--text-dim)', fontSize: 11 }}> — {selectedDeck}</span>}</>
          ) : (
            <span style={{ color: 'var(--text-dim)' }}>{category === 'commander' ? 'Select commander deck…' : 'Select a set…'}</span>
          )}
        </span>
        <span style={{ color: 'var(--text-dim)', fontSize: 10, flexShrink: 0 }}>{open ? '▲' : '▼'}</span>
      </button>
      {open && createPortal(dropdown, document.body)}
    </div>
  )
}

// ─── Main App ─────────────────────────────────────────────────────────────────

export default function App() {
  const [entries, setEntries] = useState<BreakEntry[]>([])
  const [setCode, setSetCode] = useState('')
  const [setName, setSetName] = useState('')
  const [deckName, setDeckName] = useState('')
  const [imgScale, setImgScale] = useState<1 | 2 | 4>(1)

  const entriesRef = useRef<BreakEntry[]>([])
  const setCodeRef = useRef('')
  const setNameRef = useRef('')
  const activeScans = useRef(0)
  const queueRef = useRef<string[]>([])

  useEffect(() => { entriesRef.current = entries }, [entries])
  useEffect(() => { setCodeRef.current = setCode }, [setCode])
  useEffect(() => { setNameRef.current = setName }, [setName])

  const patchEntry = useCallback((id: string, patch: Partial<BreakEntry>) => {
    setEntries(prev => {
      const next = prev.map(e => (e.id === id ? { ...e, ...patch } : e))
      entriesRef.current = next
      return next
    })
  }, [])

  async function findPrecedingFront(beforeIdx: number): Promise<BreakEntry | null> {
    for (let i = beforeIdx - 1; i >= 0; i--) {
      const snapshot = entriesRef.current[i]
      if (!snapshot) continue
      if (snapshot.status === 'back_detected' || snapshot.status === 'error') continue
      if (snapshot.status === 'done') return snapshot
      if (snapshot.status === 'identifying' || snapshot.status === 'queued') {
        const deadline = Date.now() + BACK_WAIT_TIMEOUT
        while (Date.now() < deadline) {
          await new Promise<void>(r => setTimeout(r, BACK_WAIT_POLL))
          const current = entriesRef.current.find(x => x.id === snapshot.id)
          if (current?.status === 'done') return current
          if (current?.status === 'error' || current?.status === 'back_detected') break
        }
        break
      }
    }
    return null
  }

  const processNext = useCallback(() => {
    if (activeScans.current >= MAX_CONCURRENT) return
    if (queueRef.current.length === 0) return
    const id = queueRef.current.shift()!
    activeScans.current++
    const myIndex = entriesRef.current.findIndex(e => e.id === id)
    const file = entriesRef.current[myIndex]?.file
    if (!file) { activeScans.current--; processNext(); return }
    patchEntry(id, { status: 'identifying' })
    callIdentifyApi(file, setNameRef.current)
      .then(async (res: ApiResponse) => {
        if (res.confidence === 'back' || res.back_detected) {
          const preceding = await findPrecedingFront(myIndex)
          patchEntry(id, { status: 'back_detected', confidence: 'back', scanUrl: res.front_image, pairedFrontId: preceding?.id })
        } else {
          const top = res.candidates?.[0]
          const cardName = top?.name
          patchEntry(id, {
            status: 'done', confidence: res.confidence, needsReview: res.needs_review,
            scanUrl: res.front_image, tcgplayerId: top?.tcgplayer_product_id,
            cardName, cardNumber: cardName ? extractCardNumber(cardName) : undefined,
            setName: top?.set_name, candidateImageUrl: top?.image_url,
            allCandidates: res.candidates,
          })
        }
      })
      .catch((err: unknown) => {
        const msg = err instanceof Error ? err.message : String(err)
        patchEntry(id, { status: 'error', errorMsg: msg })
      })
      .finally(() => { activeScans.current--; processNext() })
  }, [patchEntry])

  function addFiles(files: File[]) {
    const newEntries: BreakEntry[] = files.map(file => ({ id: makeId(), file, previewUrl: URL.createObjectURL(file), status: 'queued' as const }))
    setEntries(prev => { const next = [...prev, ...newEntries]; entriesRef.current = next; return next })
    for (const e of newEntries) queueRef.current.push(e.id)
    const slots = MAX_CONCURRENT - activeScans.current
    for (let i = 0; i < slots; i++) processNext()
  }

  function handleOverride(id: string, name: string) {
    patchEntry(id, { overrideName: name.trim() || undefined })
  }

  function handleCorrect(id: string, candidate: ApiCandidate) {
    patchEntry(id, {
      tcgplayerId: candidate.tcgplayer_product_id,
      cardName: candidate.name,
      cardNumber: extractCardNumber(candidate.name),
      setName: candidate.set_name,
      candidateImageUrl: candidate.image_url,
      overrideName: undefined,
      needsReview: false,
      confidence: 'high',
    })
  }

  const completedCount = entries.filter(e => e.status === 'done' || e.status === 'back_detected').length
  const cards = groupEntries(entries)

  useEffect(() => { return () => { for (const e of entriesRef.current) URL.revokeObjectURL(e.previewUrl) } }, [])

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', overflow: 'hidden' }}>
      {/* ── Top bar ── */}
      <header style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '10px 16px', borderBottom: '1px solid var(--border)', background: 'var(--surface)', flexShrink: 0, flexWrap: 'wrap' }}>
        <h1 style={{ fontSize: 16, fontWeight: 700, color: 'var(--primary)', marginRight: 4, whiteSpace: 'nowrap' }}>Box Break Scanner</h1>
        <SetPicker
          selectedCode={setCode}
          onSelect={(code, name, _game, deck) => { setSetCode(code); setSetName(name); setDeckName(deck ?? ''); setCodeRef.current = code; setNameRef.current = name }}
        />
        {setCode && (
          <span style={{ color: 'var(--text-dim)', fontSize: 12, whiteSpace: 'nowrap' }}>
            · restricted to {deckName ? `${deckName} (${setCode})` : setName || setCode}
          </span>
        )}
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginLeft: 'auto' }}>
          <span style={{ fontSize: 11, color: 'var(--text-dim)' }}>Size:</span>
          <ToggleGroup
            options={[{ value: '1', label: '1×' }, { value: '2', label: '2×' }, { value: '4', label: '4×' }]}
            active={String(imgScale)}
            onChange={v => setImgScale(Number(v) as 1 | 2 | 4)}
            activeColor="var(--primary)"
          />
        </div>
        <span style={{ color: 'var(--text-dim)', fontSize: 12, whiteSpace: 'nowrap' }}>{completedCount} / {entries.length} processed</span>
        <button
          disabled={completedCount === 0}
          onClick={() => downloadCSV(buildCSV(entries))}
          style={{ background: completedCount === 0 ? 'var(--surface-2)' : 'var(--primary)', border: 'none', borderRadius: 6, color: completedCount === 0 ? 'var(--text-dim)' : '#fff', padding: '6px 16px', fontSize: 13, fontWeight: 600, cursor: completedCount === 0 ? 'not-allowed' : 'pointer' }}
        >
          Export CSV
        </button>
      </header>

      {/* ── Body ── */}
      <div style={{ display: 'flex', flex: 1, overflow: 'hidden' }}>
        {/* Left: identified cards */}
        <main style={{ flex: 1, minWidth: 0, overflowY: 'auto', padding: 16 }}>
          {cards.length === 0 ? (
            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', height: '100%', color: 'var(--text-dim)', gap: 8 }}>
              <div style={{ fontSize: 48, opacity: 0.3 }}>🃏</div>
              <div style={{ fontSize: 15 }}>Drop card scans to get started</div>
              <div style={{ fontSize: 12 }}>Identified cards will appear here, grouped by card</div>
            </div>
          ) : (
            <>
              <div style={{ fontSize: 11, color: 'var(--text-dim)', marginBottom: 12, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.06em' }}>
                {cards.length} unique card{cards.length !== 1 ? 's' : ''} · {cards.reduce((a, c) => a + c.instances.length, 0)} total copies
              </div>
              {cards.map(card => <CardRow key={card.key} card={card} imgScale={imgScale} />)}
            </>
          )}
        </main>

        {/* Right: drop zone + queue */}
        <aside style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', borderLeft: '1px solid var(--border)', background: 'var(--surface)' }}>
          <div style={{ padding: 12, borderBottom: '1px solid var(--border)', flexShrink: 0 }}>
            <DropZone onFiles={addFiles} />
          </div>
          <div style={{ flex: 1, overflowY: 'auto', padding: '0 12px' }}>
            {entries.length === 0 ? (
              <div style={{ textAlign: 'center', color: 'var(--text-dim)', fontSize: 12, padding: '24px 0' }}>No images yet</div>
            ) : (
              [...entries].reverse().map(e => (
                <QueueItem key={e.id} entry={e} onOverride={handleOverride} onCorrect={handleCorrect} imgScale={imgScale} />
              ))
            )}
          </div>
        </aside>
      </div>
    </div>
  )
}
