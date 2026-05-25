import { useState, useRef, useCallback, useEffect } from 'react'

// ─── Types ───────────────────────────────────────────────────────────────────

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

interface ApiCandidate {
  tcgplayer_product_id: number
  image_url: string
  phash: string
  hamming_distance: number
  name: string
  set_name: string
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
  const fd = new FormData()
  fd.append('image', file)
  const url = setCode.trim()
    ? `${IDENTIFY_URL}?restrict_set=${encodeURIComponent(setCode.trim())}`
    : IDENTIFY_URL
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), 90_000)
  try {
    const res = await fetch(url, { method: 'POST', body: fd, signal: ctrl.signal })
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

  // First pass: build cards from fronts
  for (const entry of entries) {
    if (entry.status !== 'done') continue

    const displayName = entry.overrideName ?? entry.cardName ?? 'Unknown'
    const key = entry.tcgplayerId ? entry.tcgplayerId.toString() : displayName

    if (!cards.has(key)) {
      cards.set(key, {
        key,
        tcgplayerId: entry.tcgplayerId,
        cardName: displayName,
        cardNumber: entry.cardNumber,
        setName: entry.setName,
        instances: [],
      })
    }
    cards.get(key)!.instances.push({ front: entry, back: undefined })
  }

  // Second pass: attach backs
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
  const rows: string[] = [
    'card_name,card_number,set_name,tcgplayer_id,quantity,front_image_urls,back_image_urls',
  ]
  const q = (s: string) => `"${s.replace(/"/g, '""')}"`

  for (const card of cards) {
    const fronts = card.instances.map(i => i.front.scanUrl ?? '').join('|')
    const backs = card.instances.map(i => i.back?.scanUrl ?? '').join('|')
    rows.push(
      [
        q(card.cardName),
        q(card.cardNumber ?? ''),
        q(card.setName ?? ''),
        card.tcgplayerId?.toString() ?? '',
        card.instances.length.toString(),
        q(fronts),
        q(backs),
      ].join(','),
    )
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
    <span
      style={{
        fontSize: 11,
        fontWeight: 600,
        color,
        background: color + '22',
        border: `1px solid ${color}44`,
        borderRadius: 4,
        padding: '1px 6px',
        whiteSpace: 'nowrap',
      }}
    >
      {label}
    </span>
  )
}

// ─── Queue Item ───────────────────────────────────────────────────────────────

