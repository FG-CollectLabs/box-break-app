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

type PricePoint = 'tcgplayer_market' | 'ebay' | 'manapool'
type Condition = 'Near Mint' | 'Lightly Played' | 'Moderately Played'

interface PricingConfig {
  pricePoint: PricePoint
  markupPct: number
}

interface PricingSettings {
  tcgplayer: PricingConfig  // MTG, Pokémon — primary marketplace is TCGPlayer
  other: PricingConfig      // FaB, etc. — prefer eBay sold data
  condition: Condition
}

interface ApiCandidate {
  tcgplayer_product_id: number
  image_url: string
  phash: string
  hamming_distance: number
  name: string
  set_name: string
}

interface CardPrice {
  tcgplayer: number
  manapool: number
  ebay: number
}

interface Bin {
  id: string
  name: string
}

type MTGProductType = 'play' | 'collector' | 'commander' | 'jumpstart'

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
  accepted?: boolean
  price?: CardPrice
  binId?: string
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
  price?: CardPrice
}

interface DeckComponent {
  display_key: string
  qty: number
  name?: string
  tcgplayer_product_id?: string
  finish?: string
}

interface DeckManifest {
  key: string
  name: string
  set_code: string
  tcg_set_name?: string
  components: DeckComponent[]
}

// ─── Constants ───────────────────────────────────────────────────────────────

// ─── Pricing helpers ─────────────────────────────────────────────────────────

const DEFAULT_PRICING_SETTINGS: PricingSettings = {
  tcgplayer: { pricePoint: 'tcgplayer_market', markupPct: 0 },
  other:      { pricePoint: 'ebay',            markupPct: 0 },
  condition:  'Near Mint',
}

function loadPricingSettings(): PricingSettings {
  try {
    const raw = localStorage.getItem('boxBreakPricingSettings')
    if (raw) return { ...DEFAULT_PRICING_SETTINGS, ...JSON.parse(raw) }
  } catch { /* ignore */ }
  return DEFAULT_PRICING_SETTINGS
}

function savePricingSettings(s: PricingSettings) {
  localStorage.setItem('boxBreakPricingSettings', JSON.stringify(s))
}

// Picks the base price from a CardPrice according to settings, returns 0 if unavailable.
function computeListPrice(price: CardPrice | undefined, game: string, settings: PricingSettings): number {
  if (!price) return 0
  const cfg = (game === 'fab') ? settings.other : settings.tcgplayer
  let base = 0
  switch (cfg.pricePoint) {
    case 'tcgplayer_market': base = price.tcgplayer || price.ebay || price.manapool; break
    case 'ebay':             base = price.ebay || price.tcgplayer || price.manapool; break
    case 'manapool':         base = price.manapool || price.tcgplayer || price.ebay; break
  }
  if (base <= 0) return 0
  return Math.round(base * (1 + cfg.markupPct / 100))
}

const EV_API = 'https://ev-api.futuregadgetlabs.com'
const IDENTIFY_URL = `${EV_API}/v1/scan/identify`
const CATALOG_URL = `${EV_API}/v1/scan/catalog`
const PURGE_SCANS_URL = `${EV_API}/v1/scan/scans`
const INVENTORY_API = 'https://inventory-api.futuregadgetlabs.com'
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

async function callIdentifyApi(file: File, setCode: string, game: string): Promise<ApiResponse> {
  const fd = new FormData()
  fd.append('image', file)
  // restrict_set and game must be form fields — ev-api proxies the body but strips query params
  if (setCode.trim()) fd.append('restrict_set', setCode.trim())
  if (game) fd.append('game', game)
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
  const rows: string[] = ['card_name,card_number,set_name,tcgplayer_id,quantity,front_image_urls,back_image_urls,stock_image_url']
  const q = (s: string) => `"${s.replace(/"/g, '""')}"`
  for (const card of cards) {
    const fronts = card.instances.map(i => i.front.scanUrl ?? '').join('|')
    const backs = card.instances.map(i => i.back?.scanUrl ?? '').join('|')
    const stockUrl = card.instances[0]?.front.candidateImageUrl ?? ''
    rows.push([q(card.cardName), q(card.cardNumber ?? ''), q(card.setName ?? ''), card.tcgplayerId?.toString() ?? '', card.instances.length.toString(), q(fronts), q(backs), q(stockUrl)].join(','))
  }
  return rows.join('\n')
}

// Quick-export: build TCGPlayer CSV directly from a deck manifest (no scanning needed).
// Used for commander decks where the card list is fixed and known.
function buildManifestTCGPlayerCSV(manifest: DeckManifest, settings: PricingSettings): string {
  const rows: string[] = ['Quantity,Product Name,Set Name,Number,TCGplayer Id,Condition,Printing']
  const q = (s: string) => `"${s.replace(/"/g, '""')}"`
  const tcgSetName = manifest.tcg_set_name ?? manifest.name
  for (const comp of manifest.components) {
    const printing = comp.finish === 'f' ? 'Foil' : 'Normal'
    rows.push([
      comp.qty.toString(),
      q(comp.name ?? comp.display_key),
      q(tcgSetName),
      '',
      comp.tcgplayer_product_id ?? '',
      q(settings.condition),
      q(printing),
    ].join(','))
  }
  return rows.join('\n')
}

function buildTCGPlayerCSV(entries: BreakEntry[], settings: PricingSettings, game: string, evCalcPrices: Map<number, number> = new Map()): string {
  const cards = groupEntries(entries)
  const rows: string[] = ['Quantity,Product Name,Set Name,Number,TCGplayer Id,Condition,Printing,My Price']
  const q = (s: string) => `"${s.replace(/"/g, '""')}"`
  for (const card of cards) {
    const isFoil = card.cardName?.toLowerCase().includes('foil')
    const price = card.instances[0]?.front.price
    // EV-calc CSV price takes precedence over computed price
    const evCents = card.tcgplayerId ? (evCalcPrices.get(card.tcgplayerId) ?? 0) : 0
    const listCents = evCents > 0 ? evCents : computeListPrice(price, game, settings)
    const listPrice = listCents > 0 ? (listCents / 100).toFixed(2) : ''
    rows.push([
      card.instances.length.toString(),
      q(card.cardName),
      q(card.setName ?? ''),
      q(card.cardNumber ?? ''),
      card.tcgplayerId?.toString() ?? '',
      q(settings.condition),
      q(isFoil ? 'Foil' : 'Normal'),
      listPrice,
    ].join(','))
  }
  return rows.join('\n')
}

function buildInventoryCSV(entries: BreakEntry[], bins: Bin[], evCalcPrices: Map<number, number>, listingPlatform: string): string {
  const rows: string[] = ['card_name,set_name,tcgplayer_id,quantity,bin,listing_price,listing_platform,front_scan_urls,stock_image_url']
  const q = (s: string) => `"${s.replace(/"/g, '""')}"`
  const binMap = new Map<string, string>(bins.map(b => [b.id, b.name]))
  // Group by (tcgplayerId or cardName) + binId
  const grouped = new Map<string, { cardName: string; setName: string; tcgplayerId?: number; scanUrls: string[]; stockUrl: string; binName: string; qty: number }>()
  for (const e of entries) {
    if (e.status !== 'done') continue
    const displayName = e.overrideName ?? e.cardName ?? 'Unknown'
    const cardKey = e.tcgplayerId ? e.tcgplayerId.toString() : displayName
    const binId = e.binId ?? bins[0]?.id ?? 'default'
    const key = `${cardKey}::${binId}`
    if (!grouped.has(key)) {
      grouped.set(key, { cardName: displayName, setName: e.setName ?? '', tcgplayerId: e.tcgplayerId, scanUrls: [], stockUrl: e.candidateImageUrl ?? '', binName: binMap.get(binId) ?? binId, qty: 0 })
    }
    const g = grouped.get(key)!
    g.qty++
    if (e.scanUrl) g.scanUrls.push(e.scanUrl)
    if (!g.stockUrl && e.candidateImageUrl) g.stockUrl = e.candidateImageUrl
  }
  for (const g of grouped.values()) {
    const evCents = g.tcgplayerId ? (evCalcPrices.get(g.tcgplayerId) ?? 0) : 0
    const listingPrice = evCents > 0 ? (evCents / 100).toFixed(2) : ''
    rows.push([q(g.cardName), q(g.setName), g.tcgplayerId?.toString() ?? '', g.qty.toString(), q(g.binName), listingPrice, q(listingPlatform), q(g.scanUrls.join('|')), q(g.stockUrl)].join(','))
  }
  return rows.join('\n')
}

