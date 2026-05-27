import { useState, useEffect, useMemo, useCallback } from 'react'
import { Photo, CategoryNode, FacePresence, Person, PeopleMode, PhotoSource, SlideshowFit, SlideshowTransition, SortMode } from './types'
import Sidebar from './components/Sidebar'
import Gallery from './components/Gallery'
import Lightbox from './components/Lightbox'
import Slideshow from './components/Slideshow'

interface PeopleData {
  people: Person[]
  slugs: Record<string, string[]>
}

interface CategoriesData {
  tree: CategoryNode[]
  counts: Record<string, number>
}

const FACE_SCORE_THRESHOLD = 0.3
const DEFAULT_SEED = 'pinewood-recap'
const SOURCES: PhotoSource[] = ['smugmug', 'yearbook', 'robotics']
const RECAP_CODE = 'AA'
const SHARE_VERSION = 2
const SORT_MODES: SortMode[] = ['default', 'most-faces', 'fewest-faces', 'source', 'album-spread', 'shuffle']
const FACE_PRESENCES: FacePresence[] = ['any', 'with', 'without']

interface ShareState {
  slugs: string[]
  people: string[]
  peopleMode: PeopleMode
  source: PhotoSource | ''
  sortMode: SortMode
  advancedOpen: boolean
  seed: string
  faceThreshold: number
  minFaces: number
  maxFaces: number
  facePresence: FacePresence
  photoPath: string
}

interface DecodedShareState {
  peopleMode: PeopleMode
  source: PhotoSource | ''
  sortMode: SortMode
  advancedOpen: boolean
  seed: string
  faceThreshold: number
  minFaces: number
  maxFaces: number
  facePresence: FacePresence
  slugIds: number[]
  personIds: number[]
  photoId: number | null
}

function parseList(value: string | null): string[] {
  return value ? value.split(',').map(v => v.trim()).filter(Boolean) : []
}

function stableHash(value: string): number {
  let hash = 2166136261
  for (let i = 0; i < value.length; i += 1) {
    hash ^= value.charCodeAt(i)
    hash = Math.imul(hash, 16777619)
  }
  return hash >>> 0
}

function writeVarUint(bytes: number[], value: number) {
  let next = value >>> 0
  while (next >= 0x80) {
    bytes.push((next & 0x7f) | 0x80)
    next >>>= 7
  }
  bytes.push(next)
}

function readVarUint(bytes: Uint8Array, cursor: { value: number }) {
  let result = 0
  let shift = 0
  while (cursor.value < bytes.length) {
    const byte = bytes[cursor.value]
    cursor.value += 1
    result |= (byte & 0x7f) << shift
    if ((byte & 0x80) === 0) return result >>> 0
    shift += 7
    if (shift > 28) throw new Error('Invalid share code')
  }
  throw new Error('Invalid share code')
}

function bytesToBase64Url(bytes: number[]) {
  const binary = String.fromCharCode(...bytes)
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '')
}

function base64UrlToBytes(value: string) {
  const padded = value.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((value.length + 3) % 4)
  return Uint8Array.from(atob(padded), char => char.charCodeAt(0))
}

function isDefaultShareState(state: ShareState) {
  return (
    state.slugs.length === 0 &&
    state.people.length === 0 &&
    state.peopleMode === 'any' &&
    !state.source &&
    state.sortMode === 'default' &&
    !state.advancedOpen &&
    state.seed === DEFAULT_SEED &&
    state.faceThreshold === FACE_SCORE_THRESHOLD &&
    state.minFaces === 0 &&
    state.maxFaces === 0 &&
    state.facePresence === 'any' &&
    !state.photoPath
  )
}

