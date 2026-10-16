import type { AudioAsset, Playlist } from '../types'
import { invokeNative, isTauriRuntime, nativeAssetUrl } from './tauri'

export interface TrackRecord {
  id: string; path: string; file_name: string; title: string; artist: string; album: string; kind: string; duration: number; size: number; format: string
  cover_path?: string | null; source_id?: string | null; source_start?: number | null; source_end?: number | null; created_at: number; updated_at: number; is_favorite: boolean
}
export interface PlaylistRecord { id: string; name: string; created_at: number; updated_at: number }
export interface PlaylistTrackRecord { playlist_id: string; track_id: string; position: number; track: TrackRecord }

export function trackToRecord(track: AudioAsset): TrackRecord {
  return { id: track.id, path: track.path || track.fileName, file_name: track.fileName, title: track.title, artist: track.artist, album: track.album, kind: track.kind, duration: track.duration, size: track.size, format: track.format, cover_path: track.coverPath || track.coverDataUrl || null, source_id: track.sourceId || null, source_start: track.start ?? null, source_end: track.end ?? null, created_at: track.createdAt, updated_at: Date.now(), is_favorite: Boolean(track.favorite) }
}
export function recordToTrack(record: TrackRecord): AudioAsset {
  return { id: record.id, name: record.title, fileName: record.file_name, kind: record.kind === 'clip' || record.kind === 'recording' ? record.kind : 'source', duration: record.duration, size: record.size, format: record.format, url: isTauriRuntime() && record.path ? nativeAssetUrl(record.path) : '', path: record.path, title: record.title, artist: record.artist, album: record.album, createdAt: record.created_at, favorite: record.is_favorite, coverPath: record.cover_path?.startsWith('data:') ? undefined : (record.cover_path || undefined), coverDataUrl: record.cover_path?.startsWith('data:') ? record.cover_path : undefined, sourceId: record.source_id || undefined, start: record.source_start ?? undefined, end: record.source_end ?? undefined }
}
export const dbListTracks = () => invokeNative<TrackRecord[]>('db_list_tracks')
export const dbUpsertTrack = (track: AudioAsset) => invokeNative<TrackRecord>('db_upsert_track', { track: trackToRecord(track) })
export const dbDeleteTrack = (id: string) => invokeNative<void>('db_delete_track', { id })
export const dbSetFavorite = (id: string, favorite: boolean) => invokeNative<void>('db_set_track_favorite', { id, favorite })
export const dbListPlaylists = () => invokeNative<PlaylistRecord[]>('db_list_playlists')
export const dbCreatePlaylist = (playlist: Playlist) => invokeNative<PlaylistRecord>('db_create_playlist', { playlist: { id: playlist.id, name: playlist.name, created_at: playlist.createdAt, updated_at: playlist.updatedAt } })
export const dbRenamePlaylist = (id: string, name: string) => invokeNative<void>('db_rename_playlist', { id, name })
export const dbDeletePlaylist = (id: string) => invokeNative<void>('db_delete_playlist', { id })
export const dbListPlaylistTracks = (id: string) => invokeNative<PlaylistTrackRecord[]>('db_list_playlist_tracks', { playlistId: id })
export const dbAddPlaylistTrack = (playlistId: string, trackId: string, position?: number) => invokeNative<void>('db_add_playlist_track', { playlistId, trackId, position })
export const dbRemovePlaylistTrack = (playlistId: string, trackId: string) => invokeNative<void>('db_remove_playlist_track', { playlistId, trackId })
export const dbReorderPlaylistTracks = (playlistId: string, trackIds: string[]) => invokeNative<void>('db_reorder_playlist_tracks', { playlistId, trackIds })
export const dbGetQueue = () => invokeNative<{ position: number; track_id: string; added_at: number }[]>('db_get_queue')
export const dbSetQueue = (trackIds: string[]) => invokeNative<void>('db_set_queue', { trackIds })
export const dbGetAppState = (key: string) => invokeNative<string | null>('db_get_app_state', { key })
export const dbSetAppState = (key: string, value: string) => invokeNative<void>('db_set_app_state', { key, value })
export const dbImportLegacyLibrary = (tracks: AudioAsset[]) => invokeNative<number>('db_import_legacy_library', { assets: tracks.map((track) => ({ id: track.id, path: track.path || null, file_name: track.fileName, title: track.title, artist: track.artist, album: track.album, kind: track.kind, duration: track.duration, size: track.size, format: track.format, source_id: track.sourceId || null, source_start: track.start ?? null, source_end: track.end ?? null, created_at: track.createdAt, cover_path: track.coverPath || null, is_favorite: Boolean(track.favorite) })) })
