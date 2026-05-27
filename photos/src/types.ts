export interface Face {
  name: string
  score: number
  bbox: [number, number, number, number]
}

export interface Photo {
  path: string
  source: 'smugmug' | 'yearbook' | 'robotics'
  album: string
  faces: Face[]
  slugs: string[]
}

export interface CategoryNode {
  name: string
  slug: string
  albums?: unknown[]
  subcategories?: CategoryNode[]
}

export interface Person {
  name: string
  display_name?: string
  count: number
}

export type PhotoSource = Photo['source']

export type SortMode =
  | 'default'
  | 'most-faces'
  | 'fewest-faces'
  | 'source'
  | 'album-spread'
  | 'shuffle'

export type PeopleMode = 'any' | 'all'

export type FacePresence = 'any' | 'with' | 'without'

export type SlideshowTransition = 'none' | 'dissolve' | 'slide'

export type SlideshowFit = 'contain' | 'cover'
