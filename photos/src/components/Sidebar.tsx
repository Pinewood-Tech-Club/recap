import { useState, useRef, useEffect, useCallback } from 'react'
import { CategoryNode, FacePresence, PeopleMode, Person, PhotoSource, SlideshowFit, SlideshowTransition, SortMode } from '../types'

interface SidebarProps {
  categories: CategoryNode[]
  selectedSlugs: Set<string>
  people: Person[]
  selectedPeople: Set<string>
  peopleMode: PeopleMode
  source: PhotoSource | ''
  sortMode: SortMode
  advancedOpen: boolean
  seed: string
  faceThreshold: number
  minFaces: number
  maxFaces: number
  facePresence: FacePresence
  linkCopied: boolean
  slideshowDuration: number
  slideshowTransitionDuration: number
  slideshowTransition: SlideshowTransition
  slideshowFit: SlideshowFit
  slideshowKenBurns: boolean
  slideshowBrowserFullscreen: boolean
  slideshowPreparing: boolean
  slideshowPhotoCount: number
  includeAdvancedInUrl: boolean
  sheetOpen: boolean
  onSetSelectedSlugs: (slugs: Set<string>) => void
  onSetSelectedPeople: (people: Set<string>) => void
  onSetPeopleMode: (mode: PeopleMode) => void
  onSetSource: (source: PhotoSource | '') => void
  onSetSortMode: (sort: SortMode) => void
  onSetAdvancedOpen: (open: boolean) => void
  onSetSeed: (seed: string) => void
  onSetFaceThreshold: (threshold: number) => void
  onSetMinFaces: (count: number) => void
  onSetMaxFaces: (count: number) => void
  onSetFacePresence: (presence: FacePresence) => void
  onSetSlideshowDuration: (seconds: number) => void
  onSetSlideshowTransitionDuration: (seconds: number) => void
  onSetSlideshowTransition: (transition: SlideshowTransition) => void
  onSetSlideshowFit: (fit: SlideshowFit) => void
  onSetSlideshowKenBurns: (enabled: boolean) => void
  onSetSlideshowBrowserFullscreen: (fullscreen: boolean) => void
  onStartSlideshow: () => void
  onSetIncludeAdvancedInUrl: (include: boolean) => void
  onClearAll: () => void
  onCopyLink: () => void
  onCloseSheet: () => void
}

// ── Icons ────────────────────────────────────────────────────────────────────

const IconSearch = () => (
  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round">
    <circle cx="11" cy="11" r="7" /><line x1="21" y1="21" x2="16.5" y2="16.5" />
  </svg>
)
const IconClose = ({ size = 12 }: { size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round">
    <line x1="5" y1="5" x2="19" y2="19" /><line x1="19" y1="5" x2="5" y2="19" />
  </svg>
)
const IconChevron = () => (
  <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
    <polyline points="9 6 15 12 9 18" />
  </svg>
)
const IconBrand = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <rect x="3" y="5" width="18" height="14" rx="3" /><circle cx="8.5" cy="10" r="1.6" /><path d="M21 16l-5-5-9 8" />
  </svg>
)
const IconShare = () => (
  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M4 12v7a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-7" /><path d="M16 6l-4-4-4 4" /><path d="M12 2v13" />
  </svg>
)

function TreeCheck({ state }: { state: CheckState }) {
  return (
    <span className={`tree-check ${state}`}>
      {state === 'on' && (
        <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3.5" strokeLinecap="round" strokeLinejoin="round">
          <polyline points="20 6 9 17 4 12" />
        </svg>
      )}
      {state === 'mid' && (
        <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3.5" strokeLinecap="round">
          <line x1="6" y1="12" x2="18" y2="12" />
        </svg>
      )}
    </span>
  )
}

// ── Person Search ──────────────────────────────────────────────────────────────

interface PersonSearchProps {
  people: Person[]
  selectedPeople: Set<string>
  advancedOpen: boolean
  onSetSelectedPeople: (people: Set<string>) => void
}

