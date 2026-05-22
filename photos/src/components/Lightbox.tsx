import { useState, useEffect, useRef, useCallback } from 'react'
import { Photo } from '../types'

interface LightboxProps {
  photos: Photo[]
  idx: number
  slugToName: Record<string, string>
  nameToDisplay: Record<string, string>
  onClose: () => void
  onNav: (idx: number) => void
}

interface FaceBoxStyle {
  left: number
  top: number
  width: number
  height: number
  label: string
}

const IconFaces = () => (
  <svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M4 8V6a2 2 0 0 1 2-2h2" /><path d="M16 4h2a2 2 0 0 1 2 2v2" />
    <path d="M20 16v2a2 2 0 0 1-2 2h-2" /><path d="M8 20H6a2 2 0 0 1-2-2v-2" />
    <circle cx="9.5" cy="11" r="1" fill="currentColor" stroke="none" /><circle cx="14.5" cy="11" r="1" fill="currentColor" stroke="none" />
    <path d="M9 15c.8.7 1.8 1 3 1s2.2-.3 3-1" />
  </svg>
)
const IconX = () => (
  <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round">
    <line x1="5" y1="5" x2="19" y2="19" /><line x1="19" y1="5" x2="5" y2="19" />
  </svg>
)
const IconArrow = ({ dir }: { dir: 'left' | 'right' }) => (
  <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
    {dir === 'left' ? <polyline points="15 18 9 12 15 6" /> : <polyline points="9 18 15 12 9 6" />}
  </svg>
)

