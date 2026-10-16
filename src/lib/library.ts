import type { AudioAsset, LibrarySnapshot, PlaybackSettings, Playlist, PlaybackMode } from '../types'

export const LIBRARY_SCHEMA_VERSION = 2

export const defaultPlaybackSettings = (): PlaybackSettings => ({
  mode: 'sequential', volume: 0.85, muted: false, lastTrackId: null, lastPosition: 0, queueSource: null,
})

export const emptySnapshot = (): LibrarySnapshot => ({
  schemaVersion: LIBRARY_SCHEMA_VERSION, tracks: [], playlists: [], queue: [], settings: defaultPlaybackSettings(),
})

function asNumber(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

function normalizeTrack(raw: Partial<AudioAsset>): AudioAsset | null {
  if (!raw.id || !raw.fileName) return null
  const title = raw.title || raw.name || raw.fileName.replace(/\.[^.]+$/, '')
  return {
    id: raw.id,
    name: raw.name || title,
    fileName: raw.fileName,
    kind: raw.kind === 'clip' || raw.kind === 'recording' ? raw.kind : 'source',
    duration: Math.max(0, asNumber(raw.duration, 0)),
    size: Math.max(0, asNumber(raw.size, 0)),
    format: raw.format || '',
    url: raw.url || '',
    path: raw.path,
    sourceId: raw.sourceId,
    start: raw.start,
    end: raw.end,
    title,
    artist: raw.artist || '未知艺术家',
    album: raw.album || '未分类',
    createdAt: asNumber(raw.createdAt, Date.now()),
    favorite: Boolean(raw.favorite),
    coverPath: raw.coverPath,
    coverDataUrl: raw.coverDataUrl,
    unavailable: Boolean(raw.unavailable),
  }
}

function normalizeMode(value: unknown): PlaybackMode {
  return value === 'repeat-all' || value === 'repeat-one' || value === 'shuffle' ? value : 'sequential'
}

export function migrateSnapshot(raw: unknown): LibrarySnapshot {
  const base = emptySnapshot()
  if (Array.isArray(raw)) {
    base.tracks = raw.map((item) => normalizeTrack(item as Partial<AudioAsset>)).filter((item): item is AudioAsset => Boolean(item))
    return dedupeSnapshot(base)
  }
  if (!raw || typeof raw !== 'object') return base
  const value = raw as Partial<LibrarySnapshot> & { library?: unknown; items?: unknown }
  const legacyTracks = Array.isArray(value.tracks) ? value.tracks : Array.isArray(value.library) ? value.library : Array.isArray(value.items) ? value.items : []
  const tracks = legacyTracks.map((item) => normalizeTrack(item as Partial<AudioAsset>)).filter((item): item is AudioAsset => Boolean(item))
  const playlists = Array.isArray(value.playlists) ? value.playlists.map((item) => {
    const playlist = item as Partial<Playlist>
    if (!playlist.id || !playlist.name) return null
    return { id: playlist.id, name: playlist.name, trackIds: Array.isArray(playlist.trackIds) ? playlist.trackIds.filter((id): id is string => typeof id === 'string') : [], createdAt: asNumber(playlist.createdAt, Date.now()), updatedAt: asNumber(playlist.updatedAt, Date.now()) }
  }).filter((item): item is Playlist => Boolean(item)) : []
  const rawSettings = value.settings && typeof value.settings === 'object' ? value.settings as Partial<PlaybackSettings> : {}
  const settings: PlaybackSettings = {
    mode: normalizeMode(rawSettings.mode), volume: Math.min(1, Math.max(0, asNumber(rawSettings.volume, 0.85))), muted: Boolean(rawSettings.muted),
    lastTrackId: typeof rawSettings.lastTrackId === 'string' ? rawSettings.lastTrackId : null, lastPosition: Math.max(0, asNumber(rawSettings.lastPosition, 0)), queueSource: typeof rawSettings.queueSource === 'string' ? rawSettings.queueSource : null,
  }
  return dedupeSnapshot({ schemaVersion: LIBRARY_SCHEMA_VERSION, tracks, playlists, queue: Array.isArray(value.queue) ? value.queue.filter((id): id is string => typeof id === 'string') : [], settings })
}

export function trackIdentity(track: Pick<AudioAsset, 'path' | 'fileName' | 'size' | 'duration'>): string {
  if (track.path) return `path:${track.path.replace(/\\/g, '/').toLowerCase()}`
  return `meta:${track.fileName.toLowerCase()}:${track.size}:${Math.round(track.duration * 1000)}`
}

export function dedupeTracks(tracks: AudioAsset[]): AudioAsset[] {
  const seen = new Set<string>()
  return tracks.filter((track) => {
    const key = trackIdentity(track)
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

export function dedupeSnapshot(snapshot: LibrarySnapshot): LibrarySnapshot {
  const tracks = dedupeTracks(snapshot.tracks)
  const validIds = new Set(tracks.map((track) => track.id))
  const playlists = snapshot.playlists.map((playlist) => ({ ...playlist, trackIds: playlist.trackIds.filter((id) => validIds.has(id)) }))
  return { ...snapshot, schemaVersion: LIBRARY_SCHEMA_VERSION, tracks, playlists, queue: snapshot.queue.filter((id) => validIds.has(id)), settings: snapshot.settings.lastTrackId && validIds.has(snapshot.settings.lastTrackId) ? snapshot.settings : { ...snapshot.settings, lastTrackId: null, lastPosition: 0 } }
}

export function addTrackToPlaylist(playlist: Playlist, trackId: string): Playlist {
  if (playlist.trackIds.includes(trackId)) return playlist
  return { ...playlist, trackIds: [...playlist.trackIds, trackId], updatedAt: Date.now() }
}

export function removeTrackFromPlaylist(playlist: Playlist, trackId: string): Playlist {
  return { ...playlist, trackIds: playlist.trackIds.filter((id) => id !== trackId), updatedAt: Date.now() }
}

export function reorderPlaylist(playlist: Playlist, fromIndex: number, toIndex: number): Playlist {
  const ids = [...playlist.trackIds]
  if (fromIndex < 0 || fromIndex >= ids.length || toIndex < 0 || toIndex >= ids.length || fromIndex === toIndex) return playlist
  const [moved] = ids.splice(fromIndex, 1)
  ids.splice(toIndex, 0, moved)
  return { ...playlist, trackIds: ids, updatedAt: Date.now() }
}
