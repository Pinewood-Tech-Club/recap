import { useState, useRef, useEffect, useCallback } from 'react'
import { CategoryNode, Person } from '../types'

interface SidebarProps {
  categories: CategoryNode[]
  personSlugsSet: Map<string, Set<string>>
  selectedSlugs: Set<string>
  people: Person[]
  person: string
  sheetOpen: boolean
  nameToDisplay: Record<string, string>
  onSetSelectedSlugs: (slugs: Set<string>) => void
  onSelectAll: () => void
  onClearAll: () => void
  onSetPerson: (name: string) => void
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
  person: string
  onSetPerson: (name: string) => void
}

function PersonSearch({ people, person, onSetPerson }: PersonSearchProps) {
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
    onSetPerson(name)
    setQuery('')
    setOpen(false)
  }

  function handleClear() {
    onSetPerson('')
    setQuery('')
    inputRef.current?.focus()
  }

  const selectedPerson = people.find(p => p.name === person)
  const displayLabel = selectedPerson?.display_name || person

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
        {(query || person) && (
          <button className="person-search-clear" onClick={handleClear} title="Clear" aria-label="Clear"><IconClose /></button>
        )}
      </div>
      {person && !open && (
        <div className="person-selected-chip">
          <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {displayLabel}
          </span>
          <button onClick={() => onSetPerson('')} title="Clear person filter" aria-label="Clear person filter"><IconClose size={10} /></button>
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
                className={`person-dropdown-item ${p.name === person ? 'active' : ''}`}
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
  person,
  sheetOpen,
  onSetSelectedSlugs,
  onSelectAll,
  onClearAll,
  onSetPerson,
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
      </div>

      <div className="sidebar-section sidebar-header">
        <PersonSearch people={people} person={person} onSetPerson={onSetPerson} />
      </div>

      <div className="tree-section">
        <div className="tree-section-header">
          <span className="tree-section-title">Categories</span>
          <div className="tree-controls">
            <button className="tree-ctrl-btn" onClick={onSelectAll}>All</button>
            <button className="tree-ctrl-btn" onClick={onClearAll}>None</button>
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
        <button className="sheet-done-btn" onClick={onCloseSheet}>Done</button>
      </div>
    </aside>
  )
}