export default function Lightbox({ photos, idx, slugToName, nameToDisplay, onClose, onNav }: LightboxProps) {
  const [showBoxes, setShowBoxes] = useState(false)
  const [faceBoxes, setFaceBoxes] = useState<FaceBoxStyle[]>([])
  const imgRef = useRef<HTMLImageElement>(null)
  const imgAreaRef = useRef<HTMLDivElement>(null)
  const imgWrapRef = useRef<HTMLDivElement>(null)
  const filmstripRef = useRef<HTMLDivElement>(null)

  // Touch gesture refs — mutated directly to avoid re-render lag
  const scaleRef = useRef(1)
  const panRef = useRef({ x: 0, y: 0 })
  const touchStartRef = useRef<{ x: number; y: number; t: number } | null>(null)
  const pinchStartRef = useRef<{ dist: number; scale: number; midX: number; midY: number } | null>(null)
  const lastTapRef = useRef(0)

  const photo = photos[idx]

  function applyTransform() {
    if (!imgWrapRef.current) return
    imgWrapRef.current.style.transform =
      `translate(${panRef.current.x}px, ${panRef.current.y}px) scale(${scaleRef.current})`
  }

  function resetZoom() {
    scaleRef.current = 1
    panRef.current = { x: 0, y: 0 }
    applyTransform()
  }

  // Reset zoom/pan when navigating
  useEffect(() => {
    resetZoom()
    setFaceBoxes([])
  }, [idx])

  // Keep the active filmstrip thumbnail centered
  useEffect(() => {
    const strip = filmstripRef.current
    if (!strip) return
    const active = strip.querySelector<HTMLElement>('.lb-thumb.active')
    active?.scrollIntoView({ inline: 'center', block: 'nearest', behavior: 'smooth' })
  }, [idx])

  useEffect(() => {
    function handleKey(e: KeyboardEvent) {
      if (e.key === 'ArrowLeft')  { if (idx > 0) onNav(idx - 1) }
      if (e.key === 'ArrowRight') { if (idx < photos.length - 1) onNav(idx + 1) }
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', handleKey)
    return () => document.removeEventListener('keydown', handleKey)
  }, [idx, photos.length, onNav, onClose])

  const computeBoxes = useCallback(() => {
    if (!showBoxes || !photo || !imgRef.current || !imgAreaRef.current) {
      setFaceBoxes([])
      return
    }
    const img = imgRef.current
    const area = imgAreaRef.current
    const sx = img.width / img.naturalWidth
    const sy = img.height / img.naturalHeight
    const ir = img.getBoundingClientRect()
    const ar = area.getBoundingClientRect()
    const ox = ir.left - ar.left
    const oy = ir.top - ar.top
    setFaceBoxes(photo.faces.map(f => ({
      left:   ox + f.bbox[0] * sx,
      top:    oy + f.bbox[1] * sy,
      width:  (f.bbox[2] - f.bbox[0]) * sx,
      height: (f.bbox[3] - f.bbox[1]) * sy,
      label:  nameToDisplay[f.name] || f.name,
    })))
  }, [showBoxes, photo, nameToDisplay])

  useEffect(() => {
    setFaceBoxes([])
    if (!showBoxes || !photo?.faces.length) return
    const img = imgRef.current
    if (!img) return
    if (img.complete && img.naturalWidth) computeBoxes()
    else img.onload = computeBoxes
    return () => { if (img) img.onload = null }
  }, [photo, showBoxes, computeBoxes])

  // ── Touch handlers ──────────────────────────────────────────────────────────

  function onTouchStart(e: React.TouchEvent) {
    if (e.touches.length === 1) {
      touchStartRef.current = {
        x: e.touches[0].clientX,
        y: e.touches[0].clientY,
        t: Date.now(),
      }
      pinchStartRef.current = null
    } else if (e.touches.length === 2) {
      const dx = e.touches[1].clientX - e.touches[0].clientX
      const dy = e.touches[1].clientY - e.touches[0].clientY
      pinchStartRef.current = {
        dist: Math.hypot(dx, dy),
        scale: scaleRef.current,
        midX: (e.touches[0].clientX + e.touches[1].clientX) / 2,
        midY: (e.touches[0].clientY + e.touches[1].clientY) / 2,
      }
      touchStartRef.current = null
    }
  }

  function onTouchMove(e: React.TouchEvent) {
    e.preventDefault()
    if (e.touches.length === 2 && pinchStartRef.current) {
      const dx = e.touches[1].clientX - e.touches[0].clientX
      const dy = e.touches[1].clientY - e.touches[0].clientY
      const dist = Math.hypot(dx, dy)
      scaleRef.current = Math.min(5, Math.max(1, pinchStartRef.current.scale * (dist / pinchStartRef.current.dist)))
      applyTransform()
    } else if (e.touches.length === 1 && touchStartRef.current && scaleRef.current > 1) {
      const dx = e.touches[0].clientX - touchStartRef.current.x
      const dy = e.touches[0].clientY - touchStartRef.current.y
      panRef.current = { x: panRef.current.x + dx, y: panRef.current.y + dy }
      touchStartRef.current = { x: e.touches[0].clientX, y: e.touches[0].clientY, t: touchStartRef.current.t }
      applyTransform()
    }
  }

  function onTouchEnd(e: React.TouchEvent) {
    if (!touchStartRef.current || e.changedTouches.length === 0) return
    const dx = e.changedTouches[0].clientX - touchStartRef.current.x
    const dy = e.changedTouches[0].clientY - touchStartRef.current.y
    const dt = Date.now() - touchStartRef.current.t

    // Double-tap to toggle zoom
    if (dt < 250 && Math.abs(dx) < 12 && Math.abs(dy) < 12) {
      const now = Date.now()
      if (now - lastTapRef.current < 350) {
        if (scaleRef.current > 1) {
          resetZoom()
        } else {
          scaleRef.current = 2.5
          applyTransform()
        }
        lastTapRef.current = 0
        touchStartRef.current = null
        return
      }
      lastTapRef.current = now
    }

    // Swipe to navigate (only when not zoomed)
    if (scaleRef.current <= 1 && dt < 350 && Math.abs(dx) > 50 && Math.abs(dy) < 80) {
      if (dx < 0 && idx < photos.length - 1) onNav(idx + 1)
      else if (dx > 0 && idx > 0) onNav(idx - 1)
    }

    touchStartRef.current = null
  }

  if (!photo) return null

  const lastSlug = photo.slugs[photo.slugs.length - 1] ?? ''
  const categoryLabel = slugToName[lastSlug] || lastSlug.split('/').pop() || ''
  const isZoomed = scaleRef.current > 1

  return (
    <div className="lightbox-overlay" onClick={e => { if (e.target === e.currentTarget) onClose() }}>
      {/* Header */}
      <div className="lb-header">
        {categoryLabel && <span className="lb-category-label">{categoryLabel}</span>}
        <div className="lb-header-actions">
          {photo.faces.length > 0 && !isZoomed && (
            <button
              className={`lb-icon-btn${showBoxes ? ' active' : ''}`}
              onClick={() => setShowBoxes(v => !v)}
              title={showBoxes ? 'Hide faces' : 'Show faces'}
              aria-label="Toggle faces"
            >
              <IconFaces />
            </button>
          )}
          <button className="lb-icon-btn" onClick={onClose} title="Close (Esc)" aria-label="Close"><IconX /></button>
        </div>
      </div>

      {/* Image area */}
      <div
        className="lb-img-area"
        ref={imgAreaRef}
        onTouchStart={onTouchStart}
        onTouchMove={onTouchMove}
        onTouchEnd={onTouchEnd}
        onClick={e => { if (e.target === e.currentTarget) onClose() }}
      >
        <div className="lb-img-wrap" ref={imgWrapRef}>
          <img
            key={idx}
            ref={imgRef}
            className="lb-img"
            src={`https://photos.recap.pinewood.one/${photo.path}`}
            alt={categoryLabel}
            draggable={false}
          />
        </div>
        {showBoxes && !isZoomed && faceBoxes.map((box, i) => (
          <div
            key={i}
            className="lb-face-box"
            style={{ left: box.left, top: box.top, width: box.width, height: box.height }}
          >
            <div className="lb-face-label">{box.label}</div>
          </div>
        ))}
      </div>

      {/* Navigation — hidden on mobile (swipe instead) */}
      <button className="lb-nav lb-prev lb-icon-btn" onClick={() => onNav(idx - 1)} disabled={idx === 0} title="Previous (←)" aria-label="Previous"><IconArrow dir="left" /></button>
      <button className="lb-nav lb-next lb-icon-btn" onClick={() => onNav(idx + 1)} disabled={idx === photos.length - 1} title="Next (→)" aria-label="Next"><IconArrow dir="right" /></button>

      {/* Counter */}
      <div className="lb-counter">{idx + 1} / {photos.length}</div>

      {/* Filmstrip — desktop only */}
      <div className="lb-filmstrip" ref={filmstripRef} onClick={e => e.stopPropagation()}>
        {photos.map((p, i) => (
          <button
            key={p.path}
            className={`lb-thumb${i === idx ? ' active' : ''}`}
            onClick={() => onNav(i)}
            aria-label={`Photo ${i + 1}`}
            aria-current={i === idx}
          >
            <img
              src={`https://photos.recap.pinewood.one/${p.path}`}
              alt=""
              loading="lazy"
              decoding="async"
            />
          </button>
        ))}
      </div>
    </div>
  )
}
