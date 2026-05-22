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
  count: number
}
