import { CSSProperties, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Photo, SlideshowFit, SlideshowTransition } from '../types'

const BASE = 'https://photos.recap.pinewood.one'
const PRELOAD_AHEAD = 10

interface SlideshowProps {
  photos: Photo[]
  durationMs: number
  transitionDurationMs: number
  transition: SlideshowTransition
  fit: SlideshowFit
  kenBurns: boolean
  browserFullscreen: boolean
  onClose: () => void
}

interface ImageSize {
  width: number
  height: number
}

function photoUrl(photo: Photo) {
  return `${BASE}/${photo.path}`
}

function preloadImage(url: string) {
  return new Promise<ImageSize | null>(resolve => {
    const img = new Image()
    img.decoding = 'async'
    img.onload = async () => {
      try {
        await img.decode()
      } catch {
        // decode can reject after load in some browsers; keep the already loaded image usable.
      }
      resolve({ width: img.naturalWidth, height: img.naturalHeight })
    }
    img.onerror = () => resolve(null)
    img.src = url
  })
}

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value))
}

function motionForPhoto(photo: Photo, index: number, size?: ImageSize) {
  const variant = index % 5
  const hasFaces = photo.faces.length > 0 && size?.width && size.height

  let centerX = 0.5
  let centerY = 0.5
  let spanX = 0
  let spanY = 0

  if (hasFaces && size) {
    const x0 = Math.min(...photo.faces.map(face => face.bbox[0]))
    const y0 = Math.min(...photo.faces.map(face => face.bbox[1]))
    const x1 = Math.max(...photo.faces.map(face => face.bbox[2]))
    const y1 = Math.max(...photo.faces.map(face => face.bbox[3]))
    centerX = clamp(((x0 + x1) / 2) / size.width, 0.18, 0.82)
    centerY = clamp(((y0 + y1) / 2) / size.height, 0.18, 0.82)
    spanX = clamp((x1 - x0) / size.width, 0, 1)
    spanY = clamp((y1 - y0) / size.height, 0, 1)
  }

  const targetX = clamp((0.5 - centerX) * 18, -7, 7)
  const targetY = clamp((0.5 - centerY) * 16, -6, 6)
  const groupPenalty = Math.max(spanX, spanY) > 0.48 ? 0.025 : 0
  const baseZoom = 1.055 - groupPenalty
  const highZoom = 1.105 - groupPenalty

  if (!hasFaces) {
    return variant % 2 === 0
      ? { sx: -1.5, sy: 0, ex: 1.5, ey: -1, ss: 1.015, es: 1.055 }
      : { sx: 1.2, sy: -0.8, ex: -1.2, ey: 0.8, ss: 1.05, es: 1.018 }
  }

  if (variant === 0) return { sx: targetX * 0.35, sy: targetY * 0.35, ex: targetX, ey: targetY, ss: baseZoom, es: highZoom }
  if (variant === 1) return { sx: targetX, sy: targetY, ex: targetX * 0.3, ey: targetY * 0.3, ss: highZoom, es: baseZoom }
  if (variant === 2) return { sx: targetX - 2.4, sy: targetY * 0.65, ex: targetX + 2.4, ey: targetY, ss: baseZoom, es: highZoom }
  if (variant === 3) return { sx: targetX + 2.2, sy: targetY, ex: targetX - 1.8, ey: targetY * 0.55, ss: highZoom, es: baseZoom }
  return { sx: targetX * 0.6, sy: targetY - 1.8, ex: targetX, ey: targetY + 1.2, ss: 1.035, es: 1.085 }
}

function focusForPhoto(photo: Photo, index: number, size?: ImageSize) {
  if (!photo.faces.length || !size?.width || !size.height) {
    const fallback = [
      ['50%', '50%'],
      ['48%', '50%'],
      ['52%', '49%'],
      ['50%', '52%'],
    ][index % 4]
    return `${fallback[0]} ${fallback[1]}`
  }

  const x0 = Math.min(...photo.faces.map(face => face.bbox[0]))
  const y0 = Math.min(...photo.faces.map(face => face.bbox[1]))
  const x1 = Math.max(...photo.faces.map(face => face.bbox[2]))
  const y1 = Math.max(...photo.faces.map(face => face.bbox[3]))
  const spanX = (x1 - x0) / size.width
  const spanY = (y1 - y0) / size.height
  const rawX = ((x0 + x1) / 2) / size.width
  const rawY = ((y0 + y1) / 2) / size.height
  const offsets = [
    [0, 0],
    [-0.025, 0.012],
    [0.025, -0.01],
    [-0.012, -0.018],
    [0.014, 0.018],
  ][index % 5]

  const groupWide = Math.max(spanX, spanY) > 0.46
  const x = groupWide ? rawX * 0.45 + 0.5 * 0.55 : rawX + offsets[0]
  const y = groupWide ? rawY * 0.5 + 0.5 * 0.5 : rawY + offsets[1]
  return `${clamp(x * 100, 28, 72).toFixed(1)}% ${clamp(y * 100, 22, 70).toFixed(1)}%`
}

