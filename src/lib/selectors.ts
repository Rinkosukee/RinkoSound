import type { AudioAsset, Playlist } from '../types'

export type LibrarySort = 'recent' | 'title' | 'duration' | 'artist'

export interface TrackQuery {
  search?: string
  sort?: LibrarySort
  kind?: AudioAsset['kind'] | 'all'
}

function matchesSearch(track: AudioAsset, search: string): boolean {
  const query = search.trim().toLocaleLowerCase()
  if (!query) return true
  return [track.title, track.artist, track.album, track.fileName, track.format]
    .join(' ')
    .toLocaleLowerCase()
    .includes(query)
}

/** Return all tracks in a stable, user-facing order. */
export function selectLibraryTracks(tracks: AudioAsset[], query: TrackQuery = {}): AudioAsset[] {
  const filtered = tracks.filter((track) =>
    (query.kind === undefined || query.kind === 'all' || track.kind === query.kind) &&
    matchesSearch(track, query.search || ''),
  )
  const sort = query.sort || 'recent'
  return [...filtered].sort((a, b) => {
    if (sort === 'title') return a.title.localeCompare(b.title, 'zh-CN') || b.createdAt - a.createdAt
    if (sort === 'artist') return a.artist.localeCompare(b.artist, 'zh-CN') || a.title.localeCompare(b.title, 'zh-CN')
    if (sort === 'duration') return b.duration - a.duration || b.createdAt - a.createdAt
    return b.createdAt - a.createdAt
  })
}

/** Recent means newest imported items; it has no arbitrary time cutoff. */
export function selectRecentTracks(tracks: AudioAsset[], search = ''): AudioAsset[] {
  return selectLibraryTracks(tracks, { search, sort: 'recent' })
}

export function selectFavoriteTracks(tracks: AudioAsset[], query: TrackQuery = {}): AudioAsset[] {
  return selectLibraryTracks(tracks.filter((track) => Boolean(track.favorite)), { ...query, sort: query.sort || 'recent' })
}

export function selectPlaylistTracks(tracks: AudioAsset[], playlist: Playlist | null, search = ''): AudioAsset[] {
  if (!playlist) return []
  const byId = new Map(tracks.map((track) => [track.id, track]))
  const query = search.trim().toLocaleLowerCase()
  return playlist.trackIds
    .map((id) => byId.get(id))
    .filter((track): track is AudioAsset => Boolean(track))
    .filter((track) => !query || [track.title, track.artist, track.album, track.fileName].join(' ').toLocaleLowerCase().includes(query))
}

export function totalDuration(tracks: AudioAsset[]): number {
  return tracks.reduce((total, track) => total + Math.max(0, track.duration || 0), 0)
}
