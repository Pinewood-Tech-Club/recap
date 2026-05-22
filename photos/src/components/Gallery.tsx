import { useState, useEffect, useRef } from 'react'
import { Photo } from '../types'

interface GalleryProps {
  photos: Photo[]
  onPhotoClick: (idx: number) => void
}

export default function Gallery({ photos, onPhotoClick }: GalleryProps) {
  const [displayCount, setDisplayCount] = useState(100)
  const sentinelRef = useRef<HTMLDivElement>(null)
  const observerRef = useRef<IntersectionObserver | null>(null)

  // Reset displayCount when photos array reference changes
  useEffect(() => {
    setDisplayCount(100)
  }, [photos])

  // Intersection observer for infinite scroll
  useEffect(() => {
    if (observerRef.current) {
      observerRef.current.disconnect()
    }

    observerRef.current = new IntersectionObserver(entries => {
      if (entries[0].isIntersecting) {
        setDisplayCount(prev => {
          if (prev < photos.length) return prev + 100
          return prev
        })
      }
    }, { rootMargin: '800px' })

    if (sentinelRef.current) {
      observerRef.current.observe(sentinelRef.current)
    }

    return () => {
      observerRef.current?.disconnect()
    }
  }, [photos])

  const visible = photos.slice(0, displayCount)

  return (
    <div className="gallery-wrap">
      <div className="gallery-grid">
        {visible.length === 0 ? (
          <div className="gallery-empty">
            <span className="gallery-empty-icon">📷</span>
            No photos match the current filters.
          </div>
        ) : (
          visible.map((photo, idx) => (
            <PhotoCard
              key={photo.path}
              photo={photo}
              onClick={() => onPhotoClick(idx)}
            />
          ))
        )}
      </div>
      <div className="sentinel" ref={sentinelRef} />
    </div>
  )
}

interface PhotoCardProps {
  photo: Photo
  onClick: () => void
}

function PhotoCard({ photo, onClick }: PhotoCardProps) {
  const filename = photo.path.split('/').pop() ?? photo.path

  return (
    <div className="photo-card" onClick={onClick}>
      <div className="photo-thumb">
        <img
          src={`https://photos.recap.pinewood.one/${photo.path}`}
          alt={photo.album}
          loading="lazy"
        />
        <div className={`src-dot ${photo.source}`} />
        {photo.faces.length > 0 && (
          <div className="face-badge">👤 {photo.faces.length}</div>
        )}
      </div>
      <div className="photo-info">
        <div className="photo-album">{photo.album}</div>
        <div className="photo-file">{filename}</div>
      </div>
    </div>
  )
}