function downloadCSV(csv: string, filename?: string) {
  const blob = new Blob([csv], { type: 'text/csv' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename ?? `break-export-${Date.now()}.csv`
  a.click()
  URL.revokeObjectURL(url)
}

function fmtPrice(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`
}

function parseCSVRow(line: string): string[] {
  const cols: string[] = []
  let cur = '', inQuote = false
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]
    if (ch === '"') {
      if (inQuote && line[i + 1] === '"') { cur += '"'; i++ }
      else inQuote = !inQuote
    } else if (ch === ',' && !inQuote) {
      cols.push(cur); cur = ''
    } else {
      cur += ch
    }
  }
  cols.push(cur)
  return cols
}

// Parses an EV-calc CSV with headers: TCGplayer Id, Card Name, Listing Price
// Returns a map of productId → listing price in cents.
function parseEvCalcCSV(text: string): Map<number, number> {
  const prices = new Map<number, number>()
  const lines = text.split('\n').map(l => l.trim()).filter(Boolean)
  if (lines.length < 2) return prices
  const header = parseCSVRow(lines[0]).map(h => h.toLowerCase())
  const idCol = header.findIndex(h => h.includes('tcgplayer') && (h.includes('id') || h.includes('#')))
  const priceCol = header.findIndex(h => h.includes('listing') || h.includes('price'))
  if (idCol < 0 || priceCol < 0) return prices
  for (let i = 1; i < lines.length; i++) {
    const cols = parseCSVRow(lines[i])
    const id = parseInt(cols[idCol] ?? '')
    const price = parseFloat(cols[priceCol] ?? '')
    if (!isNaN(id) && id > 0 && !isNaN(price) && price > 0) {
      prices.set(id, Math.round(price * 100))
    }
  }
  return prices
}

// ─── EV-calc CSV drop zone ────────────────────────────────────────────────────

function EvCalcDropZone({ filename, onFile }: { filename: string; onFile: (name: string, prices: Map<number, number>) => void }) {
  const [dragging, setDragging] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)

  async function handleFile(file: File) {
    const text = await file.text()
    onFile(file.name, parseEvCalcCSV(text))
  }

  return (
    <div
      onDragOver={e => { e.preventDefault(); setDragging(true) }}
      onDragLeave={() => setDragging(false)}
      onDrop={e => { e.preventDefault(); setDragging(false); const f = e.dataTransfer.files[0]; if (f?.name.endsWith('.csv')) handleFile(f) }}
      onClick={() => inputRef.current?.click()}
      title="Drop the EV-calc pricing CSV here"
      style={{ border: `1px dashed ${dragging ? 'var(--warning)' : filename ? 'var(--success)' : 'var(--border)'}`, borderRadius: 6, padding: '8px 12px', cursor: 'pointer', background: dragging ? 'rgba(251,191,36,0.08)' : filename ? 'rgba(34,197,94,0.06)' : 'transparent', transition: 'all 0.15s' }}
    >
      {filename ? (
        <div style={{ fontSize: 11, color: 'var(--success)', fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>✓ {filename}</div>
      ) : (
        <div style={{ fontSize: 11, color: 'var(--text-dim)', textAlign: 'center' }}>📄 Drop EV-calc CSV</div>
      )}
      <input ref={inputRef} type="file" accept=".csv" style={{ display: 'none' }} onChange={e => { const f = e.target.files?.[0]; if (f) handleFile(f); e.target.value = '' }} />
    </div>
  )
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
  filterSetName,
  onSelect,
  onOverride,
  onClose,
}: {
  entry: BreakEntry
  filterSetName?: string
  onSelect: (candidate: ApiCandidate) => void
  onOverride: (name: string) => void
  onClose: () => void
}) {
  const [search, setSearch] = useState('')
  const [overrideVal, setOverrideVal] = useState(entry.overrideName ?? entry.cardName ?? '')
  const [liveResults, setLiveResults] = useState<ApiCandidate[] | null>(null)
  const [liveLoading, setLiveLoading] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const localCandidates = entry.allCandidates ?? []

  // Live catalog search when query >= 2 chars
  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current)
    if (search.length < 2) { setLiveResults(null); return }
    debounceRef.current = setTimeout(async () => {
      setLiveLoading(true)
      try {
        const params = new URLSearchParams({ q: search, limit: '20' })
        if (filterSetName) params.set('set_name', filterSetName)
        const res = await fetch(`${CATALOG_URL}?${params}`)
        if (!res.ok) throw new Error()
        const data = await res.json() as { results: ApiCandidate[] }
        setLiveResults(data.results ?? [])
      } catch {
        setLiveResults(null)
      } finally {
        setLiveLoading(false)
      }
    }, 300)
    return () => { if (debounceRef.current) clearTimeout(debounceRef.current) }
  }, [search, filterSetName])

  // In a set-restricted session, hide "(Surge Foil)" variants — they're a separate
  // premium product and shouldn't appear in a standard commander deck break.
  const filterSurge = (list: ApiCandidate[]) =>
    filterSetName ? list.filter(c => !c.name.includes('(Surge Foil)')) : list

  const displayed = search.length >= 2
    ? filterSurge(liveResults ?? localCandidates.filter(c => c.name.toLowerCase().includes(search.toLowerCase()) || c.set_name.toLowerCase().includes(search.toLowerCase())))
    : filterSurge(localCandidates)

  useEffect(() => {
    inputRef.current?.focus()
  }, [])

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { onClose(); return }
      const n = parseInt(e.key)
      if (!isNaN(n) && n >= 1 && n <= 9) {
        const c = displayed[n - 1]
        if (c) onSelect(c)
      }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [displayed, onSelect, onClose])

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
        placeholder="Type to search all cards… (1–9 to pick, Esc to close)"
        style={{ width: '100%', background: 'var(--bg)', border: '1px solid var(--border)', borderRadius: 6, color: 'var(--text)', padding: '7px 10px', fontSize: 13, fontFamily: 'inherit', marginBottom: 12 }}
      />

      {/* Candidates grid */}
      {liveLoading && <div style={{ fontSize: 12, color: 'var(--text-dim)', padding: '4px 0 8px' }}>Searching…</div>}
      {!liveLoading && displayed.length === 0 && search.length < 2 && localCandidates.length === 0 && (
        <div style={{ fontSize: 12, color: 'var(--text-dim)', padding: '12px 0' }}>No candidates — type a name to search all cards</div>
      )}
      {!liveLoading && displayed.length === 0 && search.length >= 2 && (
        <div style={{ fontSize: 12, color: 'var(--text-dim)', padding: '12px 0' }}>No matches for "{search}"</div>
      )}
      {displayed.length > 0 && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, maxHeight: 420, overflowY: 'auto', marginBottom: 12 }}>
          {displayed.map((c, i) => (
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
                src={c.image_url || `https://tcgplayer-cdn.tcgplayer.com/product/${c.tcgplayer_product_id}_in_1000x1000.jpg`}
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

// ─── Queue Item (compact status row for right panel) ─────────────────────────

function QueueItem({ entry }: { entry: BreakEntry }) {
  return (
    <div style={{ display: 'flex', gap: 8, alignItems: 'center', padding: '5px 0', borderBottom: '1px solid var(--border)' }}>
      <img src={entry.previewUrl} alt="" style={{ width: 32, height: 45, objectFit: 'cover', borderRadius: 3, border: '1px solid var(--border)', flexShrink: 0 }} />
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 10, color: 'var(--text-dim)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{entry.file.name}</div>
        <StatusChip status={entry.status} />
        {(entry.status === 'done') && (
          <div style={{ fontSize: 10, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: entry.accepted ? 'var(--success)' : 'var(--text)' }}>
            {entry.accepted ? '✓ ' : ''}{entry.overrideName ?? entry.cardName ?? ''}
          </div>
        )}
      </div>
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

// ─── Review Card (left panel per-scan acceptance flow) ───────────────────────

function ReviewCard({
  entry,
  allEntries,
  filterSetName,
  onAccept,
  onCorrect,
  onOverride,
  imgScale = 2,
  pricingSettings,
  game,
}: {
  entry: BreakEntry
  allEntries: BreakEntry[]
  filterSetName?: string
  onAccept: (id: string) => void
  onCorrect: (id: string, candidate: ApiCandidate) => void
  onOverride: (id: string, name: string) => void
  imgScale?: 2 | 4
  pricingSettings: PricingSettings
  game: string
}) {
  const [correcting, setCorrecting] = useState(false)
  const rw = 120 * imgScale, rh = Math.round(rw * 1.4)

  // ── Accepted: collapsed row ──
  if (entry.accepted && entry.status === 'done') {
    return (
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '4px 8px', marginBottom: 4, border: '1px solid var(--success)', borderRadius: 6, background: 'rgba(34,197,94,0.06)', cursor: 'pointer' }} onClick={() => onAccept(entry.id)} title="Click to un-accept">
        <img src={entry.previewUrl} alt="" style={{ width: 28, height: 40, objectFit: 'cover', borderRadius: 3, flexShrink: 0 }} />
        <span style={{ color: 'var(--success)', fontWeight: 700, flexShrink: 0, fontSize: 14 }}>✓</span>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 12, fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{entry.overrideName ?? entry.cardName}</div>
          <div style={{ fontSize: 10, color: 'var(--text-dim)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{entry.setName}</div>
        </div>
        <span style={{ fontSize: 10, color: 'var(--text-dim)', flexShrink: 0 }}>↩ undo</span>
      </div>
    )
  }

  // ── Back detected: auto-collapsed ──
  if (entry.status === 'back_detected') {
    const front = allEntries.find(e => e.id === entry.pairedFrontId)
    return (
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '4px 8px', marginBottom: 4, border: '1px solid var(--border)', borderRadius: 6, opacity: 0.55 }}>
        <img src={entry.previewUrl} alt="" style={{ width: 28, height: 40, objectFit: 'cover', borderRadius: 3, flexShrink: 0 }} />
        <span style={{ fontSize: 10, color: 'var(--purple)' }}>📷 back{front?.cardName ? ` · ${front.cardName}` : ''}</span>
      </div>
    )
  }

  // ── In-progress ──
  if (entry.status === 'queued' || entry.status === 'identifying') {
    return (
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', padding: '8px 10px', marginBottom: 6, border: '1px solid var(--border)', borderRadius: 6 }}>
        <img src={entry.previewUrl} alt="" style={{ width: 40, height: 56, objectFit: 'cover', borderRadius: 4, flexShrink: 0 }} />
        <div><StatusChip status={entry.status} /><div style={{ fontSize: 10, color: 'var(--text-dim)', marginTop: 3 }}>{entry.file.name}</div></div>
      </div>
    )
  }

  // ── Full review card (done or error) ──
  const canCorrect = entry.status === 'done' || entry.status === 'error'
  return (
    <div style={{ border: `1px solid ${entry.status === 'error' ? 'var(--danger)' : entry.needsReview ? 'var(--warning)' : 'var(--border)'}`, borderRadius: 8, marginBottom: 10, background: 'var(--surface)', overflow: 'hidden' }}>
      <div style={{ padding: 12 }}>
        {/* Images row */}
        <div style={{ display: 'flex', gap: 12, alignItems: 'flex-start', marginBottom: 10, flexWrap: 'wrap' }}>
          <div style={{ textAlign: 'center', flexShrink: 0 }}>
            <img src={entry.previewUrl} alt="" style={{ width: rw, height: rh, objectFit: 'contain', borderRadius: 5, border: '2px solid #4ade80', background: '#000', display: 'block' }} />
            <span style={{ fontSize: 9, color: '#4ade80', fontWeight: 600 }}>📷 scan</span>
          </div>
          {entry.candidateImageUrl && (
            <div style={{ textAlign: 'center', flexShrink: 0 }}>
              <img src={entry.candidateImageUrl} alt="" onError={e => { e.currentTarget.style.display = 'none' }} style={{ width: rw, height: rh, objectFit: 'contain', borderRadius: 5, border: '2px solid var(--border)', background: '#000', display: 'block' }} />
              <span style={{ fontSize: 9, color: 'var(--primary)', fontWeight: 600 }}>stock</span>
            </div>
          )}
          {/* Card info + actions */}
          <div style={{ flex: 1, minWidth: 120, display: 'flex', flexDirection: 'column', gap: 6 }}>
            <StatusChip status={entry.status} />
            {entry.status === 'done' && (
              <>
                <div style={{ fontWeight: 700, fontSize: 14, lineHeight: 1.2 }}>{entry.overrideName ?? entry.cardName ?? 'Unknown'}</div>
                <div style={{ fontSize: 12, color: 'var(--text-dim)' }}>{entry.setName}</div>
                {entry.cardNumber && <div style={{ fontSize: 11, color: 'var(--text-dim)' }}>#{entry.cardNumber}</div>}
                {entry.price && (entry.price.tcgplayer > 0 || entry.price.manapool > 0 || entry.price.ebay > 0) && (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 4, marginTop: 2 }}>
                    {/* Recommended list price based on active pricing config */}
                    {(() => {
                      const listCents = computeListPrice(entry.price, game, pricingSettings)
                      const cfg = game === 'fab' ? pricingSettings.other : pricingSettings.tcgplayer
                      const srcLabel = cfg.pricePoint === 'tcgplayer_market' ? 'TCG' : cfg.pricePoint === 'ebay' ? 'eBay' : 'MP'
                      const markupLabel = cfg.markupPct !== 0 ? ` ${cfg.markupPct > 0 ? '+' : ''}${cfg.markupPct}%` : ''
                      return listCents > 0 ? (
                        <div style={{ display: 'flex', alignItems: 'baseline', gap: 6 }}>
                          <span style={{ fontSize: 16, fontWeight: 700, color: 'var(--success)' }}>{fmtPrice(listCents)}</span>
                          <span style={{ fontSize: 10, color: 'var(--text-dim)' }}>from {srcLabel}{markupLabel}</span>
                        </div>
                      ) : null
                    })()}
                    {/* Raw platform prices */}
                    <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                      {entry.price.tcgplayer > 0 && <span style={{ fontSize: 10, background: 'rgba(99,102,241,0.15)', color: 'var(--primary)', borderRadius: 4, padding: '1px 5px', fontWeight: 600 }}>TCG {fmtPrice(entry.price.tcgplayer)}</span>}
                      {entry.price.manapool > 0 && <span style={{ fontSize: 10, background: 'rgba(168,85,247,0.15)', color: 'var(--purple)', borderRadius: 4, padding: '1px 5px', fontWeight: 600 }}>MP {fmtPrice(entry.price.manapool)}</span>}
                      {entry.price.ebay > 0 && <span style={{ fontSize: 10, background: 'rgba(34,197,94,0.15)', color: 'var(--success)', borderRadius: 4, padding: '1px 5px', fontWeight: 600 }}>eBay {fmtPrice(entry.price.ebay)}</span>}
                    </div>
                  </div>
                )}
                <button
                  onClick={() => onAccept(entry.id)}
                  style={{ marginTop: 4, background: 'var(--success)', border: 'none', borderRadius: 6, color: '#fff', padding: '8px 16px', fontSize: 13, fontWeight: 700, cursor: 'pointer', fontFamily: 'inherit' }}
                >
                  ✓ Accept
                </button>
              </>
            )}
            {entry.status === 'error' && (
              <div style={{ fontSize: 11, color: 'var(--danger)', wordBreak: 'break-word' }}>{entry.errorMsg}</div>
            )}
            {canCorrect && (
              <button
                onClick={() => setCorrecting(c => !c)}
                style={{ background: correcting ? 'rgba(99,102,241,0.15)' : 'var(--surface-2)', border: `1px solid ${correcting ? 'var(--primary)' : 'var(--border)'}`, borderRadius: 6, color: correcting ? 'var(--primary)' : 'var(--text-dim)', padding: '6px 12px', fontSize: 12, cursor: 'pointer', fontFamily: 'inherit' }}
              >
                {correcting ? '✕ Close' : '✎ Correct'}
              </button>
            )}
          </div>
        </div>
        {/* Inline correction panel */}
        {correcting && (
          <CorrectionPanel
            entry={entry}
            filterSetName={filterSetName}
            onSelect={c => { onCorrect(entry.id, c); setCorrecting(false) }}
            onOverride={name => { onOverride(entry.id, name); setCorrecting(false) }}
            onClose={() => setCorrecting(false)}
          />
        )}
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

// ─── Quick Export Panel (commander deck — no scanning needed) ─────────────────

function QuickExportPanel({ manifest, settings, onScanInstead }: {
  manifest: DeckManifest
  settings: PricingSettings
  onScanInstead: () => void
}) {
  const total = manifest.components.reduce((s, c) => s + c.qty, 0)
  const foilCount = manifest.components.filter(c => c.finish === 'f').reduce((s, c) => s + c.qty, 0)

  return (
    <div style={{ padding: '20px 24px', display: 'flex', flexDirection: 'column', gap: 16, maxWidth: 560 }}>
      {/* Deck summary */}
      <div style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 10, padding: '14px 16px', display: 'flex', flexDirection: 'column', gap: 6 }}>
        <div style={{ fontWeight: 700, fontSize: 15 }}>{manifest.name}</div>
        <div style={{ fontSize: 12, color: 'var(--text-dim)' }}>{manifest.tcg_set_name ?? manifest.name}</div>
        <div style={{ display: 'flex', gap: 12, marginTop: 4, fontSize: 12 }}>
          <span style={{ color: 'var(--text-dim)' }}>{total} cards total</span>
          {foilCount > 0 && <span style={{ color: 'var(--purple)' }}>{foilCount} foil</span>}
          <span style={{ color: 'var(--text-dim)' }}>{manifest.components.length} unique</span>
        </div>
      </div>

      {/* Export options */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--text-dim)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>Quick Export</div>

        <button
          onClick={() => downloadCSV(buildManifestTCGPlayerCSV(manifest, settings), `tcgplayer-${manifest.key}-${Date.now()}.csv`)}
          style={{ background: 'var(--primary)', border: 'none', borderRadius: 8, color: '#fff', padding: '10px 18px', fontSize: 13, fontWeight: 700, cursor: 'pointer', fontFamily: 'inherit', textAlign: 'left', display: 'flex', flexDirection: 'column', gap: 2 }}
        >
          <span>TCGPlayer CSV</span>
          <span style={{ fontSize: 10, fontWeight: 400, opacity: 0.8 }}>Mass entry — {total} lines · condition: {settings.condition}</span>
        </button>

        <button
          onClick={() => {
            const rows = ['Product Name,Quantity,Finish']
            const q = (s: string) => `"${s.replace(/"/g, '""')}"`
            for (const comp of manifest.components) {
              rows.push([q(comp.name ?? comp.display_key), comp.qty.toString(), q(comp.finish === 'f' ? 'Foil' : 'Normal')].join(','))
            }
            downloadCSV(rows.join('\n'), `manapool-${manifest.key}-${Date.now()}.csv`)
          }}
          style={{ background: 'rgba(168,85,247,0.15)', border: '1px solid rgba(168,85,247,0.4)', borderRadius: 8, color: 'var(--purple)', padding: '10px 18px', fontSize: 13, fontWeight: 700, cursor: 'pointer', fontFamily: 'inherit', textAlign: 'left', display: 'flex', flexDirection: 'column', gap: 2 }}
        >
          <span>Manapool CSV</span>
          <span style={{ fontSize: 10, fontWeight: 400, opacity: 0.8 }}>Name + quantity + finish · {total} lines</span>
        </button>
      </div>

      {/* Divider */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <div style={{ flex: 1, height: 1, background: 'var(--border)' }} />
        <span style={{ fontSize: 11, color: 'var(--text-dim)' }}>or</span>
        <div style={{ flex: 1, height: 1, background: 'var(--border)' }} />
      </div>

      {/* Scan instead */}
      <button
        onClick={onScanInstead}
        style={{ background: 'transparent', border: '1px solid var(--border)', borderRadius: 8, color: 'var(--text-dim)', padding: '10px 18px', fontSize: 12, cursor: 'pointer', fontFamily: 'inherit' }}
      >
        Scan cards instead → review identifications, get prices per card
      </button>

      {/* Card list preview */}
      <div style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 8, maxHeight: 320, overflowY: 'auto' }}>
        <div style={{ padding: '8px 12px', borderBottom: '1px solid var(--border)', fontSize: 11, fontWeight: 700, color: 'var(--text-dim)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
          Card list ({manifest.components.length} unique)
        </div>
        {manifest.components.map((comp, i) => (
          <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '5px 12px', borderBottom: i < manifest.components.length - 1 ? '1px solid var(--border)' : undefined }}>
            {comp.tcgplayer_product_id && (
              <img
                src={`https://tcgplayer-cdn.tcgplayer.com/product/${comp.tcgplayer_product_id}_in_1000x1000.jpg`}
                alt=""
                onError={e => { e.currentTarget.style.display = 'none' }}
                style={{ width: 24, height: 34, objectFit: 'cover', borderRadius: 2, flexShrink: 0, border: '1px solid var(--border)' }}
              />
            )}
            <div style={{ flex: 1, minWidth: 0 }}>
              <span style={{ fontSize: 12 }}>{comp.name ?? comp.display_key}</span>
              {comp.finish === 'f' && <span style={{ fontSize: 10, color: 'var(--purple)', marginLeft: 6 }}>foil</span>}
            </div>
            {comp.qty > 1 && <span style={{ fontSize: 11, color: 'var(--text-dim)', flexShrink: 0 }}>×{comp.qty}</span>}
          </div>
        ))}
      </div>
    </div>
  )
}

// ─── Pricing Settings Modal ───────────────────────────────────────────────────

function PricingSettingsModal({ settings, onSave, onClose }: {
  settings: PricingSettings
  onSave: (s: PricingSettings) => void
  onClose: () => void
}) {
  const [draft, setDraft] = useState<PricingSettings>(settings)

  const setTCG = (patch: Partial<PricingConfig>) =>
    setDraft(d => ({ ...d, tcgplayer: { ...d.tcgplayer, ...patch } }))
  const setOther = (patch: Partial<PricingConfig>) =>
    setDraft(d => ({ ...d, other: { ...d.other, ...patch } }))

  const labelStyle: React.CSSProperties = { fontSize: 11, color: 'var(--text-dim)', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 4 }
  const sectionStyle: React.CSSProperties = { padding: '12px 14px', background: 'var(--surface-2)', borderRadius: 8, display: 'flex', flexDirection: 'column', gap: 10 }
  const rowStyle: React.CSSProperties = { display: 'flex', flexDirection: 'column', gap: 4 }
  const selectStyle: React.CSSProperties = { background: 'var(--bg)', border: '1px solid var(--border)', borderRadius: 6, color: 'var(--text)', padding: '5px 8px', fontSize: 12, fontFamily: 'inherit', width: '100%' }
  const inputStyle: React.CSSProperties = { ...selectStyle, width: 80 }

  return createPortal(
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.6)', zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center' }} onClick={onClose}>
      <div onClick={e => e.stopPropagation()} style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 12, padding: 20, width: 380, maxWidth: '95vw', display: 'flex', flexDirection: 'column', gap: 16 }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <div style={{ fontWeight: 700, fontSize: 14 }}>Pricing Settings</div>
          <button onClick={onClose} style={{ background: 'transparent', border: 'none', color: 'var(--text-dim)', fontSize: 18, cursor: 'pointer', padding: '0 4px', lineHeight: 1 }}>×</button>
        </div>

        {/* TCGPlayer implementation (MTG, Pokémon) */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--primary)' }}>TCGPlayer (MTG / Pokémon)</div>
          <div style={sectionStyle}>
            <div style={rowStyle}>
              <div style={labelStyle}>Price source</div>
              <select style={selectStyle} value={draft.tcgplayer.pricePoint} onChange={e => setTCG({ pricePoint: e.target.value as PricePoint })}>
                <option value="tcgplayer_market">TCGPlayer Market Price</option>
                <option value="ebay">eBay Sold</option>
                <option value="manapool">Manapool</option>
              </select>
            </div>
            <div style={rowStyle}>
              <div style={labelStyle}>Markup %</div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <input type="number" min="-50" max="200" step="1" style={inputStyle} value={draft.tcgplayer.markupPct} onChange={e => setTCG({ markupPct: Number(e.target.value) })} />
                <span style={{ fontSize: 11, color: 'var(--text-dim)' }}>e.g. 10 = list 10% above source price</span>
              </div>
            </div>
          </div>
        </div>

        {/* Other implementation (FaB, etc.) */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--warning)' }}>Other (FaB / non-TCGPlayer)</div>
          <div style={sectionStyle}>
            <div style={rowStyle}>
              <div style={labelStyle}>Price source</div>
              <select style={selectStyle} value={draft.other.pricePoint} onChange={e => setOther({ pricePoint: e.target.value as PricePoint })}>
                <option value="ebay">eBay Sold</option>
                <option value="tcgplayer_market">TCGPlayer Market Price</option>
                <option value="manapool">Manapool</option>
              </select>
            </div>
            <div style={rowStyle}>
              <div style={labelStyle}>Markup %</div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <input type="number" min="-50" max="200" step="1" style={inputStyle} value={draft.other.markupPct} onChange={e => setOther({ markupPct: Number(e.target.value) })} />
                <span style={{ fontSize: 11, color: 'var(--text-dim)' }}>e.g. -5 = list 5% below source price</span>
              </div>
            </div>
          </div>
        </div>

        {/* Condition */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          <div style={{ fontSize: 12, fontWeight: 700 }}>Default Condition</div>
          <div style={sectionStyle}>
            <div style={rowStyle}>
              <select style={selectStyle} value={draft.condition} onChange={e => setDraft(d => ({ ...d, condition: e.target.value as Condition }))}>
                <option value="Near Mint">Near Mint</option>
                <option value="Lightly Played">Lightly Played</option>
                <option value="Moderately Played">Moderately Played</option>
              </select>
              <div style={{ fontSize: 10, color: 'var(--text-dim)' }}>Used in TCGPlayer CSV export</div>
            </div>
          </div>
        </div>

        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
          <button onClick={onClose} style={{ background: 'var(--surface-2)', border: '1px solid var(--border)', borderRadius: 6, color: 'var(--text)', padding: '6px 16px', fontSize: 12, cursor: 'pointer', fontFamily: 'inherit' }}>Cancel</button>
          <button onClick={() => { onSave(draft); onClose() }} style={{ background: 'var(--primary)', border: 'none', borderRadius: 6, color: '#fff', padding: '6px 16px', fontSize: 12, fontWeight: 700, cursor: 'pointer', fontFamily: 'inherit' }}>Save</button>
        </div>
      </div>
    </div>,
    document.body
  )
}

