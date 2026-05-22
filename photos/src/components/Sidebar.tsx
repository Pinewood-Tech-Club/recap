import { useState, useRef, useEffect, useCallback } from 'react'
import { CategoryNode, Person } from '../types'

interface SidebarProps {
  categories: CategoryNode[]
  categoryCounts: Record<string, number>
  people: Person[]
  personSlugs: Record<string, string[]>
  personSlugsSet: Map<string, Set<string>>
  selectedSlugs: Set<string>
  person: string
  onSetSelectedSlugs: (slugs: Set<string>) => void
  onSelectAll: () => void
  onClearAll: () => void
  onSetPerson: (name: string) => void
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
    ? people.filter(p => p.name.toLowerCase().includes(query.trim().toLowerCase()))
    : people

  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) {
        setOpen(false)
      }
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

  return (
    <div className="person-search-wrap" ref={wrapRef}>
      <div className="sidebar-title">Person</div>
      <div className="person-search-input-wrap">
        <span className="person-search-icon">⌕</span>
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
          <button className="person-search-clear" onClick={handleClear} title="Clear">×</button>
        )}
      </div>
      {person && !open && (
        <div className="person-selected-chip">
          <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {person}
          </span>
          <button onClick={() => onSetPerson('')} title="Clear person filter">×</button>
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
                <span className="person-dropdown-item-name">{p.name}</span>
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
  _cat: CategoryNode
}

function buildTreeNodes(cats: CategoryNode[], depth: number): TreeNode[] {
  return cats.map(cat => ({
    slug: cat.slug,
    name: cat.name,
    isLeaf: Array.isArray(cat.albums),
    depth,
    children: cat.subcategories ? buildTreeNodes(cat.subcategories, depth + 1) : [],
    _cat: cat,
  }))
}

function getLeaves(node: TreeNode): TreeNode[] {
  if (node.isLeaf) return [node]
  return node.children.flatMap(getLeaves)
}

function getNodeCount(node: TreeNode, counts: Record<string, number>): number {
  if (node.isLeaf) return counts[node.slug] ?? 0
  return node.children.reduce((s, c) => s + getNodeCount(c, counts), 0)
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
  counts: Record<string, number>
  selected: Set<string>
  person: string
  personSlugsSet: Map<string, Set<string>>
  initialOpen: boolean
  filterQuery: string
  onToggle: (node: TreeNode) => void
}

function TreeNodeEl({ node, counts, selected, person, personSlugsSet, initialOpen, filterQuery, onToggle }: TreeNodeProps) {
  const [open, setOpen] = useState(initialOpen)

  // Reset open state when filter changes to show matched nodes
  useEffect(() => {
    if (filterQuery) setOpen(true)
  }, [filterQuery])

  const state = getNodeState(node, selected)
  const count = getNodeCount(node, counts)

  // Determine struck state (person filter dimming)
  const isStruck = (() => {
    if (!person) return false
    const pSlugs = personSlugsSet.get(person)
    if (!pSlugs) return true
    return !getLeaves(node).some(l => pSlugs.has(l.slug))
  })()

  // Filter logic
  const matchesFilter = !filterQuery || node.name.toLowerCase().includes(filterQuery.toLowerCase())
  const childrenMatchFilter = !filterQuery || node.children.some(c => doesAnyMatch(c, filterQuery))

  function doesAnyMatch(n: TreeNode, q: string): boolean {
    if (n.name.toLowerCase().includes(q.toLowerCase())) return true
    return n.children.some(c => doesAnyMatch(c, q))
  }

  if (filterQuery && !matchesFilter && !childrenMatchFilter) return null

  function applyRef(el: HTMLInputElement | null) {
    if (!el) return
    el.checked = state === 'on'
    el.indeterminate = state === 'mid'
  }

  const indent = 8 + node.depth * 16

  return (
    <div className="tree-node">
      <div
        className="tree-row"
        style={{ paddingLeft: indent }}
        onClick={() => onToggle(node)}
      >
        <span
          className="tree-toggle"
          onClick={e => {
            if (!node.isLeaf && node.children.length > 0) {
              e.stopPropagation()
              setOpen(o => !o)
            }
          }}
        >
          {!node.isLeaf && node.children.length > 0 ? (open ? '▾' : '▸') : ''}
        </span>
        <input
          ref={applyRef}
          type="checkbox"
          className="tree-cb"
          onClick={e => { e.stopPropagation(); onToggle(node) }}
          readOnly
        />
        <span className={`tree-label${node.isLeaf ? '' : ' branch'}${isStruck ? ' struck' : ''}`}>
          {node.name}
        </span>
        {count > 0 && (
          <span className={`tree-count${isStruck ? ' struck' : ''}`}>{count}</span>
        )}
      </div>
      {!node.isLeaf && node.children.length > 0 && (
        <div className={`tree-children${open ? '' : ' collapsed'}`}>
          {node.children.map(child => (
            <TreeNodeEl
              key={child.slug}
              node={child}
              counts={counts}
              selected={selected}
              person={person}
              personSlugsSet={personSlugsSet}
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
  categoryCounts,
  people,
  personSlugs: _personSlugs,
  personSlugsSet,
  selectedSlugs,
  person,
  onSetSelectedSlugs,
  onSelectAll,
  onClearAll,
  onSetPerson,
}: SidebarProps) {
  const [treeFilter, setTreeFilter] = useState('')

  const treeNodes = buildTreeNodes(categories, 0)

  const handleToggle = useCallback((node: TreeNode) => {
    const state = getNodeState(node, selectedSlugs)
    const leaves = getLeaves(node)
    const next = new Set(selectedSlugs)
    if (state === 'on') {
      leaves.forEach(l => next.delete(l.slug))
    } else {
      leaves.forEach(l => next.add(l.slug))
    }
    onSetSelectedSlugs(next)
  }, [selectedSlugs, onSetSelectedSlugs])

  return (
    <aside className="sidebar">
      <div className="sidebar-header">
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
              counts={categoryCounts}
              selected={selectedSlugs}
              person={person}
              personSlugsSet={personSlugsSet}
              initialOpen={true}
              filterQuery={treeFilter}
              onToggle={handleToggle}
            />
          ))}
        </div>
      </div>
    </aside>
  )
}
