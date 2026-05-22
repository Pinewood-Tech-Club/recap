import { useState, useEffect, useRef, useCallback } from 'react'
import { Photo } from '../types'

interface LightboxProps {
  photos: Photo[]
  idx: number
  onClose: () => void
  onNav: (idx: number) => void
}

interface FaceBoxStyle {
  left: number
  top: number
  width: number
  height: number
  name: string
}

export default function Lightbox({ photos, idx, onClose, onNav }: LightboxProps) {
  const [showBoxes, setShowBoxes] = useState(false)
  const [faceBoxes, setFaceBoxes] = useState<FaceBoxStyle[]>([])
  const imgRef = useRef<HTMLImageElement>(null)
  const imgAreaRef = useRef<HTMLDivElement>(null)

  const photo = photos[idx]

  // Keyboard navigation
  useEffect(() => {
    function handleKey(e: KeyboardEvent) {
      if (e.key === 'ArrowLeft')  { if (idx > 0) onNav(idx - 1) }
      if (e.key === 'ArrowRight') { if (idx < photos.length - 1) onNav(idx + 1) }
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', handleKey)
    return () => document.removeEventListener('keydown', handleKey)
  }, [idx, photos.length, onNav, onClose])

  // Compute face box positions
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

    const boxes: FaceBoxStyle[] = photo.faces.map(f => {
      const [x1, y1, x2, y2] = f.bbox
      return {
        left:   ox + x1 * sx,
        top:    oy + y1 * sy,
        width:  (x2 - x1) * sx,
        height: (y2 - y1) * sy,
        name:   f.name,
      }
    })
    setFaceBoxes(boxes)
  }, [showBoxes, photo])

  // Recompute boxes when image loads
  useEffect(() => {
    setFaceBoxes([])
    if (!showBoxes || !photo?.faces.length) return
    const img = imgRef.current
    if (!img) return
    if (img.complete && img.naturalWidth) {
      computeBoxes()
    } else {
      img.onload = computeBoxes
    }
    return () => { if (img) img.onload = null }
  }, [photo, showBoxes, computeBoxes])

  // Toggle boxes
  function handleToggleBoxes() {
    setShowBoxes(prev => !prev)
  }

  if (!photo) return null

  const slugLabels = photo.slugs.join(' · ') || '—'

  return (
    <div
      className="lightbox-overlay"
      onClick={e => { if (e.target === e.currentTarget) onClose() }}
    >
      <div className="lightbox-inner">
        {/* Image area */}
        <div className="lb-img-area" ref={imgAreaRef}>
          <button className="lb-close" onClick={onClose} title="Close (Esc)">✕</button>
          {photo.faces.length > 0 && (
            <button
              className={`lb-toggle-boxes${showBoxes ? ' active' : ''}`}
              onClick={handleToggleBoxes}
              title="Toggle face boxes"
            >
              {showBoxes ? 'Hide boxes' : 'Show boxes'}
            </button>
          )}

          <button
            className="lb-nav lb-prev"
            onClick={() => onNav(idx - 1)}
            disabled={idx === 0}
            title="Previous (←)"
          >
            ‹
          </button>

          <img
            ref={imgRef}
            className="lb-img"
            src={`https://photos.recap.pinewood.one/${photo.path}`}
            alt={photo.album}
          />

          {/* Face boxes */}
          {showBoxes && faceBoxes.map((box, i) => (
            <div
              key={i}
              className="lb-face-box"
              style={{
                left:   box.left,
                top:    box.top,
                width:  box.width,
                height: box.height,
              }}
            >
              <div className="lb-face-label">{box.name}</div>
            </div>
          ))}

          <button
            className="lb-nav lb-next"
            onClick={() => onNav(idx + 1)}
            disabled={idx === photos.length - 1}
            title="Next (→)"
          >
            ›
          </button>

          <div className="lb-counter">
            {idx + 1} / {photos.length}
          </div>
        </div>

        {/* Meta panel */}
        <div className="lb-meta">
          <div className="lb-meta-title">Photo Info</div>

          <div className="lb-meta-section">
            <span className="lb-meta-label">Album</span>
            <div className="lb-meta-value">{photo.album}</div>
          </div>

          <div className="lb-meta-section">
            <span className="lb-meta-label">Source</span>
            <div className="lb-meta-value">{photo.source}</div>
          </div>

          <div className="lb-meta-section">
            <span className="lb-meta-label">File</span>
            <div className="lb-meta-value mono">{photo.path}</div>
          </div>

          <div className="lb-meta-section">
            <span className="lb-meta-label">Categories</span>
            <div className="lb-meta-value">{slugLabels}</div>
          </div>

          <div className="lb-meta-section">
            <span className="lb-meta-label">Faces ({photo.faces.length})</span>
            {photo.faces.length === 0 ? (
              <div className="lb-no-faces">No faces detected</div>
            ) : (
              photo.faces.map((f, i) => (
                <div key={i} className="lb-face-row">
                  <span className="lb-face-name">{f.name}</span>
                  <span className="lb-face-score">{f.score.toFixed(3)}</span>
                </div>
              ))
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