function encodeShareCode(state: ShareState) {
  if (isDefaultShareState(state)) return ''

  const bytes = [
    SHARE_VERSION,
    SORT_MODES.indexOf(state.sortMode),
    state.source ? SOURCES.indexOf(state.source) + 1 : 0,
    (state.peopleMode === 'all' ? 1 : 0) | (state.advancedOpen ? 2 : 0),
    Math.round(state.faceThreshold * 100),
    Math.min(255, state.minFaces),
    Math.min(255, state.maxFaces),
    FACE_PRESENCES.indexOf(state.facePresence),
  ]

  const slugIds = state.slugs.map(stableHash).sort((a, b) => a - b)
  writeVarUint(bytes, slugIds.length)
  slugIds.forEach(id => writeVarUint(bytes, id))

  const personIds = state.people.map(stableHash).sort((a, b) => a - b)
  writeVarUint(bytes, personIds.length)
  personIds.forEach(id => writeVarUint(bytes, id))

  if (state.sortMode === 'shuffle' || state.sortMode === 'album-spread') {
    const seedBytes = [...new TextEncoder().encode(state.seed || DEFAULT_SEED)]
    writeVarUint(bytes, seedBytes.length)
    bytes.push(...seedBytes)
  }

  if (state.photoPath) {
    writeVarUint(bytes, 1)
    writeVarUint(bytes, stableHash(state.photoPath))
  } else {
    writeVarUint(bytes, 0)
  }

  return `${RECAP_CODE}${bytesToBase64Url(bytes)}`
}

function decodeShareCode(code: string | null): DecodedShareState | null {
  if (!code || code.length < 3 || code.slice(0, 2) !== RECAP_CODE) return null

  try {
    const bytes = base64UrlToBytes(code.slice(2))
    const cursor = { value: 0 }
    const version = bytes[cursor.value++]
    if (version !== 1 && version !== SHARE_VERSION) return null

    const sortMode = SORT_MODES[bytes[cursor.value++]] ?? 'default'
    const sourceIdx = bytes[cursor.value++]
    const flags = bytes[cursor.value++]
    const thresholdBucket = bytes[cursor.value++]
    const minFaces = bytes[cursor.value++] ?? 0
    const maxFaces = bytes[cursor.value++] ?? 0
    const facePresence = version >= 2 ? FACE_PRESENCES[bytes[cursor.value++]] ?? 'any' : 'any'

    const slugCount = readVarUint(bytes, cursor)
    const slugIds = Array.from({ length: slugCount }, () => readVarUint(bytes, cursor))

    const personCount = readVarUint(bytes, cursor)
    const personIds = Array.from({ length: personCount }, () => readVarUint(bytes, cursor))

    let seed = DEFAULT_SEED
    if (sortMode === 'shuffle' || sortMode === 'album-spread') {
      const seedLength = readVarUint(bytes, cursor)
      seed = new TextDecoder().decode(bytes.slice(cursor.value, cursor.value + seedLength)) || DEFAULT_SEED
      cursor.value += seedLength
    }

    const hasPhoto = readVarUint(bytes, cursor) === 1
    const photoId = hasPhoto ? readVarUint(bytes, cursor) : null

    return {
      peopleMode: flags & 1 ? 'all' : 'any',
      source: sourceIdx > 0 ? SOURCES[sourceIdx - 1] ?? '' : '',
      sortMode,
      advancedOpen: Boolean(flags & 2),
      seed,
      faceThreshold: Math.min(1, Math.max(0, thresholdBucket / 100)),
      minFaces,
      maxFaces,
      facePresence,
      slugIds,
      personIds,
      photoId,
    }
  } catch {
    return null
  }
}

function uniqueHashLookup(values: string[]) {
  const counts = new Map<number, number>()
  for (const value of values) {
    const id = stableHash(value)
    counts.set(id, (counts.get(id) ?? 0) + 1)
  }
  const lookup = new Map<number, string>()
  for (const value of values) {
    const id = stableHash(value)
    if (counts.get(id) === 1) lookup.set(id, value)
  }
  return lookup
}

function compareStable(a: Photo, b: Photo) {
  return a.path.localeCompare(b.path)
}