type PickerGame = 'mtg' | 'pokemon' | 'fab'
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

function SetPicker({ selectedCode, onSelect }: { selectedCode: string; onSelect: (code: string, setName: string, game: string, deckName?: string, deckDisplayKey?: string) => void }) {
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

  const clearSelection = (g = game) => { setSelectedName(''); setSelectedDeck(''); onSelect('', '', g, undefined, undefined) }

  const handleGameSwitch = (g: PickerGame) => {
    setGame(g); setSearch('')
    if (g !== 'mtg') setCategory('set')
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
    onSelect(s.code, s.name, s.game, deck?.name, deck?.display_key)
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
      <ToggleGroup options={[{ value: 'mtg', label: 'MTG' }, { value: 'pokemon', label: 'Pokémon' }, { value: 'fab', label: 'FaB' }]} active={game} onChange={v => handleGameSwitch(v as PickerGame)} activeColor="var(--primary)" />
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

// ─── Set Manifest (all singles in a booster set) ─────────────────────────────

interface CatalogCard {
  tcgplayer_product_id: number
  name: string
  set_name: string
  image_url?: string
  rarity?: string
}

const FAB_RARITY_ORDER: Record<string, number> = { fabled: 0, legendary: 1, majestic: 2, rare: 3, equipment: 4, common: 5, token: 6 }

function rarityOrder(r?: string): number {
  return r ? (FAB_RARITY_ORDER[r.toLowerCase()] ?? 99) : 99
}

function rarityColor(r?: string): string {
  switch (r?.toLowerCase()) {
    case 'fabled':    return '#f59e0b'
    case 'legendary': return '#a855f7'
    case 'majestic':  return '#3b82f6'
    case 'rare':      return '#22c55e'
    case 'equipment': return '#f97316'
    default:          return 'var(--text-dim)'
  }
}

function SetManifest({ setName, scannedIds }: { setName: string; scannedIds: Set<number> }) {
  const [cards, setCards] = useState<CatalogCard[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    if (!setName) return
    setLoading(true)
    const params = new URLSearchParams({ set_name: setName, limit: '500' })
    fetch(`${CATALOG_URL}?${params}`)
      .then(r => r.ok ? r.json() : null)
      .then((d: { results: CatalogCard[] } | null) => {
        if (!d) return
        const sorted = [...(d.results ?? [])].sort((a, b) => {
          const ro = rarityOrder(a.rarity) - rarityOrder(b.rarity)
          return ro !== 0 ? ro : a.name.localeCompare(b.name)
        })
        setCards(sorted)
      })
      .catch(() => {})
      .finally(() => setLoading(false))
  }, [setName])

  const scanned = cards.filter(c => scannedIds.has(c.tcgplayer_product_id)).length

  return (
    <aside style={{ width: 220, flexShrink: 0, display: 'flex', flexDirection: 'column', borderRight: '1px solid var(--border)', background: 'var(--surface)' }}>
      <div style={{ padding: '10px 12px', borderBottom: '1px solid var(--border)', flexShrink: 0 }}>
        <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--text-dim)', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 4 }}>Set Cards</div>
        <div style={{ fontSize: 11, fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{setName}</div>
        {loading ? (
          <div style={{ fontSize: 10, color: 'var(--text-dim)', marginTop: 2 }}>Loading…</div>
        ) : (
          <>
            <div style={{ fontSize: 10, color: 'var(--text-dim)', marginTop: 2 }}>{scanned} / {cards.length} pulled</div>
            <div style={{ marginTop: 6, height: 4, background: 'var(--surface-2)', borderRadius: 2, overflow: 'hidden' }}>
              <div style={{ height: '100%', width: `${cards.length > 0 ? (scanned / cards.length) * 100 : 0}%`, background: 'var(--primary)', borderRadius: 2, transition: 'width 0.3s' }} />
            </div>
          </>
        )}
      </div>
      <div style={{ flex: 1, overflowY: 'auto' }}>
        {!loading && cards.length === 0 && (
          <div style={{ padding: '16px 12px', fontSize: 11, color: 'var(--text-dim)', textAlign: 'center' }}>No card data yet — ingest this set first</div>
        )}
        {cards.map(card => {
          const isScanned = scannedIds.has(card.tcgplayer_product_id)
          const imgUrl = card.image_url || `https://tcgplayer-cdn.tcgplayer.com/product/${card.tcgplayer_product_id}_in_1000x1000.jpg`
          return (
            <div key={card.tcgplayer_product_id} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 10px', borderBottom: '1px solid var(--border)', opacity: isScanned ? 0.45 : 1, transition: 'opacity 0.2s' }}>
              <img src={imgUrl} alt="" onError={e => { e.currentTarget.style.display = 'none' }} style={{ width: 30, height: 42, objectFit: 'cover', borderRadius: 3, flexShrink: 0, border: isScanned ? '1px solid var(--success)' : '1px solid var(--border)' }} />
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 10, fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: isScanned ? 'var(--success)' : 'var(--text)' }}>
                  {isScanned ? '✓ ' : ''}{card.name}
                </div>
                {card.rarity && (
                  <div style={{ fontSize: 9, color: rarityColor(card.rarity), fontWeight: 600 }}>{card.rarity}</div>
                )}
              </div>
            </div>
          )
        })}
      </div>
    </aside>
  )
}