function PersonSearch({ people, selectedPeople, advancedOpen, onSetSelectedPeople }: PersonSearchProps) {
  const [query, setQuery] = useState('')
  const [open, setOpen] = useState(false)
  const wrapRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  const filtered = query.trim()
    ? people.filter(p => {
        const q = query.trim().toLowerCase()
        return (
          p.name.toLowerCase().includes(q) ||
          (p.display_name?.toLowerCase() ?? '').includes(q)
        )
      })
    : people

  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', handleClick)
    return () => document.removeEventListener('mousedown', handleClick)
  }, [])

  function handleSelect(name: string) {
    const next = new Set(advancedOpen ? selectedPeople : [])
    if (advancedOpen && next.has(name)) next.delete(name)
    else next.add(name)
    onSetSelectedPeople(next)
    setQuery('')
    setOpen(advancedOpen)
  }

  function handleClear() {
    onSetSelectedPeople(new Set())
    setQuery('')
    inputRef.current?.focus()
  }

  const selected = [...selectedPeople]
    .map(name => people.find(p => p.name === name))
    .filter(Boolean) as Person[]

  return (
    <div className="person-search-wrap" ref={wrapRef}>
      <div className="sidebar-title">Person</div>
      <div className="person-search-input-wrap">
        <span className="person-search-icon"><IconSearch /></span>
        <input
          ref={inputRef}
          className="person-search-input"
          type="text"
          placeholder="Search people…"
          value={query}
          onChange={e => { setQuery(e.target.value); setOpen(true) }}
          onFocus={() => setOpen(true)}
        />
        {(query || selectedPeople.size > 0) && (
          <button className="person-search-clear" onClick={handleClear} title="Clear" aria-label="Clear"><IconClose /></button>
        )}
      </div>
      {selected.length > 0 && !open && (
        <div className="person-chip-list">
          {selected.map(person => (
            <div className="person-selected-chip" key={person.name}>
              <span>{person.display_name || person.name}</span>
              <button
                onClick={() => {
                  const next = new Set(selectedPeople)
                  next.delete(person.name)
                  onSetSelectedPeople(next)
                }}
                title="Clear person filter"
                aria-label="Clear person filter"
              >
                <IconClose size={10} />
              </button>
            </div>
          ))}
        </div>
      )}
      {open && (
        <div className="person-dropdown">
          {filtered.length === 0 ? (
            <div className="person-dropdown-empty">No results</div>
          ) : (
            filtered.map(p => (
              <div
                key={p.name}
                className={`person-dropdown-item ${selectedPeople.has(p.name) ? 'active' : ''}`}
                onMouseDown={e => { e.preventDefault(); handleSelect(p.name) }}
              >
                <div className="person-dropdown-item-info">
                  <span className="person-dropdown-item-name">{p.display_name || p.name}</span>
                  {p.display_name && (
                    <span className="person-dropdown-item-username">{p.name}</span>
                  )}
                </div>
                <span className="person-dropdown-item-count">{p.count}</span>
              </div>
            ))
          )}
        </div>
      )}
    </div>
  )
}

function sourceLabel(source: PhotoSource) {
  if (source === 'smugmug') return 'SmugMug'
  if (source === 'yearbook') return 'Yearbook'
  return 'Robotics'
}

// ── Category Tree ──────────────────────────────────────────────────────────────

interface TreeNode {
  slug: string
  name: string
  isLeaf: boolean
  depth: number
  children: TreeNode[]
}

function buildTreeNodes(cats: CategoryNode[], depth: number): TreeNode[] {
  return cats.map(cat => ({
    slug: cat.slug,
    name: cat.name,
    isLeaf: Array.isArray(cat.albums),
    depth,
    children: cat.subcategories ? buildTreeNodes(cat.subcategories, depth + 1) : [],
  }))
}

function getLeaves(node: TreeNode): TreeNode[] {
  if (node.isLeaf) return [node]
  return node.children.flatMap(getLeaves)
}

type CheckState = 'on' | 'off' | 'mid'

function getNodeState(node: TreeNode, selected: Set<string>): CheckState {
  if (node.isLeaf) return selected.has(node.slug) ? 'on' : 'off'
  const leaves = getLeaves(node)
  const n = leaves.filter(l => selected.has(l.slug)).length
  if (n === 0) return 'off'
  if (n === leaves.length) return 'on'
  return 'mid'
}

interface TreeNodeProps {
  node: TreeNode
  selected: Set<string>
  initialOpen: boolean
  filterQuery: string
  onToggle: (node: TreeNode) => void
}

function doesAnyMatch(n: TreeNode, q: string): boolean {
  if (n.name.toLowerCase().includes(q.toLowerCase())) return true
  return n.children.some(c => doesAnyMatch(c, q))
}