function kenBurnsStyle(
  photo: Photo,
  index: number,
  durationMs: number,
  size: ImageSize | undefined,
  phase: 'enter' | 'exit' = 'enter',
): CSSProperties {
  const motion = motionForPhoto(photo, index, size)
  if (phase === 'exit') {
    return {
      '--kb-start-x': `${motion.sx}%`,
      '--kb-start-y': `${motion.sy}%`,
      '--kb-end-x': `${motion.ex}%`,
      '--kb-end-y': `${motion.ey}%`,
      '--kb-start-scale': motion.ss,
      '--kb-end-scale': motion.es,
      transform: `translate3d(${motion.ex}%, ${motion.ey}%, 0) scale(${motion.es})`,
    } as CSSProperties
  }

  return {
    '--kb-start-x': `${motion.sx}%`,
    '--kb-start-y': `${motion.sy}%`,
    '--kb-end-x': `${motion.ex}%`,
    '--kb-end-y': `${motion.ey}%`,
    '--kb-start-scale': motion.ss,
    '--kb-end-scale': motion.es,
    '--kb-duration': `${Math.max(1, durationMs / 1000)}s`,
  } as CSSProperties
}

export default function Slideshow({
  photos,
  durationMs,
  transitionDurationMs,
  transition,
  fit,
  kenBurns,
  browserFullscreen,
  onClose,
}: SlideshowProps) {
  const [idx, setIdx] = useState(0)
  const [previousIdx, setPreviousIdx] = useState<number | null>(null)
  const [direction, setDirection] = useState<'next' | 'prev'>('next')
  const [transitionActive, setTransitionActive] = useState(true)
  const [ready, setReady] = useState<Set<number>>(() => new Set())
  const [sizes, setSizes] = useState<Map<string, ImageSize>>(() => new Map())
  const [chromeVisible, setChromeVisible] = useState(true)
  const rootRef = useRef<HTMLDivElement>(null)
  const timerRef = useRef<number | null>(null)
  const chromeTimerRef = useRef<number | null>(null)
  const transitionFrameRef = useRef<number | null>(null)
  const photosRef = useRef(photos)

  useEffect(() => {
    photosRef.current = photos
  }, [photos])

  const current = photos[idx]
  const previous = previousIdx === null ? null : photos[previousIdx]

  const preloadIndices = useMemo(() => {
    if (photos.length === 0) return []
    const result: number[] = []
    for (let offset = 0; offset <= Math.min(PRELOAD_AHEAD, photos.length - 1); offset += 1) {
      result.push((idx + offset) % photos.length)
    }
    if (idx > 0) result.push(idx - 1)
    return [...new Set(result)]
  }, [idx, photos.length])

  useEffect(() => {
    let cancelled = false
    for (const index of preloadIndices) {
      if (ready.has(index) || !photos[index]) continue
      const photo = photos[index]
      preloadImage(photoUrl(photo)).then(size => {
        if (cancelled) return
        if (size) {
          setSizes(prev => {
            if (prev.has(photo.path)) return prev
            const next = new Map(prev)
            next.set(photo.path, size)
            return next
          })
        }
        setReady(prev => {
          if (prev.has(index)) return prev
          const next = new Set(prev)
          next.add(index)
          return next
        })
      })
    }
    return () => {
      cancelled = true
    }
  }, [photos, preloadIndices, ready])

  useEffect(() => {
    if (!browserFullscreen) return
    document.documentElement.requestFullscreen?.().catch(() => {})
    return () => {
      if (document.fullscreenElement) document.exitFullscreen?.().catch(() => {})
    }
  }, [browserFullscreen])

  useEffect(() => {
    if (!browserFullscreen) return
    function onFullscreenChange() {
      if (!document.fullscreenElement) onClose()
    }
    document.addEventListener('fullscreenchange', onFullscreenChange)
    return () => document.removeEventListener('fullscreenchange', onFullscreenChange)
  }, [browserFullscreen, onClose])

  const pingChrome = useCallback(() => {
    setChromeVisible(true)
    if (chromeTimerRef.current) window.clearTimeout(chromeTimerRef.current)
    chromeTimerRef.current = window.setTimeout(() => setChromeVisible(false), 3000)
  }, [])

  useEffect(() => {
    pingChrome()
    return () => {
      if (chromeTimerRef.current) window.clearTimeout(chromeTimerRef.current)
    }
  }, [pingChrome])

  const navigate = useCallback((nextIdx: number, nextDirection: 'next' | 'prev') => {
    if (photosRef.current.length === 0) return
    const shouldTransition = transition !== 'none' && transitionDurationMs > 0
    setPreviousIdx(shouldTransition ? idx : null)
    setDirection(nextDirection)
    setTransitionActive(false)
    setIdx(nextIdx)
    if (transitionFrameRef.current) window.cancelAnimationFrame(transitionFrameRef.current)
    transitionFrameRef.current = window.requestAnimationFrame(() => {
      transitionFrameRef.current = window.requestAnimationFrame(() => setTransitionActive(true))
    })
    window.setTimeout(() => setPreviousIdx(null), shouldTransition ? Math.max(80, transitionDurationMs + 40) : 40)
  }, [idx, transition, transitionDurationMs])

  useEffect(() => () => {
    if (transitionFrameRef.current) window.cancelAnimationFrame(transitionFrameRef.current)
  }, [])

  const goNext = useCallback(() => {
    if (photos.length <= 1) return
    const nextIdx = (idx + 1) % photos.length
    if (!ready.has(nextIdx)) return
    navigate(nextIdx, 'next')
  }, [idx, navigate, photos.length, ready])

  const goPrev = useCallback(() => {
    if (photos.length <= 1) return
    const nextIdx = (idx - 1 + photos.length) % photos.length
    navigate(nextIdx, 'prev')
  }, [idx, navigate, photos.length])

  useEffect(() => {
    if (timerRef.current) window.clearInterval(timerRef.current)
    timerRef.current = window.setInterval(goNext, durationMs)
    return () => {
      if (timerRef.current) window.clearInterval(timerRef.current)
    }
  }, [durationMs, goNext])

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose()
      if (e.key === 'ArrowRight' || e.key === ' ') {
        e.preventDefault()
        goNext()
      }
      if (e.key === 'ArrowLeft') goPrev()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [goNext, goPrev, onClose])

  if (!current) return null

  const transitionClass = transition === 'none' ? 'none' : transition
  const dirClass = direction === 'next' ? 'forward' : 'backward'
  const currentReady = ready.has(idx)
  const effectiveTransitionMs = transition === 'none' ? 0 : transitionDurationMs

  return (
    <div
      className={`slideshow-overlay${chromeVisible ? '' : ' hide-ui'}`}
      ref={rootRef}
      onMouseMove={pingChrome}
      onPointerMove={pingChrome}
    >
      <div
        className={`slideshow-stage ${transitionClass} ${dirClass}`}
        style={{ '--ss-transition-duration': `${Math.max(0, effectiveTransitionMs / 1000)}s` } as CSSProperties}
      >
        {previous && previousIdx !== null && transition !== 'none' && (
          <div
            key={`previous-${previous.path}`}
            className={`slideshow-frame previous leaving${transitionActive ? ' active' : ''}`}
          >
            <img
              className="slideshow-image"
              src={photoUrl(previous)}
              alt=""
              draggable={false}
              style={{
                objectFit: fit,
                objectPosition: focusForPhoto(previous, previousIdx, sizes.get(previous.path)),
                ...(kenBurns ? kenBurnsStyle(previous, previousIdx, durationMs, sizes.get(previous.path), 'exit') : {}),
              }}
            />
          </div>
        )}
        <div
          key={`current-${current.path}`}
          className={`slideshow-frame current entering${previous ? transitionActive ? ' active' : '' : ' active'}`}
        >
          <img
            className={`slideshow-image${currentReady ? ' ready' : ''}${kenBurns ? ' ken-burns' : ''}`}
            src={photoUrl(current)}
            alt=""
            draggable={false}
            style={{
              objectFit: fit,
              objectPosition: focusForPhoto(current, idx, sizes.get(current.path)),
              ...(kenBurns ? kenBurnsStyle(current, idx, durationMs, sizes.get(current.path)) : {}),
            }}
          />
        </div>
      </div>

      <div className="slideshow-topbar">
        <div className="slideshow-count">{idx + 1} / {photos.length}</div>
        <div className="slideshow-actions">
          <button className="slideshow-btn" onClick={goPrev} aria-label="Previous">Prev</button>
          <button className="slideshow-btn" onClick={goNext} aria-label="Next">Next</button>
          <button className="slideshow-btn primary" onClick={onClose}>Exit</button>
        </div>
      </div>

      <div className="slideshow-progress">
        <div style={{ width: `${((idx + 1) / photos.length) * 100}%` }} />
      </div>
    </div>
  )
}