function faceCount(photo: Photo, threshold: number) {
  return photo.faces.filter(face => face.score >= threshold).length
}

function seededValue(photo: Photo, seed: string) {
  return stableHash(`${seed}:${photo.path}`)
}

function seededKey(value: string, seed: string) {
  return stableHash(`${seed}:${value}`)
}

function albumSpreadSort(photos: Photo[], seed: string) {
  const groups = new Map<string, Photo[]>()
  for (const photo of photos) {
    const key = photo.album || photo.source
    groups.set(key, [...(groups.get(key) ?? []), photo])
  }

  const orderedAlbums = [...groups.entries()]
    .map(([album, albumPhotos]) => ({
      album,
      photos: albumPhotos.sort((a, b) => seededValue(a, seed) - seededValue(b, seed) || compareStable(a, b)),
    }))
    .sort((a, b) => seededKey(a.album, seed) - seededKey(b.album, seed) || a.album.localeCompare(b.album))

  const result: Photo[] = []
  let cursor = 0
  while (result.length < photos.length) {
    for (const group of orderedAlbums) {
      if (group.photos[cursor]) result.push(group.photos[cursor])
    }
    cursor += 1
  }
  return result
}

function sourceLabel(source: PhotoSource) {
  if (source === 'smugmug') return 'SmugMug'
  if (source === 'yearbook') return 'Yearbook'
  return 'Robotics'
}

function collectCategorySlugs(nodes: CategoryNode[]): string[] {
  const result: string[] = []
  for (const node of nodes) {
    result.push(node.slug)
    if (node.subcategories) result.push(...collectCategorySlugs(node.subcategories))
  }
  return result
}

function decodedHasAdvancedState(state: DecodedShareState | null) {
  if (!state) return false
  return (
    state.peopleMode !== 'any' ||
    Boolean(state.source) ||
    state.sortMode !== 'default' ||
    state.advancedOpen ||
    state.seed !== DEFAULT_SEED ||
    state.faceThreshold !== FACE_SCORE_THRESHOLD ||
    state.minFaces > 0 ||
    state.maxFaces > 0 ||
    state.facePresence !== 'any'
  )
}

function preloadPhoto(photo: Photo) {
  return new Promise<void>(resolve => {
    const img = new Image()
    img.decoding = 'async'
    img.onload = async () => {
      try {
        await img.decode()
      } catch {
        // The browser can still paint an image that loaded but failed explicit decode.
      }
      resolve()
    }
    img.onerror = () => resolve()
    img.src = `https://photos.recap.pinewood.one/${photo.path}`
  })
}

