export type OutputFormat = 'mp3' | 'wav' | 'm4a'
export type Quality = 'economy' | 'standard' | 'high' | 'lossless'
export type PlaybackMode = 'sequential' | 'repeat-all' | 'repeat-one' | 'shuffle'

export interface AudioAsset {
  id: string
  name: string
  fileName: string
  kind: 'source' | 'clip' | 'recording'
  duration: number
  size: number
  format: string
  url: string
  /** Absolute path for files selected by the native Tauri file picker/drop. */
  path?: string
  blob?: Blob
  sourceId?: string
  start?: number
  end?: number
  title: string
  artist: string
  album: string
  createdAt: number
  favorite?: boolean
  coverPath?: string
  coverDataUrl?: string
  unavailable?: boolean
}

export interface Playlist {
  id: string
  name: string
  trackIds: string[]
  createdAt: number
  updatedAt: number
}

export interface PlaybackSettings {
  mode: PlaybackMode
  volume: number
  muted: boolean
  lastTrackId: string | null
  lastPosition: number
  /** Human-readable origin of the persisted queue, for example a playlist name. */
  queueSource?: string | null
}

export interface LibrarySnapshot {
  schemaVersion: number
  tracks: AudioAsset[]
  playlists: Playlist[]
  queue: string[]
  settings: PlaybackSettings
}

export interface ClipRequest {
  start: number
  end: number
  format: OutputFormat
  quality: Quality
  /** Linear gain applied to the exported clip. 1 keeps the source level unchanged. */
  volume?: number
}