function TreeNodeEl({ node, selected, initialOpen, filterQuery, onToggle }: TreeNodeProps) {
  const [open, setOpen] = useState(initialOpen)

  useEffect(() => {
    if (filterQuery) setOpen(true)
  }, [filterQuery])

  const state = getNodeState(node, selected)

  const matchesFilter = !filterQuery || node.name.toLowerCase().includes(filterQuery.toLowerCase())
  const childrenMatchFilter = !filterQuery || node.children.some(c => doesAnyMatch(c, filterQuery))

  if (filterQuery && !matchesFilter && !childrenMatchFilter) return null

  const hasChildren = !node.isLeaf && node.children.length > 0
  const indent = 8 + node.depth * 16

  return (
    <div className="tree-node">
      <div
        className={`tree-row${state === 'on' ? ' selected' : ''}`}
        style={{ paddingLeft: indent }}
        onClick={() => onToggle(node)}
      >
        <span
          className={`tree-toggle${hasChildren ? '' : ' leaf'}${open ? ' open' : ''}`}
          onClick={e => {
            if (hasChildren) {
              e.stopPropagation()
              setOpen(o => !o)
            }
          }}
        >
          {hasChildren && <IconChevron />}
        </span>
        <TreeCheck state={state} />
        <span className={`tree-label${node.isLeaf ? '' : ' branch'}`}>
          {node.name}
        </span>
      </div>
      {!node.isLeaf && node.children.length > 0 && (
        <div className={`tree-children${open ? '' : ' collapsed'}`}>
          {node.children.map(child => (
            <TreeNodeEl
              key={child.slug}
              node={child}
              selected={selected}
              initialOpen={false}
              filterQuery={filterQuery}
              onToggle={onToggle}
            />
          ))}
        </div>
      )}
    </div>
  )
}

// ── Sidebar ────────────────────────────────────────────────────────────────────