function QueueItem({
  entry,
  onOverride,
}: {
  entry: BreakEntry
  onOverride: (id: string, name: string) => void
}) {
  const [editVal, setEditVal] = useState(entry.overrideName ?? entry.cardName ?? '')

  useEffect(() => {
    setEditVal(entry.overrideName ?? entry.cardName ?? '')
  }, [entry.overrideName, entry.cardName])

  const showReview =
    entry.status === 'done' && (entry.needsReview === true || entry.confidence === 'medium')

  return (
    <div
      style={{
        display: 'flex',
        gap: 8,
        padding: '8px 0',
        borderBottom: '1px solid var(--border)',
        alignItems: 'flex-start',
      }}
    >
      <img
        src={entry.previewUrl}
        alt=""
        style={{
          width: 56,
          height: 78,
          objectFit: 'cover',
          borderRadius: 4,
          border: '1px solid var(--border)',
          flexShrink: 0,
        }}
      />
      <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 4 }}>
        <div
          style={{
            fontSize: 11,
            color: 'var(--text-dim)',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}
          title={entry.file.name}
        >
          {entry.file.name}
        </div>
        <StatusChip status={entry.status} />
        {entry.status === 'done' && entry.cardName && (
          <div
            style={{
              fontSize: 11,
              color: 'var(--text)',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}
            title={entry.overrideName ?? entry.cardName}
          >
            {entry.overrideName ?? entry.cardName}
          </div>
        )}
        {entry.status === 'back_detected' && (
          <div style={{ fontSize: 11, color: 'var(--purple)' }}>
            {entry.pairedFrontId ? 'Paired with front' : 'No front to pair'}
          </div>
        )}
        {entry.status === 'error' && entry.errorMsg && (
          <div
            style={{
              fontSize: 11,
              color: 'var(--danger)',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}
            title={entry.errorMsg}
          >
            {entry.errorMsg}
          </div>
        )}
        {showReview && (
          <div style={{ display: 'flex', gap: 4, alignItems: 'center', marginTop: 2 }}>
            <input
              value={editVal}
              onChange={e => setEditVal(e.target.value)}
              placeholder="Override card name…"
              style={{
                flex: 1,
                background: 'var(--surface-2)',
                border: '1px solid var(--border)',
                borderRadius: 4,
                color: 'var(--text)',
                padding: '2px 6px',
                fontSize: 11,
                minWidth: 0,
              }}
            />
            <button
              onClick={() => onOverride(entry.id, editVal)}
              style={{
                background: 'var(--primary)',
                border: 'none',
                borderRadius: 4,
                color: '#fff',
                padding: '2px 8px',
                fontSize: 11,
                flexShrink: 0,
              }}
            >
              Set
            </button>
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
      onDragOver={e => {
        e.preventDefault()
        setDragging(true)
      }}
      onDragLeave={() => setDragging(false)}
      onDrop={e => {
        e.preventDefault()
        setDragging(false)
        handleFileList(e.dataTransfer.files)
      }}
      onClick={() => inputRef.current?.click()}
      style={{
        border: `2px dashed ${dragging ? 'var(--primary)' : 'var(--border)'}`,
        borderRadius: 8,
        padding: '24px 16px',
        textAlign: 'center',
        background: dragging ? '#6366f111' : 'var(--surface)',
        transition: 'border-color 0.15s, background 0.15s',
        cursor: 'pointer',
      }}
    >
      <div style={{ fontSize: 28, marginBottom: 8 }}>📂</div>
      <div style={{ color: 'var(--text-dim)', fontSize: 13, marginBottom: 8 }}>
        Drop card scans here
      </div>
      <button
        onClick={e => {
          e.stopPropagation()
          inputRef.current?.click()
        }}
        style={{
          background: 'var(--surface-2)',
          border: '1px solid var(--border)',
          borderRadius: 6,
          color: 'var(--text)',
          padding: '6px 16px',
          fontSize: 13,
        }}
      >
        Browse…
      </button>
      <input
        ref={inputRef}
        type="file"
        accept="image/*"
        multiple
        style={{ display: 'none' }}
        onChange={e => {
          handleFileList(e.target.files)
          // Reset so same files can be re-added if needed
          e.target.value = ''
        }}
      />
    </div>
  )
}

// ─── Instance thumbnails (inside card row) ────────────────────────────────────

function InstanceThumbs({ inst }: { inst: BreakInstance }) {
  const hasBoth = !!inst.back
  return (
    <div
      style={{
        display: 'flex',
        gap: 4,
        alignItems: 'flex-end',
        background: 'var(--surface-2)',
        borderRadius: 6,
        padding: '4px 6px',
        border: `1px solid ${hasBoth ? 'var(--success)' : 'var(--border)'}`,
      }}
    >
      {/* Front thumb */}
      <div style={{ textAlign: 'center' }}>
        <img
          src={inst.front.scanUrl ?? inst.front.previewUrl}
          alt=""
          style={{
            width: 40,
            height: 56,
            objectFit: 'cover',
            borderRadius: 3,
            border: '1px solid var(--border)',
            display: 'block',
          }}
        />
        <span style={{ fontSize: 9, color: 'var(--text-dim)' }}>front</span>
      </div>
      {/* Back thumb or placeholder */}
      {inst.back ? (
        <div style={{ textAlign: 'center' }}>
          <img
            src={inst.back.scanUrl ?? inst.back.previewUrl}
            alt=""
            style={{
              width: 40,
              height: 56,
              objectFit: 'cover',
              borderRadius: 3,
              border: '1px solid var(--border)',
              display: 'block',
            }}
          />
          <span style={{ fontSize: 9, color: 'var(--purple)' }}>back</span>
        </div>
      ) : (
        <div style={{ textAlign: 'center' }}>
          <div
            style={{
              width: 40,
              height: 56,
              borderRadius: 3,
              border: '1px dashed var(--border)',
              background: 'var(--surface)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
            }}
          >
            <span style={{ fontSize: 16, opacity: 0.3 }}>?</span>
          </div>
          <span style={{ fontSize: 9, color: 'var(--text-dim)' }}>none</span>
        </div>
      )}
    </div>
  )
}

// ─── Card Row ─────────────────────────────────────────────────────────────────

function CardRow({ card }: { card: BreakCard }) {
  const hasAnyBack = card.instances.some(i => i.back)
  const allPaired = card.instances.every(i => i.back)
  const borderColor = allPaired ? 'var(--success)' : hasAnyBack ? '#2e6e3a' : 'var(--border)'

  const heroImg =
    card.instances[0]?.front.candidateImageUrl ?? card.instances[0]?.front.previewUrl

  return (
    <div
      style={{
        background: 'var(--surface)',
        border: `1px solid ${borderColor}`,
        borderRadius: 8,
        padding: 12,
        marginBottom: 8,
      }}
    >
      <div style={{ display: 'flex', gap: 12, alignItems: 'flex-start' }}>
        <img
          src={heroImg}
          alt=""
          onError={e => {
            const img = e.currentTarget
            const fallback = card.instances[0]?.front.previewUrl
            if (fallback && img.src !== fallback) img.src = fallback
          }}
          style={{
            width: 60,
            height: 84,
            objectFit: 'cover',
            borderRadius: 4,
            border: '1px solid var(--border)',
            flexShrink: 0,
          }}
        />
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 2 }}>
            <span style={{ fontWeight: 700, fontSize: 14, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {card.cardName}
            </span>
            <span
              style={{
                background: 'var(--primary)',
                color: '#fff',
                borderRadius: 12,
                padding: '1px 8px',
                fontSize: 12,
                fontWeight: 600,
                flexShrink: 0,
              }}
            >
              ×{card.instances.length}
            </span>
          </div>
          {card.setName && (
            <div style={{ color: 'var(--text-dim)', fontSize: 12, marginBottom: 2 }}>
              {card.setName}
            </div>
          )}
          {card.cardNumber && (
            <div style={{ color: 'var(--text-dim)', fontSize: 11, marginBottom: 6 }}>
              #{card.cardNumber}
            </div>
          )}
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginTop: 4 }}>
            {card.instances.map((inst, idx) => (
              <InstanceThumbs key={idx} inst={inst} />
            ))}
          </div>
        </div>
      </div>
    </div>
  )
}

// ─── Main App ─────────────────────────────────────────────────────────────────

export default function App() {
  const [entries, setEntries] = useState<BreakEntry[]>([])
  const [setCode, setSetCode] = useState('')

  // Stable refs — never go stale in async callbacks
  const entriesRef = useRef<BreakEntry[]>([])
  const setCodeRef = useRef('')
  const activeScans = useRef(0)
  const queueRef = useRef<string[]>([])

  // Keep refs in sync with state
  useEffect(() => { entriesRef.current = entries }, [entries])
  useEffect(() => { setCodeRef.current = setCode }, [setCode])

  // Patching a single entry by id
  const patchEntry = useCallback((id: string, patch: Partial<BreakEntry>) => {
    setEntries(prev => {
      const next = prev.map(e => (e.id === id ? { ...e, ...patch } : e))
      entriesRef.current = next
      return next
    })
  }, [])

  // Walk backwards from `beforeIdx` to find the most recent completed front
  async function findPrecedingFront(beforeIdx: number): Promise<BreakEntry | null> {
    for (let i = beforeIdx - 1; i >= 0; i--) {
      const snapshot = entriesRef.current[i]
      if (!snapshot) continue
      if (snapshot.status === 'back_detected' || snapshot.status === 'error') continue

      if (snapshot.status === 'done') return snapshot

      // Still in flight — poll up to 3s
      if (snapshot.status === 'identifying' || snapshot.status === 'queued') {
        const deadline = Date.now() + BACK_WAIT_TIMEOUT
        while (Date.now() < deadline) {
          await new Promise<void>(r => setTimeout(r, BACK_WAIT_POLL))
          const current = entriesRef.current.find(x => x.id === snapshot.id)
          if (current?.status === 'done') return current
          if (current?.status === 'error' || current?.status === 'back_detected') break
        }
        // Timed out or gave up — stop searching further back
        break
      }
    }
    return null
  }

  // Pull one item off the queue and process it
  const processNext = useCallback(() => {
    if (activeScans.current >= MAX_CONCURRENT) return
    if (queueRef.current.length === 0) return

    const id = queueRef.current.shift()!
    activeScans.current++

    // Capture index at dispatch time (for back pairing)
    const myIndex = entriesRef.current.findIndex(e => e.id === id)
    const file = entriesRef.current[myIndex]?.file
    if (!file) {
      activeScans.current--
      processNext()
      return
    }

    patchEntry(id, { status: 'identifying' })

    callIdentifyApi(file, setCodeRef.current)
      .then(async (res: ApiResponse) => {
        if (res.confidence === 'back' || res.back_detected) {
          const preceding = await findPrecedingFront(myIndex)
          patchEntry(id, {
            status: 'back_detected',
            confidence: 'back',
            scanUrl: res.front_image,
            pairedFrontId: preceding?.id,
          })
        } else {
          const top = res.candidates?.[0]
          const cardName = top?.name
          patchEntry(id, {
            status: 'done',
            confidence: res.confidence,
            needsReview: res.needs_review,
            scanUrl: res.front_image,
            tcgplayerId: top?.tcgplayer_product_id,
            cardName,
            cardNumber: cardName ? extractCardNumber(cardName) : undefined,
            setName: top?.set_name,
            candidateImageUrl: top?.image_url,
          })
        }
      })
      .catch((err: unknown) => {
        const msg = err instanceof Error ? err.message : String(err)
        patchEntry(id, { status: 'error', errorMsg: msg })
      })
      .finally(() => {
        activeScans.current--
        // Try to fill the freed slot
        processNext()
      })
  }, [patchEntry]) // setCodeRef is a ref, never stale

  function addFiles(files: File[]) {
    const newEntries: BreakEntry[] = files.map(file => ({
      id: makeId(),
      file,
      previewUrl: URL.createObjectURL(file),
      status: 'queued' as const,
    }))

    setEntries(prev => {
      const next = [...prev, ...newEntries]
      entriesRef.current = next
      return next
    })

    for (const e of newEntries) queueRef.current.push(e.id)

    // Fill available slots
    const slots = MAX_CONCURRENT - activeScans.current
    for (let i = 0; i < slots; i++) processNext()
  }

  function handleOverride(id: string, name: string) {
    patchEntry(id, { overrideName: name.trim() || undefined })
  }

  function handleExport() {
    downloadCSV(buildCSV(entries))
  }

  const completedCount = entries.filter(
    e => e.status === 'done' || e.status === 'back_detected',
  ).length

  const cards = groupEntries(entries)

  // Revoke blob URLs when entries are removed (cleanup on unmount)
  useEffect(() => {
    return () => {
      for (const e of entriesRef.current) URL.revokeObjectURL(e.previewUrl)
    }
  }, [])

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', overflow: 'hidden' }}>
      {/* ── Top bar ── */}
      <header
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 12,
          padding: '10px 16px',
          borderBottom: '1px solid var(--border)',
          background: 'var(--surface)',
          flexShrink: 0,
        }}
      >
        <h1 style={{ fontSize: 16, fontWeight: 700, color: 'var(--primary)', marginRight: 8 }}>
          Box Break Scanner
        </h1>
        <input
          value={setCode}
          onChange={e => setSetCode(e.target.value)}
          placeholder="Set code e.g. TMC"
          style={{
            background: 'var(--bg)',
            border: '1px solid var(--border)',
            borderRadius: 6,
            color: 'var(--text)',
            padding: '5px 10px',
            fontSize: 13,
            width: 160,
          }}
        />
        <span style={{ color: 'var(--text-dim)', fontSize: 12 }}>
          {completedCount} / {entries.length} processed
        </span>
        <div style={{ flex: 1 }} />
        <button
          disabled={completedCount === 0}
          onClick={handleExport}
          style={{
            background: completedCount === 0 ? 'var(--surface-2)' : 'var(--primary)',
            border: 'none',
            borderRadius: 6,
            color: completedCount === 0 ? 'var(--text-dim)' : '#fff',
            padding: '6px 16px',
            fontSize: 13,
            fontWeight: 600,
            cursor: completedCount === 0 ? 'not-allowed' : 'pointer',
          }}
        >
          Export CSV
        </button>
      </header>

      {/* ── Body ── */}
      <div style={{ display: 'flex', flex: 1, overflow: 'hidden' }}>
        {/* Left: identified card list */}
        <main style={{ flex: 1, overflowY: 'auto', padding: 16 }}>
          {cards.length === 0 ? (
            <div
              style={{
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'center',
                justifyContent: 'center',
                height: '100%',
                color: 'var(--text-dim)',
                gap: 8,
              }}
            >
              <div style={{ fontSize: 48, opacity: 0.3 }}>🃏</div>
              <div style={{ fontSize: 15 }}>Drop card scans to get started</div>
              <div style={{ fontSize: 12 }}>
                Identified cards will appear here, grouped by card
              </div>
            </div>
          ) : (
            <>
              <div
                style={{
                  fontSize: 11,
                  color: 'var(--text-dim)',
                  marginBottom: 12,
                  fontWeight: 600,
                  textTransform: 'uppercase',
                  letterSpacing: '0.06em',
                }}
              >
                {cards.length} unique card{cards.length !== 1 ? 's' : ''} &nbsp;·&nbsp;{' '}
                {cards.reduce((a, c) => a + c.instances.length, 0)} total copies
              </div>
              {cards.map(card => (
                <CardRow key={card.key} card={card} />
              ))}
            </>
          )}
        </main>

        {/* Right: drop zone + processing queue */}
        <aside
          style={{
            width: 300,
            flexShrink: 0,
            display: 'flex',
            flexDirection: 'column',
            borderLeft: '1px solid var(--border)',
            background: 'var(--surface)',
          }}
        >
          <div style={{ padding: 12, borderBottom: '1px solid var(--border)', flexShrink: 0 }}>
            <DropZone onFiles={addFiles} />
          </div>

          {/* Queue list */}
          <div style={{ flex: 1, overflowY: 'auto', padding: '0 12px' }}>
            {entries.length === 0 ? (
              <div
                style={{
                  textAlign: 'center',
                  color: 'var(--text-dim)',
                  fontSize: 12,
                  padding: '24px 0',
                }}
              >
                No images yet
              </div>
            ) : (
              // Show newest first in queue for UX convenience
              [...entries].reverse().map(e => (
                <QueueItem key={e.id} entry={e} onOverride={handleOverride} />
              ))
            )}
          </div>
        </aside>
      </div>
    </div>
  )
}