export default function App() {
  const [allPhotos, setAllPhotos] = useState<Photo[]>([])
  const [categories, setCategories] = useState<CategoryNode[]>([])
  const [people, setPeople] = useState<Person[]>([])
  const [loading, setLoading] = useState(true)

  const initialParams = useMemo(() => new URLSearchParams(window.location.search), [])
  const decodedShare = useMemo(() => decodeShareCode(initialParams.get('s')), [initialParams])
  const [pendingShareState, setPendingShareState] = useState<DecodedShareState | null>(() => decodedShare)
  const [selectedSlugs, setSelectedSlugs] = useState<Set<string>>(() => new Set(decodedShare ? [] : parseList(initialParams.get('cats'))))
  const [selectedPeople, setSelectedPeople] = useState<Set<string>>(() => new Set(decodedShare ? [] : parseList(initialParams.get('people'))))
  const [peopleMode, setPeopleMode] = useState<PeopleMode>(() => decodedShare?.peopleMode ?? (initialParams.get('mode') === 'all' ? 'all' : 'any'))
  const [source, setSource] = useState<PhotoSource | ''>(() => {
    if (decodedShare) return decodedShare.source
    const value = initialParams.get('source')
    return SOURCES.includes(value as PhotoSource) ? value as PhotoSource : ''
  })
  const [sortMode, setSortMode] = useState<SortMode>(() => {
    if (decodedShare) return decodedShare.sortMode
    const value = initialParams.get('sort') as SortMode | null
    return value && SORT_MODES.includes(value) ? value : 'default'
  })
  const [advancedOpen, setAdvancedOpen] = useState(() => decodedShare?.advancedOpen ?? initialParams.get('advanced') === '1')
  const [seed, setSeed] = useState(() => decodedShare?.seed ?? (initialParams.get('seed') || DEFAULT_SEED))
  const [faceThreshold, setFaceThreshold] = useState(() => {
    if (decodedShare) return decodedShare.faceThreshold
    const raw = initialParams.get('threshold')
    const value = raw === null ? Number.NaN : Number(raw)
    return Number.isFinite(value) && value >= 0 && value <= 1 ? value : FACE_SCORE_THRESHOLD
  })
  const [minFaces, setMinFaces] = useState(() => {
    if (decodedShare) return decodedShare.minFaces
    const value = Number(initialParams.get('minFaces'))
    return Number.isFinite(value) && value > 0 ? Math.floor(value) : 0
  })
  const [maxFaces, setMaxFaces] = useState(() => {
    if (decodedShare) return decodedShare.maxFaces
    const value = Number(initialParams.get('maxFaces'))
    return Number.isFinite(value) && value > 0 ? Math.floor(value) : 0
  })
  const [facePresence, setFacePresence] = useState<FacePresence>(() => {
    if (decodedShare) return decodedShare.facePresence
    const value = initialParams.get('facePresence') as FacePresence | null
    return value && FACE_PRESENCES.includes(value) ? value : 'any'
  })

  const [lightboxIdx, setLightboxIdx] = useState<number>(-1)
  const [filterSheetOpen, setFilterSheetOpen] = useState(false)
  const [pendingPhotoPath, setPendingPhotoPath] = useState(() => decodedShare ? '' : initialParams.get('photo') || '')
  const [linkCopied, setLinkCopied] = useState(false)
  const [slideshowOpen, setSlideshowOpen] = useState(false)
  const [slideshowDuration, setSlideshowDuration] = useState(5)
  const [slideshowTransitionDuration, setSlideshowTransitionDuration] = useState(0.7)
  const [slideshowTransition, setSlideshowTransition] = useState<SlideshowTransition>('dissolve')
  const [slideshowFit, setSlideshowFit] = useState<SlideshowFit>('contain')
  const [slideshowKenBurns, setSlideshowKenBurns] = useState(true)
  const [slideshowBrowserFullscreen, setSlideshowBrowserFullscreen] = useState(true)
  const [slideshowPreparing, setSlideshowPreparing] = useState(false)
  const [includeAdvancedInUrl, setIncludeAdvancedInUrl] = useState(() => decodedHasAdvancedState(decodedShare))

  const slugToName = useMemo<Record<string, string>>(() => {
    const map: Record<string, string> = {}
    function walk(nodes: CategoryNode[]) {
      for (const n of nodes) {
        map[n.slug] = n.name
        if (n.subcategories) walk(n.subcategories)
      }
    }
    walk(categories)
    return map
  }, [categories])

  const nameToDisplay = useMemo<Record<string, string>>(() => {
    const map: Record<string, string> = {}
    for (const p of people) {
      if (p.display_name) map[p.name] = p.display_name
    }
    return map
  }, [people])

  useEffect(() => {
    if (!pendingShareState || categories.length === 0 || people.length === 0 || allPhotos.length === 0) return

    const slugLookup = uniqueHashLookup(collectCategorySlugs(categories))
    const personLookup = uniqueHashLookup(people.map(person => person.name))
    const photoLookup = uniqueHashLookup(allPhotos.map(photo => photo.path))

    setSelectedSlugs(new Set(pendingShareState.slugIds.flatMap(id => slugLookup.get(id) ?? [])))
    setSelectedPeople(new Set(pendingShareState.personIds.flatMap(id => personLookup.get(id) ?? [])))
    if (pendingShareState.photoId !== null) {
      setPendingPhotoPath(photoLookup.get(pendingShareState.photoId) ?? '')
    }
    setPendingShareState(null)
  }, [pendingShareState, categories, people, allPhotos])

  useEffect(() => {
    const BASE = 'https://photos.recap.pinewood.one'
    Promise.all([
      fetch(`${BASE}/index/photos.json`).then(r => r.json()),
      fetch(`${BASE}/index/categories.json`).then(r => r.json()),
      fetch(`${BASE}/index/people.json`).then(r => r.json()),
    ]).then(([photos, cats, ppl]: [Photo[], CategoriesData, PeopleData]) => {
      setAllPhotos(photos)
      setCategories(cats.tree)
      setPeople(ppl.people)
      setLoading(false)
    }).catch(() => setLoading(false))
  }, [])

  useEffect(() => {
    if (!filterSheetOpen) return
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') setFilterSheetOpen(false)
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [filterSheetOpen])

  const filteredPhotos = useMemo<Photo[]>(() => {
    let photos = allPhotos
    if (selectedSlugs.size > 0) {
      photos = photos.filter(p => p.slugs.some(s => selectedSlugs.has(s)))
    }
    if (selectedPeople.size > 0) {
      const hasPerson = (photo: Photo, name: string) =>
        photo.faces.some(f => f.name === name && f.score >= faceThreshold)
      photos = photos.filter(p => {
        const people = [...selectedPeople]
        return peopleMode === 'all'
          ? people.every(name => hasPerson(p, name))
          : people.some(name => hasPerson(p, name))
      })
    }
    if (source) {
      photos = photos.filter(p => p.source === source)
    }
    if (facePresence === 'with') {
      photos = photos.filter(p => faceCount(p, faceThreshold) > 0)
    } else if (facePresence === 'without') {
      photos = photos.filter(p => faceCount(p, faceThreshold) === 0)
    }
    if (minFaces > 0) {
      photos = photos.filter(p => faceCount(p, faceThreshold) >= minFaces)
    }
    if (maxFaces > 0) {
      photos = photos.filter(p => faceCount(p, faceThreshold) <= maxFaces)
    }

    const sorted = [...photos]
    if (sortMode === 'most-faces') {
      sorted.sort((a, b) => faceCount(b, faceThreshold) - faceCount(a, faceThreshold) || compareStable(a, b))
    } else if (sortMode === 'fewest-faces') {
      sorted.sort((a, b) => faceCount(a, faceThreshold) - faceCount(b, faceThreshold) || compareStable(a, b))
    } else if (sortMode === 'source') {
      sorted.sort((a, b) => sourceLabel(a.source).localeCompare(sourceLabel(b.source)) || compareStable(a, b))
    } else if (sortMode === 'album-spread') {
      return albumSpreadSort(sorted, seed || DEFAULT_SEED)
    } else if (sortMode === 'shuffle') {
      sorted.sort((a, b) => seededValue(a, seed || DEFAULT_SEED) - seededValue(b, seed || DEFAULT_SEED) || compareStable(a, b))
    } else if (selectedPeople.size > 0) {
      sorted.sort((a, b) => {
        const best = (photo: Photo) => Math.max(0, ...photo.faces
          .filter(f => selectedPeople.has(f.name))
          .map(f => f.score))
        return best(b) - best(a) || compareStable(a, b)
      })
    }
    return sorted
  }, [allPhotos, selectedSlugs, selectedPeople, peopleMode, source, facePresence, minFaces, maxFaces, sortMode, seed, faceThreshold])

  const shareState = useMemo<ShareState>(() => ({
    slugs: [...selectedSlugs].sort(),
    people: [...selectedPeople].sort(),
    peopleMode: includeAdvancedInUrl ? peopleMode : 'any',
    source: includeAdvancedInUrl ? source : '',
    sortMode: includeAdvancedInUrl ? sortMode : 'default',
    advancedOpen: includeAdvancedInUrl ? advancedOpen : false,
    seed: includeAdvancedInUrl ? seed : DEFAULT_SEED,
    faceThreshold: includeAdvancedInUrl ? faceThreshold : FACE_SCORE_THRESHOLD,
    minFaces: includeAdvancedInUrl ? minFaces : 0,
    maxFaces: includeAdvancedInUrl ? maxFaces : 0,
    facePresence: includeAdvancedInUrl ? facePresence : 'any',
    photoPath: lightboxIdx >= 0 ? filteredPhotos[lightboxIdx]?.path ?? '' : '',
  }), [selectedSlugs, selectedPeople, includeAdvancedInUrl, peopleMode, source, sortMode, advancedOpen, seed, faceThreshold, minFaces, maxFaces, facePresence, lightboxIdx, filteredPhotos])

  const compactShareCode = useMemo(() => encodeShareCode(shareState), [shareState])

  const shareUrl = useMemo(() => {
    const query = compactShareCode ? `?s=${compactShareCode}` : ''
    return `${window.location.origin}${window.location.pathname}${query}`
  }, [compactShareCode])

  useEffect(() => {
    if (pendingShareState) return
    const next = `${window.location.pathname}${compactShareCode ? `?s=${compactShareCode}` : ''}`
    if (`${window.location.pathname}${window.location.search}` !== next) {
      window.history.replaceState(null, '', next)
    }
  }, [pendingShareState, compactShareCode])

  useEffect(() => {
    if (!pendingPhotoPath || lightboxIdx >= 0 || filteredPhotos.length === 0) return
    const idx = filteredPhotos.findIndex(photo => photo.path === pendingPhotoPath)
    if (idx >= 0) {
      setLightboxIdx(idx)
      setPendingPhotoPath('')
    }
  }, [pendingPhotoPath, filteredPhotos, lightboxIdx])

  useEffect(() => {
    if (lightboxIdx >= filteredPhotos.length) setLightboxIdx(-1)
  }, [filteredPhotos.length, lightboxIdx])

  const handleSetSelectedSlugs = useCallback((next: Set<string>) => {
    setSelectedSlugs(new Set(next))
  }, [])

  const handleSetSelectedPeople = useCallback((next: Set<string>) => {
    setSelectedPeople(new Set(next))
  }, [])

  const handleClearAll = useCallback(() => setSelectedSlugs(new Set()), [])

  const handleCopyLink = useCallback(async () => {
    await navigator.clipboard.writeText(shareUrl)
    setLinkCopied(true)
    window.setTimeout(() => setLinkCopied(false), 1400)
  }, [shareUrl])

  const handleStartSlideshow = useCallback(async () => {
    if (filteredPhotos.length === 0) return
    setSlideshowPreparing(true)
    if (slideshowBrowserFullscreen) {
      document.documentElement.requestFullscreen?.().catch(() => {})
    }
    await Promise.all(filteredPhotos.slice(0, 5).map(preloadPhoto))
    setFilterSheetOpen(false)
    setLightboxIdx(-1)
    setSlideshowPreparing(false)
    setSlideshowOpen(true)
  }, [filteredPhotos, slideshowBrowserFullscreen])

  const activeFilters =
    (selectedPeople.size > 0 ? 1 : 0) +
    (selectedSlugs.size > 0 ? 1 : 0) +
    (source ? 1 : 0) +
    (facePresence !== 'any' ? 1 : 0) +
    (minFaces > 0 || maxFaces > 0 ? 1 : 0) +
    (faceThreshold !== FACE_SCORE_THRESHOLD ? 1 : 0)

  if (loading) {
    return <div className="loading-overlay"><div className="loading-spinner" /></div>
  }

  return (
    <div className="app-layout">
      <Sidebar
        categories={categories}
        selectedSlugs={selectedSlugs}
        people={people}
        selectedPeople={selectedPeople}
        peopleMode={peopleMode}
        source={source}
        sortMode={sortMode}
        advancedOpen={advancedOpen}
        seed={seed}
        faceThreshold={faceThreshold}
        minFaces={minFaces}
        maxFaces={maxFaces}
        facePresence={facePresence}
        linkCopied={linkCopied}
        slideshowDuration={slideshowDuration}
        slideshowTransitionDuration={slideshowTransitionDuration}
        slideshowTransition={slideshowTransition}
        slideshowFit={slideshowFit}
        slideshowKenBurns={slideshowKenBurns}
        slideshowBrowserFullscreen={slideshowBrowserFullscreen}
        slideshowPreparing={slideshowPreparing}
        slideshowPhotoCount={filteredPhotos.length}
        includeAdvancedInUrl={includeAdvancedInUrl}
        sheetOpen={filterSheetOpen}
        onSetSelectedSlugs={handleSetSelectedSlugs}
        onSetSelectedPeople={handleSetSelectedPeople}
        onSetPeopleMode={setPeopleMode}
        onSetSource={setSource}
        onSetSortMode={setSortMode}
        onSetAdvancedOpen={setAdvancedOpen}
        onSetSeed={setSeed}
        onSetFaceThreshold={setFaceThreshold}
        onSetMinFaces={setMinFaces}
        onSetMaxFaces={setMaxFaces}
        onSetFacePresence={setFacePresence}
        onSetSlideshowDuration={setSlideshowDuration}
        onSetSlideshowTransitionDuration={setSlideshowTransitionDuration}
        onSetSlideshowTransition={setSlideshowTransition}
        onSetSlideshowFit={setSlideshowFit}
        onSetSlideshowKenBurns={setSlideshowKenBurns}
        onSetSlideshowBrowserFullscreen={setSlideshowBrowserFullscreen}
        onStartSlideshow={handleStartSlideshow}
        onSetIncludeAdvancedInUrl={setIncludeAdvancedInUrl}
        onClearAll={handleClearAll}
        onCopyLink={handleCopyLink}
        onCloseSheet={() => setFilterSheetOpen(false)}
      />

      <div className={`sidebar-backdrop${filterSheetOpen ? ' open' : ''}`}
           onClick={() => setFilterSheetOpen(false)} />

      <div className="main-area">
        {/* Mobile filter button */}
        <button
          className="filter-fab"
          onClick={() => setFilterSheetOpen(true)}
          aria-label="Filters"
        >
          <svg width="17" height="17" viewBox="0 0 18 18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
            <line x1="2" y1="5" x2="16" y2="5"/>
            <line x1="5" y1="9" x2="13" y2="9"/>
            <line x1="7" y1="13" x2="11" y2="13"/>
          </svg>
          <span>Filters</span>
          {activeFilters > 0 && <span className="filter-fab-badge">{activeFilters}</span>}
        </button>

        <Gallery photos={filteredPhotos} onPhotoClick={setLightboxIdx} />
      </div>

      {lightboxIdx >= 0 && (
        <Lightbox
          photos={filteredPhotos}
          idx={lightboxIdx}
          slugToName={slugToName}
          nameToDisplay={nameToDisplay}
          onClose={() => {
            setPendingPhotoPath('')
            setLightboxIdx(-1)
          }}
          onNav={setLightboxIdx}
        />
      )}

      {slideshowOpen && (
        <Slideshow
          photos={filteredPhotos}
          durationMs={Math.max(2, slideshowDuration) * 1000}
          transitionDurationMs={Math.max(0, slideshowTransitionDuration) * 1000}
          transition={slideshowTransition}
          fit={slideshowFit}
          kenBurns={slideshowKenBurns}
          browserFullscreen={slideshowBrowserFullscreen}
          onClose={() => setSlideshowOpen(false)}
        />
      )}
    </div>
  )
}