// ─── Deck Checklist ───────────────────────────────────────────────────────────

function DeckChecklist({ manifest, scannedIds, loading }: { manifest: DeckManifest | null; scannedIds: Set<number>; loading: boolean }) {
  if (loading) {
    return (
      <aside style={{ width: 220, flexShrink: 0, display: 'flex', flexDirection: 'column', borderRight: '1px solid var(--border)', background: 'var(--surface)' }}>
        <div style={{ padding: '10px 12px', borderBottom: '1px solid var(--border)', fontSize: 11, fontWeight: 700, color: 'var(--text-dim)', textTransform: 'uppercase', letterSpacing: '0.06em' }}>Deck List</div>
        <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--text-dim)', fontSize: 12 }}>Loading…</div>
      </aside>
    )
  }
  if (!manifest) return null

  const total = manifest.components.reduce((s, c) => s + c.qty, 0)
  const scanned = manifest.components.filter(c => c.tcgplayer_product_id && scannedIds.has(parseInt(c.tcgplayer_product_id))).reduce((s, c) => s + c.qty, 0)

  return (
    <aside style={{ width: 220, flexShrink: 0, display: 'flex', flexDirection: 'column', borderRight: '1px solid var(--border)', background: 'var(--surface)' }}>
      <div style={{ padding: '10px 12px', borderBottom: '1px solid var(--border)', flexShrink: 0 }}>
        <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--text-dim)', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 4 }}>Deck List</div>
        <div style={{ fontSize: 11, color: manifest.name ? 'var(--text)' : 'var(--text-dim)', fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{manifest.name}</div>
        <div style={{ fontSize: 10, color: 'var(--text-dim)', marginTop: 2 }}>{scanned} / {total} cards scanned</div>
        <div style={{ marginTop: 6, height: 4, background: 'var(--surface-2)', borderRadius: 2, overflow: 'hidden' }}>
          <div style={{ height: '100%', width: `${total > 0 ? (scanned / total) * 100 : 0}%`, background: 'var(--primary)', borderRadius: 2, transition: 'width 0.3s' }} />
        </div>
      </div>
      <div style={{ flex: 1, overflowY: 'auto' }}>
        {manifest.components.map((comp, i) => {
          const tcgId = comp.tcgplayer_product_id ? parseInt(comp.tcgplayer_product_id) : null
          const isScanned = tcgId != null && scannedIds.has(tcgId)
          const imgUrl = tcgId ? `https://tcgplayer-cdn.tcgplayer.com/product/${tcgId}_in_1000x1000.jpg` : undefined
          return (
            <div key={`${comp.display_key}-${i}`} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 10px', borderBottom: '1px solid var(--border)', opacity: isScanned ? 0.5 : 1, transition: 'opacity 0.2s' }}>
              {imgUrl ? (
                <img src={imgUrl} alt="" onError={e => { e.currentTarget.style.display = 'none' }} style={{ width: 30, height: 42, objectFit: 'cover', borderRadius: 3, flexShrink: 0, border: isScanned ? '1px solid var(--success)' : '1px solid var(--border)' }} />
              ) : (
                <div style={{ width: 30, height: 42, flexShrink: 0, background: 'var(--surface-2)', borderRadius: 3, border: '1px solid var(--border)' }} />
              )}
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 10, fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: isScanned ? 'var(--success)' : 'var(--text)' }}>
                  {isScanned ? '✓ ' : ''}{comp.name ?? comp.display_key}
                </div>
                {comp.qty > 1 && <div style={{ fontSize: 9, color: 'var(--text-dim)' }}>×{comp.qty}</div>}
                {comp.finish && comp.finish !== 'normal' && <div style={{ fontSize: 9, color: 'var(--purple)' }}>{comp.finish}</div>}
              </div>
            </div>
          )
        })}
      </div>
    </aside>
  )
}

