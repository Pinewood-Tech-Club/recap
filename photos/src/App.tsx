import { useState, useEffect, useMemo, useCallback } from 'react'
import { Photo, CategoryNode, Person } from './types'
import Sidebar from './components/Sidebar'
import Gallery from './components/Gallery'
import Lightbox from './components/Lightbox'

interface PeopleData {
  people: Person[]
  slugs: Record<string, string[]>
}

interface CategoriesData {
  tree: CategoryNode[]
  counts: Record<string, number>
}

export default function App() {
  const [allPhotos, setAllPhotos] = useState<Photo[]>([])
  const [categories, setCategories] = useState<CategoryNode[]>([])
  const [categoryCounts, setCategoryCounts] = useState<Record<string, number>>({})
  const [people, setPeople] = useState<Person[]>([])
  const [personSlugs, setPersonSlugs] = useState<Record<string, string[]>>({})
  const [loading, setLoading] = useState(true)

  // Filters
  const [selectedSlugs, setSelectedSlugs] = useState<Set<string>>(new Set())
  const [sources, setSources] = useState<Set<string>>(new Set(['smugmug', 'yearbook', 'robotics']))
  const [person, setPerson] = useState<string>('')

  // Lightbox
  const [lightboxIdx, setLightboxIdx] = useState<number>(-1)

  // Precompute personSlugsSet for sidebar
  const personSlugsSet = useMemo<Map<string, Set<string>>>(() => {
    const map = new Map<string, Set<string>>()
    for (const [name, slugList] of Object.entries(personSlugs)) {
      map.set(name, new Set(slugList))
    }
    return map
  }, [personSlugs])

  useEffect(() => {
    const BASE = 'https://photos.recap.pinewood.one'
    Promise.all([
      fetch(`${BASE}/index/photos.json`).then(r => r.json()),
      fetch(`${BASE}/index/categories.json`).then(r => r.json()),
      fetch(`${BASE}/index/people.json`).then(r => r.json()),
    ]).then(([photos, cats, ppl]: [Photo[], CategoriesData, PeopleData]) => {
      setAllPhotos(photos)
      setCategories(cats.tree)
      setCategoryCounts(cats.counts)
      setPeople(ppl.people)
      setPersonSlugs(ppl.slugs)
      setLoading(false)
    }).catch(err => {
      console.error('Failed to load index data:', err)
      setLoading(false)
    })
  }, [])

  const filteredPhotos = useMemo<Photo[]>(() => {
    let photos = allPhotos

    // Filter by source
    if (sources.size < 3) {
      photos = photos.filter(p => sources.has(p.source))
    }

    // Filter by selected slugs
    if (selectedSlugs.size > 0) {
      photos = photos.filter(p => p.slugs.some(s => selectedSlugs.has(s)))
    }

    // Filter by person and sort by that person's face score descending
    if (person) {
      photos = photos.filter(p => p.faces.some(f => f.name === person))
      photos = [...photos].sort((a, b) => {
        const sa = a.faces.find(f => f.name === person)?.score ?? 0
        const sb = b.faces.find(f => f.name === person)?.score ?? 0
        return sb - sa
      })
    }

    return photos
  }, [allPhotos, sources, selectedSlugs, person])

  const handleToggleSource = useCallback((src: string) => {
    setSources(prev => {
      const next = new Set(prev)
      if (next.has(src)) next.delete(src)
      else next.add(src)
      return next
    })
  }, [])

  const handleSetSelectedSlugs = useCallback((next: Set<string>) => {
    setSelectedSlugs(new Set(next))
  }, [])

  const handleSelectAll = useCallback(() => {
    // Collect all leaf slugs
    function collectLeaves(nodes: CategoryNode[]): string[] {
      const result: string[] = []
      for (const node of nodes) {
        if (node.albums) result.push(node.slug)
        if (node.subcategories) result.push(...collectLeaves(node.subcategories))
      }
      return result
    }
    const all = collectLeaves(categories)
    setSelectedSlugs(new Set(all))
  }, [categories])

  const handleClearAll = useCallback(() => {
    setSelectedSlugs(new Set())
  }, [])

  if (loading) {
    return (
      <div className="loading-overlay">
        <span>Loading photos...</span>
      </div>
    )
  }

  return (
    <div className="app-layout">
      <Sidebar
        categories={categories}
        categoryCounts={categoryCounts}
        people={people}
        personSlugs={personSlugs}
        personSlugsSet={personSlugsSet}
        selectedSlugs={selectedSlugs}
        person={person}
        onSetSelectedSlugs={handleSetSelectedSlugs}
        onSelectAll={handleSelectAll}
        onClearAll={handleClearAll}
        onSetPerson={setPerson}
      />
      <div className="main-area">
        {/* Toolbar */}
        <div className="toolbar">
          <div className="toolbar-group">
            <span className="toolbar-label">Source</span>
            {(['smugmug', 'yearbook', 'robotics'] as const).map(src => (
              <span
                key={src}
                className={`src-pill ${sources.has(src) ? `on-${src}` : 'off'}`}
                onClick={() => handleToggleSource(src)}
              >
                {src === 'smugmug' ? 'SmugMug' : src.charAt(0).toUpperCase() + src.slice(1)}
              </span>
            ))}
          </div>
          <span className="toolbar-status">
            {filteredPhotos.length.toLocaleString()} photo{filteredPhotos.length !== 1 ? 's' : ''}
            {allPhotos.length !== filteredPhotos.length && ` of ${allPhotos.length.toLocaleString()}`}
          </span>
        </div>
        <Gallery
          photos={filteredPhotos}
          onPhotoClick={setLightboxIdx}
        />
      </div>
      {lightboxIdx >= 0 && (
        <Lightbox
          photos={filteredPhotos}
          idx={lightboxIdx}
          onClose={() => setLightboxIdx(-1)}
          onNav={setLightboxIdx}
        />
      )}
    </div>
  )
}
