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

const FACE_SCORE_THRESHOLD = 0.45

export default function App() {
  const [allPhotos, setAllPhotos] = useState<Photo[]>([])
  const [categories, setCategories] = useState<CategoryNode[]>([])
  const [people, setPeople] = useState<Person[]>([])
  const [personSlugs, setPersonSlugs] = useState<Record<string, string[]>>({})
  const [loading, setLoading] = useState(true)

  const [selectedSlugs, setSelectedSlugs] = useState<Set<string>>(new Set())
  const [person, setPerson] = useState<string>('')

  const [lightboxIdx, setLightboxIdx] = useState<number>(-1)
  const [filterSheetOpen, setFilterSheetOpen] = useState(false)

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
      setPeople(ppl.people)
      setPersonSlugs(ppl.slugs)
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
    if (person) {
      photos = photos.filter(p =>
        p.faces.some(f => f.name === person && f.score >= FACE_SCORE_THRESHOLD)
      )
      photos = [...photos].sort((a, b) => {
        const sa = a.faces.find(f => f.name === person)?.score ?? 0
        const sb = b.faces.find(f => f.name === person)?.score ?? 0
        return sb - sa
      })
    }
    return photos
  }, [allPhotos, selectedSlugs, person])

  const handleSetSelectedSlugs = useCallback((next: Set<string>) => {
    setSelectedSlugs(new Set(next))
  }, [])

  const handleSelectAll = useCallback(() => {
    function collectLeaves(nodes: CategoryNode[]): string[] {
      const result: string[] = []
      for (const node of nodes) {
        if (node.albums) result.push(node.slug)
        if (node.subcategories) result.push(...collectLeaves(node.subcategories))
      }
      return result
    }
    setSelectedSlugs(new Set(collectLeaves(categories)))
  }, [categories])

  const handleClearAll = useCallback(() => setSelectedSlugs(new Set()), [])

  const activeFilters = (person ? 1 : 0) + (selectedSlugs.size > 0 ? 1 : 0)

  if (loading) {
    return <div className="loading-overlay"><div className="loading-spinner" /></div>
  }

  return (
    <div className="app-layout">
      <Sidebar
        categories={categories}
        personSlugsSet={personSlugsSet}
        selectedSlugs={selectedSlugs}
        people={people}
        person={person}
        sheetOpen={filterSheetOpen}
        nameToDisplay={nameToDisplay}
        onSetSelectedSlugs={handleSetSelectedSlugs}
        onSelectAll={handleSelectAll}
        onClearAll={handleClearAll}
        onSetPerson={setPerson}
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
          onClose={() => setLightboxIdx(-1)}
          onNav={setLightboxIdx}
        />
      )}
    </div>
  )
}
