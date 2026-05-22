import { useState, useEffect, useRef } from 'react'
import { Photo } from '../types'

interface GalleryProps {
  photos: Photo[]
  onPhotoClick: (idx: number) => void
}

export default function Gallery({ photos, onPhotoClick }: GalleryProps) {
  const [displayCount, setDisplayCount] = useState(150)
  const sentinelRef = useRef<HTMLDivElement>(null)
  const observerRef = useRef<IntersectionObserver | null>(null)

  useEffect(() => {
    setDisplayCount(150)
  }, [photos])

  useEffect(() => {
    if (observerRef.current) observerRef.current.disconnect()
    observerRef.current = new IntersectionObserver(entries => {
      if (entries[0].isIntersecting) {
        setDisplayCount(prev => prev < photos.length ? prev + 150 : prev)
      }
    }, { rootMargin: '1000px' })
    if (sentinelRef.current) observerRef.current.observe(sentinelRef.current)
    return () => { observerRef.current?.disconnect() }
  }, [photos])

  const visible = photos.slice(0, displayCount)

  return (
    <div className="gallery-wrap">
      <div className="gallery-grid">
        {visible.length === 0 ? (
          <div className="gallery-empty">
            <svg className="gallery-empty-icon" width="56" height="56" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
              <rect x="3" y="5" width="18" height="14" rx="3" />
              <circle cx="8.5" cy="10" r="1.6" />
              <path d="M21 16l-5-5-9 8" />
            </svg>
            <div className="gallery-empty-title">No photos found</div>
            <div className="gallery-empty-sub">Try adjusting your filters or search.</div>
          </div>
        ) : (
          visible.map((photo, idx) => (
            <PhotoCard key={photo.path} photo={photo} onClick={() => onPhotoClick(idx)} />
          ))
        )}
      </div>
      <div className="sentinel" ref={sentinelRef} />
    </div>
  )
}

function PhotoCard({ photo, onClick }: { photo: Photo; onClick: () => void }) {
  const [loaded, setLoaded] = useState(false)
  return (
    <div className={`photo-card${loaded ? ' loaded' : ''}`} onClick={onClick}>
      <img
        src={`https://photos.recap.pinewood.one/${photo.path}`}
        alt=""
        loading="lazy"
        decoding="async"
        onLoad={() => setLoaded(true)}
        style={{ opacity: loaded ? 1 : 0 }}
      />
    </div>
  )
}