export default function Sidebar({
  categories,
  selectedSlugs,
  people,
  selectedPeople,
  peopleMode,
  source,
  sortMode,
  advancedOpen,
  seed,
  faceThreshold,
  minFaces,
  maxFaces,
  facePresence,
  linkCopied,
  slideshowDuration,
  slideshowTransitionDuration,
  slideshowTransition,
  slideshowFit,
  slideshowKenBurns,
  slideshowBrowserFullscreen,
  slideshowPreparing,
  slideshowPhotoCount,
  includeAdvancedInUrl,
  sheetOpen,
  onSetSelectedSlugs,
  onSetSelectedPeople,
  onSetPeopleMode,
  onSetSource,
  onSetSortMode,
  onSetAdvancedOpen,
  onSetSeed,
  onSetFaceThreshold,
  onSetMinFaces,
  onSetMaxFaces,
  onSetFacePresence,
  onSetSlideshowDuration,
  onSetSlideshowTransitionDuration,
  onSetSlideshowTransition,
  onSetSlideshowFit,
  onSetSlideshowKenBurns,
  onSetSlideshowBrowserFullscreen,
  onStartSlideshow,
  onSetIncludeAdvancedInUrl,
  onClearAll,
  onCopyLink,
  onCloseSheet,
}: SidebarProps) {
  const [treeFilter, setTreeFilter] = useState('')
  const treeNodes = buildTreeNodes(categories, 0)

  const handleToggle = useCallback((node: TreeNode) => {
    const state = getNodeState(node, selectedSlugs)
    const leaves = getLeaves(node)
    const next = new Set(selectedSlugs)
    if (state === 'on') leaves.forEach(l => next.delete(l.slug))
    else leaves.forEach(l => next.add(l.slug))
    onSetSelectedSlugs(next)
  }, [selectedSlugs, onSetSelectedSlugs])

  return (
    <aside className={`sidebar${sheetOpen ? ' sheet-open' : ''}`}>
      <div className="sheet-handle" />

      <div className="sidebar-section sidebar-brand">
        <span className="sidebar-brand-mark"><IconBrand /></span>
        <span className="sidebar-brand-name">Recap</span>
        <button
          className={`sidebar-share-btn${linkCopied ? ' copied' : ''}`}
          onClick={onCopyLink}
          title={linkCopied ? 'Copied' : 'Copy link'}
          aria-label={linkCopied ? 'Copied link' : 'Copy link'}
        >
          <IconShare />
          <span>{linkCopied ? 'Copied' : 'Copy link'}</span>
        </button>
      </div>

      <div className="sidebar-section sidebar-header">
        <PersonSearch
          people={people}
          selectedPeople={selectedPeople}
          advancedOpen={advancedOpen}
          onSetSelectedPeople={onSetSelectedPeople}
        />

        <button
          className={`advanced-toggle${advancedOpen ? ' open' : ''}`}
          onClick={() => onSetAdvancedOpen(!advancedOpen)}
          aria-expanded={advancedOpen}
        >
          <span>Advanced</span>
          <IconChevron />
        </button>

        {advancedOpen && (
          <div className="advanced-panel">
            <label className="toggle-field">
              <span>
                <span className="field-label">Include advanced settings in link</span>
                <span className="field-description">When off, copied links keep only people, categories, and the current photo.</span>
              </span>
              <input
                type="checkbox"
                checked={includeAdvancedInUrl}
                onChange={e => onSetIncludeAdvancedInUrl(e.target.checked)}
              />
            </label>

            <div className="advanced-group">
              <div>
                <span className="field-label">Slideshow</span>
                <span className="field-description">Play the current filtered photos for a TV, projector, or cast screen.</span>
              </div>

              <div className="number-row">
                <label className="control-field">
                  <span className="field-label">Transition</span>
                  <span className="field-description">How photos change.</span>
                  <select
                    className="control-select"
                    value={slideshowTransition}
                    onChange={e => onSetSlideshowTransition(e.target.value as SlideshowTransition)}
                  >
                    <option value="none">None</option>
                    <option value="dissolve">Dissolve</option>
                    <option value="slide">Slide</option>
                  </select>
                </label>
              </div>

              <label className="control-field">
                <span className="field-label">Photo duration {slideshowDuration}s</span>
                <span className="field-description">Most slideshows feel best between 3 and 15 seconds.</span>
                <div className="range-number-field">
                  <input
                    className="control-range"
                    type="range"
                    min="3"
                    max="15"
                    step="1"
                    value={Math.min(15, Math.max(3, slideshowDuration))}
                    onChange={e => onSetSlideshowDuration(Number(e.target.value))}
                  />
                  <input
                    className="control-input compact-number"
                    type="number"
                    min="1"
                    step="1"
                    value={slideshowDuration}
                    onChange={e => onSetSlideshowDuration(Math.max(1, Math.round(Number(e.target.value) || 5)))}
                  />
                </div>
              </label>

              <label className="control-field">
                <span className="field-label">Transition duration {slideshowTransitionDuration.toFixed(1)}s</span>
                <span className="field-description">Controls how long dissolve and slide transitions take.</span>
                <div className="range-number-field">
                  <input
                    className="control-range"
                    type="range"
                    min="0.1"
                    max="3"
                    step="0.1"
                    value={Math.min(3, Math.max(0.1, slideshowTransitionDuration))}
                    onChange={e => onSetSlideshowTransitionDuration(Number(e.target.value))}
                  />
                  <input
                    className="control-input compact-number"
                    type="number"
                    min="0"
                    step="0.1"
                    value={slideshowTransitionDuration}
                    onChange={e => onSetSlideshowTransitionDuration(Math.max(0, Number(e.target.value) || 0))}
                  />
                </div>
              </label>

              <div className="number-row">
                <label className="control-field">
                  <span className="field-label">Image fit</span>
                  <span className="field-description">Fit entire photo or fill the screen.</span>
                  <select
                    className="control-select"
                    value={slideshowFit}
                    onChange={e => onSetSlideshowFit(e.target.value as SlideshowFit)}
                  >
                    <option value="contain">Fit</option>
                    <option value="cover">Fill</option>
                  </select>
                </label>

                <label className="toggle-field">
                  <span>
                    <span className="field-label">Fullscreen browser</span>
                    <span className="field-description">Ask the browser to enter presentation fullscreen.</span>
                  </span>
                  <input
                    type="checkbox"
                    checked={slideshowBrowserFullscreen}
                    onChange={e => onSetSlideshowBrowserFullscreen(e.target.checked)}
                  />
                </label>
              </div>

              <label className="toggle-field">
                <span>
                  <span className="field-label">Ken Burns</span>
                  <span className="field-description">Subtly pans and zooms toward detected faces.</span>
                </span>
                <input
                  type="checkbox"
                  checked={slideshowKenBurns}
                  onChange={e => onSetSlideshowKenBurns(e.target.checked)}
                />
              </label>

              <button
                className="slideshow-start-btn"
                onClick={onStartSlideshow}
                disabled={slideshowPreparing || slideshowPhotoCount === 0}
              >
                {slideshowPreparing ? 'Preparing...' : `Start slideshow${slideshowPhotoCount > 0 ? ` (${slideshowPhotoCount})` : ''}`}
              </button>
            </div>

            <label className="control-field">
              <span className="field-label">Sort</span>
              <span className="field-description">Change the order photos appear in the grid.</span>
              <select
                id="sort-mode"
                className="control-select"
                value={sortMode}
                onChange={e => onSetSortMode(e.target.value as SortMode)}
              >
                <option value="default">Default</option>
                <option value="most-faces">Most faces</option>
                <option value="fewest-faces">Fewest faces</option>
                <option value="source">Source</option>
                <option value="album-spread">Album spread</option>
                <option value="shuffle">Seeded shuffle</option>
              </select>
            </label>

            <label className="control-field">
              <span className="field-label">Source</span>
              <span className="field-description">Limit results to one photo collection.</span>
              <select
                id="source-filter"
                className="control-select"
                value={source}
                onChange={e => onSetSource(e.target.value as PhotoSource | '')}
              >
                <option value="">All sources</option>
                {(['smugmug', 'yearbook', 'robotics'] as PhotoSource[]).map(value => (
                  <option key={value} value={value}>{sourceLabel(value)}</option>
                ))}
              </select>
            </label>

            {selectedPeople.size >= 2 && (
              <div className="control-field">
                <span className="field-label">People match</span>
                <span className="field-description">Choose whether photos need one selected person or every selected person.</span>
                <div className="segmented-control" aria-label="People match mode">
                  <button
                    className={peopleMode === 'any' ? 'active' : ''}
                    onClick={() => onSetPeopleMode('any')}
                  >
                    Any person
                  </button>
                  <button
                    className={peopleMode === 'all' ? 'active' : ''}
                    onClick={() => onSetPeopleMode('all')}
                  >
                    All people
                  </button>
                </div>
              </div>
            )}

            {(sortMode === 'shuffle' || sortMode === 'album-spread') && (
              <label className="control-field">
                <span className="field-label">Seed</span>
                <span className="field-description">Use the same text to get the same mixed order every time.</span>
                <input
                  className="control-input"
                  value={seed}
                  onChange={e => onSetSeed(e.target.value)}
                  placeholder="pinewood-recap"
                />
              </label>
            )}

            <label className="control-field">
              <span className="field-label">Faces</span>
              <span className="field-description">Show all photos, only photos with detected faces, or only photos without faces.</span>
              <select
                id="face-presence-filter"
                className="control-select"
                value={facePresence}
                onChange={e => onSetFacePresence(e.target.value as FacePresence)}
              >
                <option value="any">Any faces</option>
                <option value="with">Has faces</option>
                <option value="without">No faces</option>
              </select>
            </label>

            <label className="control-field">
              <span className="field-label">Face confidence {Math.round(faceThreshold * 100)}%</span>
              <span className="field-description">Lower values find more possible matches; higher values are stricter.</span>
              <input
                className="control-range"
                type="range"
                min="0.1"
                max="0.9"
                step="0.05"
                value={faceThreshold}
                onChange={e => onSetFaceThreshold(Number(e.target.value))}
              />
            </label>

            <div className="number-row">
              <label className="control-field">
                <span className="field-label">Min faces</span>
                <span className="field-description">Useful for finding group photos.</span>
                <input
                  className="control-input"
                  type="number"
                  min="0"
                  value={minFaces || ''}
                  onChange={e => onSetMinFaces(Math.max(0, Number(e.target.value) || 0))}
                  placeholder="Any"
                />
              </label>
              <label className="control-field">
                <span className="field-label">Max faces</span>
                <span className="field-description">Useful for finding portraits or small groups.</span>
                <input
                  className="control-input"
                  type="number"
                  min="0"
                  value={maxFaces || ''}
                  onChange={e => onSetMaxFaces(Math.max(0, Number(e.target.value) || 0))}
                  placeholder="Any"
                />
              </label>
            </div>
          </div>
        )}
      </div>

      <div className="tree-section">
        <div className="tree-section-header">
          <span className="tree-section-title">Categories</span>
          <div className="tree-controls">
            <button className="tree-ctrl-btn" onClick={onClearAll}>Reset</button>
          </div>
        </div>
        <div className="tree-filter-wrap">
          <input
            className="tree-filter-input"
            type="search"
            placeholder="Filter categories…"
            value={treeFilter}
            onChange={e => setTreeFilter(e.target.value)}
          />
        </div>
        <div className="tree-scroll">
          {treeNodes.map(node => (
            <TreeNodeEl
              key={node.slug}
              node={node}
              selected={selectedSlugs}
              initialOpen={true}
              filterQuery={treeFilter}
              onToggle={handleToggle}
            />
          ))}
        </div>
      </div>

      <div className="sheet-done-wrap">
        <button
          className={`sheet-copy-btn${linkCopied ? ' copied' : ''}`}
          onClick={onCopyLink}
        >
          {linkCopied ? 'Copied' : 'Copy link'}
        </button>
        <button className="sheet-done-btn" onClick={onCloseSheet}>Done</button>
      </div>
    </aside>
  )
}