// ─── Main App ─────────────────────────────────────────────────────────────────

export default function App() {
  const [entries, setEntries] = useState<BreakEntry[]>([])
  const [setCode, setSetCode] = useState('')
  const [setName, setSetName] = useState('')
  const [deckName, setDeckName] = useState('')
  const [deckDisplayKey, setDeckDisplayKey] = useState('')
  const [deckManifest, setDeckManifest] = useState<DeckManifest | null>(null)
  const [manifestLoading, setManifestLoading] = useState(false)
  const [imgScale, setImgScale] = useState<2 | 4>(2)
  const [altBackMode, setAltBackMode] = useState(true)
  const [pricingSettings, setPricingSettings] = useState<PricingSettings>(loadPricingSettings)
  const [showPricingModal, setShowPricingModal] = useState(false)

  // Bins
  const [bins, setBins] = useState<Bin[]>([{ id: 'bin_1', name: 'Bin 1' }])
  const [activeBinId, setActiveBinId] = useState('bin_1')
  const [renamingBinId, setRenamingBinId] = useState<string | null>(null)

  // EV-calc CSV
  const [evCalcPrices, setEvCalcPrices] = useState<Map<number, number>>(new Map())
  const [evCalcFilename, setEvCalcFilename] = useState('')

  // MTG product type (commander is inferred from deckDisplayKey being set)
  const [mtgProductType, setMtgProductType] = useState<MTGProductType>('play')
  const [game, setGame] = useState('mtg')
  const altBackModeRef = useRef(false)

  const entriesRef = useRef<BreakEntry[]>([])
  const setCodeRef = useRef('')
  const setNameRef = useRef('')
  const gameRef = useRef('mtg')
  const deckDisplayKeyRef = useRef('')
  const activeScans = useRef(0)
  const queueRef = useRef<string[]>([])

  useEffect(() => { entriesRef.current = entries }, [entries])
  useEffect(() => { setCodeRef.current = setCode }, [setCode])
  useEffect(() => { setNameRef.current = setName }, [setName])
  useEffect(() => { deckDisplayKeyRef.current = deckDisplayKey }, [deckDisplayKey])
  useEffect(() => { altBackModeRef.current = altBackMode }, [altBackMode])

  useEffect(() => {
    // When a commander deck is selected, auto-set product type
    if (deckDisplayKey) setMtgProductType('commander')
  }, [deckDisplayKey])

  useEffect(() => {
    if (!deckDisplayKey) { setDeckManifest(null); return }
    setManifestLoading(true)
    fetch(`${EV_API}/v1/decks/${encodeURIComponent(deckDisplayKey)}`)
      .then(r => r.ok ? r.json() as Promise<DeckManifest> : null)
      .then(manifest => setDeckManifest(manifest))
      .catch(() => setDeckManifest(null))
      .finally(() => setManifestLoading(false))
  }, [deckDisplayKey])

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
    const entry = entriesRef.current[myIndex]
    const file = entry?.file
    if (!file) { activeScans.current--; processNext(); return }
    const wasAltBack = entry?.status === 'back_detected'
    patchEntry(id, { status: 'identifying' })
    // Commander deck breaks span many sets — restricting by set_name would miss reprints.
    // Only use restrict_set for booster/randomized set breaks.
    const restrictSet = deckDisplayKeyRef.current ? '' : setNameRef.current
    callIdentifyApi(file, restrictSet, gameRef.current)
      .then(async (res: ApiResponse) => {
        if (wasAltBack) {
          // Alt-back mode: entry was pre-tagged as a card back — just store the scan URL,
          // ignore what the identify API thinks it is
          patchEntry(id, { status: 'back_detected', confidence: 'back', scanUrl: res.front_image })
          return
        }
        if (res.confidence === 'back' || res.back_detected) {
          const existing = entriesRef.current[myIndex]
          const preceding = await findPrecedingFront(myIndex)
          patchEntry(id, { status: 'back_detected', confidence: 'back', scanUrl: res.front_image, pairedFrontId: existing?.pairedFrontId ?? preceding?.id })
        } else {
          const top = res.candidates?.[0]
          const cardName = top?.name
          patchEntry(id, {
            status: 'done', confidence: res.confidence, needsReview: res.needs_review,
            scanUrl: res.front_image, tcgplayerId: top?.tcgplayer_product_id,
            cardName, cardNumber: cardName ? extractCardNumber(cardName) : undefined,
            setName: top?.set_name, candidateImageUrl: top?.image_url,
            allCandidates: res.candidates, price: res.price,
          })
        }
      })
      .catch((err: unknown) => {
        const msg = err instanceof Error ? err.message : String(err)
        patchEntry(id, { status: 'error', errorMsg: msg })
      })
      .finally(() => { activeScans.current--; processNext() })
  }, [patchEntry])

  function addFiles(files: File[], targetBinId?: string) {
    const binId = targetBinId ?? activeBinId
    const alt = altBackModeRef.current
    const newEntries: BreakEntry[] = files.map((file, i) => ({
      id: makeId(), file, previewUrl: URL.createObjectURL(file),
      status: (alt && i % 2 === 1 ? 'back_detected' : 'queued') as BreakEntry['status'],
      confidence: alt && i % 2 === 1 ? 'back' as const : undefined,
      binId,
    }))
    // Pre-pair backs in alt-back mode
    if (alt) {
      for (let i = 1; i < newEntries.length; i += 2) {
        if (newEntries[i - 1]) newEntries[i].pairedFrontId = newEntries[i - 1].id
      }
    }
    setEntries(prev => { const next = [...prev, ...newEntries]; entriesRef.current = next; return next })
    // Queue all entries — alt-back 'back_detected' entries also need API processing to get a scanUrl
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

  function handleAccept(id: string) {
    const entry = entriesRef.current.find(e => e.id === id)
    patchEntry(id, { accepted: !entry?.accepted, needsReview: false })
  }

  function addBin() {
    const id = `bin_${Date.now()}`
    const n = bins.length + 1
    setBins(b => [...b, { id, name: `Bin ${n}` }])
    setActiveBinId(id)
    setRenamingBinId(id)
  }

  function commitRename(id: string, name: string) {
    setBins(b => b.map(bin => bin.id === id ? { ...bin, name: name.trim() || bin.name } : bin))
    setRenamingBinId(null)
  }

  function removeBin(id: string) {
    const hasEntries = entriesRef.current.some(e => e.binId === id)
    if (hasEntries && !confirm('This bin has scanned cards. Remove it anyway?')) return
    setBins(prev => {
      const next = prev.filter(b => b.id !== id)
      if (activeBinId === id) setActiveBinId(next[0]?.id ?? '')
      return next
    })
  }

  const frontCount = entries.filter(e => e.status === 'done').length
  const acceptedCount = entries.filter(e => e.accepted && e.status === 'done').length
  const scannedIds = new Set(entries.filter(e => e.status === 'done' && e.tcgplayerId).map(e => e.tcgplayerId!))

  const [inventoryPushing, setInventoryPushing] = useState(false)
  const [inventoryToken, setInventoryToken] = useState('')
  const [showInvPush, setShowInvPush] = useState(false)

  async function pushToInventory() {
    if (!inventoryToken) return
    const cards = groupEntries(entries)
    const items = cards.flatMap(card =>
      card.instances.map(inst => ({
        tcgplayer_product_id: card.tcgplayerId,
        card_name: card.cardName,
        set_name: card.setName,
        card_number: card.cardNumber,
        image_url: inst.front.candidateImageUrl ?? null,
        back_image_url: inst.back?.scanUrl ?? null,
        quantity: 1,
        condition: 'NM',
        source: deckName ? `Box Break — ${deckName}` : 'Box Break',
      }))
    )
    setInventoryPushing(true)
    try {
      const res = await fetch(`${INVENTORY_API}/v1/acquisitions/import`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${inventoryToken}` },
        body: JSON.stringify({ items }),
      })
      if (!res.ok) throw new Error(`${res.status}`)
      alert(`Pushed ${items.length} items to inventory.`)
      setShowInvPush(false)
    } catch (e) {
      alert(`Push failed: ${e instanceof Error ? e.message : String(e)}`)
    } finally {
      setInventoryPushing(false)
    }
  }

  useEffect(() => { return () => { for (const e of entriesRef.current) URL.revokeObjectURL(e.previewUrl) } }, [])

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', overflow: 'hidden' }}>
      {showPricingModal && (
        <PricingSettingsModal
          settings={pricingSettings}
          onSave={s => { setPricingSettings(s); savePricingSettings(s) }}
          onClose={() => setShowPricingModal(false)}
        />
      )}
      {/* ── Top bar ── */}
      <header style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '10px 16px', borderBottom: '1px solid var(--border)', background: 'var(--surface)', flexShrink: 0, flexWrap: 'wrap' }}>
        <h1 style={{ fontSize: 16, fontWeight: 700, color: 'var(--primary)', marginRight: 4, whiteSpace: 'nowrap' }}>Box Break Scanner</h1>
        <SetPicker
          selectedCode={setCode}
          onSelect={(code, name, g, deck, displayKey) => {
            setSetCode(code); setSetName(name); setDeckName(deck ?? ''); setDeckDisplayKey(displayKey ?? '')
            setCodeRef.current = code; setNameRef.current = name; gameRef.current = g || 'mtg'
            setGame(g || 'mtg')
          }}
        />
        {game === 'mtg' && !deckDisplayKey && (
          <ToggleGroup
            options={[{ value: 'play', label: 'Play' }, { value: 'collector', label: 'Collector' }, { value: 'jumpstart', label: 'Jumpstart' }]}
            active={mtgProductType === 'commander' ? 'play' : mtgProductType}
            onChange={v => setMtgProductType(v as MTGProductType)}
            activeColor="var(--warning)"
          />
        )}
        {deckDisplayKey && (
          <span style={{ fontSize: 11, background: 'rgba(168,85,247,0.15)', color: 'var(--purple)', border: '1px solid rgba(168,85,247,0.3)', borderRadius: 4, padding: '3px 8px', fontWeight: 600, whiteSpace: 'nowrap' }}>Commander</span>
        )}
        {setCode && (
          <span style={{ color: 'var(--text-dim)', fontSize: 12, whiteSpace: 'nowrap' }}>
            · restricted to {deckName ? `${deckName} (${setCode})` : setName || setCode}
          </span>
        )}
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginLeft: 'auto' }}>
          <button
            onClick={() => setAltBackMode(m => !m)}
            style={{ background: altBackMode ? 'rgba(168,85,247,0.2)' : 'var(--surface-2)', border: `1px solid ${altBackMode ? 'var(--purple)' : 'var(--border)'}`, borderRadius: 6, color: altBackMode ? 'var(--purple)' : 'var(--text-dim)', padding: '5px 10px', fontSize: 11, fontWeight: altBackMode ? 700 : 400, cursor: 'pointer', fontFamily: 'inherit', whiteSpace: 'nowrap' }}
            title="Every other photo is the back of the preceding card"
          >
            {altBackMode ? '⇌ Alt back ON' : '⇌ Alt back'}
          </button>
          <span style={{ fontSize: 11, color: 'var(--text-dim)' }}>Size:</span>
          <ToggleGroup
            options={[{ value: '2', label: '2×' }, { value: '4', label: '4×' }]}
            active={String(imgScale)}
            onChange={v => setImgScale(Number(v) as 2 | 4)}
            activeColor="var(--primary)"
          />
        </div>
        <span style={{ color: 'var(--text-dim)', fontSize: 12, whiteSpace: 'nowrap' }}>{acceptedCount} / {frontCount} accepted</span>
        <button
          disabled={frontCount === 0}
          onClick={() => downloadCSV(buildCSV(entries), `break-${setCode || 'export'}-${Date.now()}.csv`)}
          style={{ background: frontCount === 0 ? 'var(--surface-2)' : 'var(--primary)', border: 'none', borderRadius: 6, color: frontCount === 0 ? 'var(--text-dim)' : '#fff', padding: '6px 14px', fontSize: 12, fontWeight: 600, cursor: frontCount === 0 ? 'not-allowed' : 'pointer' }}
        >
          Export CSV
        </button>
        <button
          disabled={frontCount === 0}
          onClick={() => downloadCSV(buildTCGPlayerCSV(entries, pricingSettings, gameRef.current, evCalcPrices), `tcgplayer-${setCode || 'export'}-${Date.now()}.csv`)}
          style={{ background: frontCount === 0 ? 'var(--surface-2)' : 'rgba(99,102,241,0.2)', border: `1px solid ${frontCount === 0 ? 'var(--border)' : 'var(--primary)'}`, borderRadius: 6, color: frontCount === 0 ? 'var(--text-dim)' : 'var(--primary)', padding: '6px 14px', fontSize: 12, fontWeight: 600, cursor: frontCount === 0 ? 'not-allowed' : 'pointer' }}
        >
          TCGPlayer CSV
        </button>
        <button
          disabled={frontCount === 0}
          onClick={() => downloadCSV(buildInventoryCSV(entries, bins, evCalcPrices, 'tcgplayer'), `inventory-${setCode || 'export'}-${Date.now()}.csv`)}
          style={{ background: frontCount === 0 ? 'var(--surface-2)' : 'rgba(34,197,94,0.15)', border: `1px solid ${frontCount === 0 ? 'var(--border)' : 'var(--success)'}`, borderRadius: 6, color: frontCount === 0 ? 'var(--text-dim)' : 'var(--success)', padding: '6px 14px', fontSize: 12, fontWeight: 600, cursor: frontCount === 0 ? 'not-allowed' : 'pointer' }}
        >
          Inventory CSV
        </button>
        <button
          disabled={frontCount === 0}
          onClick={() => setShowInvPush(p => !p)}
          style={{ background: showInvPush ? 'rgba(168,85,247,0.2)' : 'var(--surface-2)', border: `1px solid ${showInvPush ? 'var(--purple)' : 'var(--border)'}`, borderRadius: 6, color: frontCount === 0 ? 'var(--text-dim)' : showInvPush ? 'var(--purple)' : 'var(--text-dim)', padding: '6px 14px', fontSize: 12, cursor: frontCount === 0 ? 'not-allowed' : 'pointer' }}
        >
          → Inventory
        </button>
        <button
          disabled={entries.length === 0}
          onClick={() => {
            if (!confirm(`Clear ${entries.length} scan${entries.length !== 1 ? 's' : ''} from this session? Stored images on the server are kept.`)) return;
            for (const e of entries) URL.revokeObjectURL(e.previewUrl);
            setEntries([]);
            entriesRef.current = [];
            queueRef.current = [];
          }}
          style={{ background: 'transparent', border: '1px solid var(--border)', borderRadius: 6, color: entries.length === 0 ? 'var(--text-dim)' : 'var(--text)', padding: '6px 12px', fontSize: 12, cursor: entries.length === 0 ? 'not-allowed' : 'pointer' }}
          title="Clear this session. Stored scan images on the server are not deleted."
        >
          Clear session
        </button>
        <button
          onClick={() => setShowPricingModal(true)}
          style={{ background: 'var(--surface-2)', border: '1px solid var(--border)', borderRadius: 6, color: 'var(--text-dim)', padding: '6px 10px', fontSize: 13, cursor: 'pointer' }}
          title="Pricing settings"
        >
          ⚙ Pricing
        </button>
        <button
          onClick={async () => {
            if (!confirm('Delete all stored scan images from the server? This cannot be undone.')) return;
            try { await fetch(PURGE_SCANS_URL, { method: 'DELETE' }) } catch (_) { /* best-effort */ }
          }}
          style={{ background: 'transparent', border: '1px solid var(--border)', borderRadius: 6, color: 'var(--text-dim)', padding: '6px 12px', fontSize: 12, cursor: 'pointer' }}
          title="Permanently delete all scan images stored on the server."
        >
          Delete server scans
        </button>
      </header>

      {/* ── Inventory push panel ── */}
      {showInvPush && (
        <div style={{ padding: '10px 16px', borderBottom: '1px solid var(--border)', background: 'rgba(168,85,247,0.08)', display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
          <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--purple)', whiteSpace: 'nowrap' }}>Push to Inventory</span>
          <input
            value={inventoryToken}
            onChange={e => setInventoryToken(e.target.value)}
            placeholder="Bearer token…"
            type="password"
            style={{ flex: 1, minWidth: 200, background: 'var(--bg)', border: '1px solid var(--border)', borderRadius: 6, color: 'var(--text)', padding: '5px 10px', fontSize: 12, fontFamily: 'inherit' }}
          />
          <span style={{ fontSize: 11, color: 'var(--text-dim)', whiteSpace: 'nowrap' }}>{groupEntries(entries).reduce((s, c) => s + c.instances.length, 0)} items · stock images</span>
          <button
            onClick={pushToInventory}
            disabled={inventoryPushing || !inventoryToken}
            style={{ background: 'var(--purple)', border: 'none', borderRadius: 6, color: '#fff', padding: '6px 16px', fontSize: 12, fontWeight: 600, cursor: inventoryPushing || !inventoryToken ? 'not-allowed' : 'pointer', opacity: inventoryPushing || !inventoryToken ? 0.5 : 1 }}
          >
            {inventoryPushing ? 'Pushing…' : 'Push'}
          </button>
        </div>
      )}

      {/* ── Body ── */}
      <div style={{ display: 'flex', flex: 1, overflow: 'hidden' }}>
        {/* Left panel: deck checklist or set manifest */}
        {deckDisplayKey && (deckManifest || manifestLoading) && (
          <DeckChecklist manifest={deckManifest} scannedIds={scannedIds} loading={manifestLoading} />
        )}
        {!deckDisplayKey && setCode && setName && (
          <SetManifest setName={setName} scannedIds={scannedIds} />
        )}

        {/* Center: bin tabs + per-bin content */}
        <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
          {/* Bin tab bar */}
          <div style={{ display: 'flex', alignItems: 'stretch', padding: '0 8px', borderBottom: '1px solid var(--border)', flexShrink: 0, overflowX: 'auto', background: 'var(--surface)' }}>
            {bins.map(bin => {
              const binEntries = entries.filter(e => e.binId === bin.id)
              const doneCount = binEntries.filter(e => e.status === 'done').length
              const isActive = bin.id === activeBinId
              return (
                <div key={bin.id} style={{ display: 'flex', alignItems: 'center', flexShrink: 0 }}>
                  {renamingBinId === bin.id ? (
                    <input
                      autoFocus
                      defaultValue={bin.name}
                      onBlur={e => commitRename(bin.id, e.target.value)}
                      onKeyDown={e => { if (e.key === 'Enter') commitRename(bin.id, e.currentTarget.value); if (e.key === 'Escape') setRenamingBinId(null) }}
                      style={{ padding: '8px 6px', background: 'transparent', border: 'none', borderBottom: '2px solid var(--primary)', color: 'var(--text)', fontSize: 13, fontFamily: 'inherit', outline: 'none', width: 120, marginBottom: -2 }}
                    />
                  ) : (
                    <button
                      onClick={() => setActiveBinId(bin.id)}
                      onDoubleClick={() => setRenamingBinId(bin.id)}
                      style={{ padding: '10px 12px', background: 'transparent', border: 'none', borderBottom: isActive ? '2px solid var(--primary)' : '2px solid transparent', color: isActive ? 'var(--primary)' : 'var(--text-dim)', fontWeight: isActive ? 700 : 400, fontSize: 13, cursor: 'pointer', fontFamily: 'inherit', whiteSpace: 'nowrap', marginBottom: -1 }}
                      title="Double-click to rename"
                    >
                      {bin.name}
                      {binEntries.length > 0 && (
                        <span style={{ marginLeft: 5, fontSize: 10, opacity: 0.7 }}>{doneCount}/{binEntries.length}</span>
                      )}
                    </button>
                  )}
                  {bins.length > 1 && (
                    <button
                      onClick={() => removeBin(bin.id)}
                      style={{ background: 'none', border: 'none', color: 'var(--text-dim)', fontSize: 12, cursor: 'pointer', padding: '0 2px', opacity: 0.4, lineHeight: 1 }}
                      title="Remove bin"
                    >×</button>
                  )}
                </div>
              )
            })}
            <button
              onClick={addBin}
              style={{ padding: '10px 10px', background: 'transparent', border: 'none', color: 'var(--text-dim)', fontSize: 18, cursor: 'pointer', fontFamily: 'inherit', whiteSpace: 'nowrap', lineHeight: 1 }}
              title="Add bin"
            >+</button>
          </div>

          {/* Active bin content */}
          <main style={{ flex: 1, minWidth: 0, overflowY: 'auto', padding: 16 }}>
            {(() => {
              const binEntries = entries.filter(e => e.binId === activeBinId)
              const showQuickExport = deckDisplayKey && deckManifest && binEntries.length === 0
              const showManifestLoading = deckDisplayKey && manifestLoading && binEntries.length === 0
              return (
                <>
                  {showManifestLoading && (
                    <div style={{ fontSize: 13, color: 'var(--text-dim)', marginBottom: 16 }}>Loading deck manifest…</div>
                  )}
                  {showQuickExport ? (
                    <QuickExportPanel
                      manifest={deckManifest!}
                      settings={pricingSettings}
                      onScanInstead={() => { /* drop files into the bin to dismiss */ }}
                    />
                  ) : (
                    <>
                      {/* Per-bin drop zone */}
                      <div style={{ marginBottom: 16 }}>
                        <DropZone onFiles={files => addFiles(files, activeBinId)} />
                      </div>
                      {binEntries.length === 0 ? (
                        <div style={{ textAlign: 'center', color: 'var(--text-dim)', fontSize: 12, padding: '32px 0' }}>
                          Drop card scans above to start identifying
                        </div>
                      ) : (
                        binEntries.map(e => (
                          <ReviewCard
                            key={e.id}
                            entry={e}
                            allEntries={entries}
                            filterSetName={setName || undefined}
                            onAccept={handleAccept}
                            onCorrect={handleCorrect}
                            onOverride={handleOverride}
                            imgScale={imgScale}
                            pricingSettings={pricingSettings}
                            game={gameRef.current}
                          />
                        ))
                      )}
                    </>
                  )}
                </>
              )
            })()}
          </main>
        </div>

        {/* Right: EV-calc + session stats + active bin queue */}
        <aside style={{ width: 260, flexShrink: 0, display: 'flex', flexDirection: 'column', borderLeft: '1px solid var(--border)', background: 'var(--surface)' }}>
          {/* EV-calc CSV drop */}
          <div style={{ padding: 10, borderBottom: '1px solid var(--border)', flexShrink: 0 }}>
            <div style={{ fontSize: 10, fontWeight: 700, color: 'var(--text-dim)', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 6 }}>Pricing CSV</div>
            <EvCalcDropZone
              filename={evCalcFilename}
              onFile={(name, prices) => { setEvCalcFilename(name); setEvCalcPrices(prices) }}
            />
            {evCalcPrices.size > 0 && (
              <div style={{ fontSize: 10, color: 'var(--text-dim)', marginTop: 4 }}>{evCalcPrices.size} cards priced</div>
            )}
          </div>

          {/* Session stats: per-bin summary */}
          {bins.length > 1 && (
            <div style={{ padding: '8px 10px', borderBottom: '1px solid var(--border)', flexShrink: 0 }}>
              <div style={{ fontSize: 10, fontWeight: 700, color: 'var(--text-dim)', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 6 }}>All Bins</div>
              {bins.map(bin => {
                const binEntries = entries.filter(e => e.binId === bin.id)
                const done = binEntries.filter(e => e.status === 'done').length
                return (
                  <div key={bin.id} onClick={() => setActiveBinId(bin.id)} style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11, padding: '2px 0', cursor: 'pointer', color: bin.id === activeBinId ? 'var(--primary)' : 'var(--text-dim)' }}>
                    <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 160 }}>{bin.name}</span>
                    <span>{done}/{binEntries.length}</span>
                  </div>
                )
              })}
            </div>
          )}

          {/* Queue for active bin */}
          <div style={{ flex: 1, overflowY: 'auto', padding: '0 10px' }}>
            {(() => {
              const binEntries = entries.filter(e => e.binId === activeBinId)
              return binEntries.length === 0 ? (
                <div style={{ textAlign: 'center', color: 'var(--text-dim)', fontSize: 12, padding: '24px 0' }}>No images in this bin</div>
              ) : (
                [...binEntries].reverse().map(e => <QueueItem key={e.id} entry={e} />)
              )
            })()}
          </div>
        </aside>
      </div>
    </div>
  )
}
