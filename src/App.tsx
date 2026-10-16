import { ChangeEvent, DragEvent, useEffect, useMemo, useRef, useState } from 'react'
import { listen } from '@tauri-apps/api/event'
import {
  AudioLines, ChevronDown, Clock3, Download, FileAudio, FolderOpen, GripVertical,
  Headphones, Library, ListFilter, LoaderCircle, Pause, Pencil, Play, Plus, Radio,
  RotateCcw, Save, Search, SlidersHorizontal, Sparkles, Trash2, Upload, X,
} from 'lucide-react'
import type { AudioAsset, LibrarySnapshot, OutputFormat, PlaybackMode, Playlist, Quality } from './types'
import { isListPage, pageTitles, type AppPage } from './pages/routes'
import { createClip, createWaveformSamples, downloadBlob, extensionOf, isSupportedFile, MAX_FILE_BYTES } from './lib/media'
import { cancelNativeClip, clipNativeMedia, deleteNativeMedia, isTauriRuntime, nativeAssetUrl, nativeMusicDirectory, pickNativeDirectory, pickNativeMediaPaths, probeNativeMedia, processNativeRecording, repairNativeRecording, setNativeSaveDirectory, waveformNativeMedia } from './lib/tauri'
import { clamp, formatTime, validateRange } from './lib/time'
import { loadSnapshot, saveSnapshot } from './lib/storage'
import { addTrackToPlaylist, dedupeTracks, removeTrackFromPlaylist, reorderPlaylist } from './lib/library'
import { PlaybackStateMachine, type PlaybackState, type QueueSource } from './lib/playback'
import { dbAddPlaylistTrack, dbCreatePlaylist, dbDeletePlaylist, dbDeleteTrack, dbGetAppState, dbGetQueue, dbImportLegacyLibrary, dbListPlaylistTracks, dbListPlaylists, dbListTracks, dbRemovePlaylistTrack, dbRenamePlaylist, dbReorderPlaylistTracks, dbSetAppState, dbSetFavorite, dbSetQueue, dbUpsertTrack, recordToTrack } from './lib/db'
import AddToPlaylistModal from './components/AddToPlaylistModal'
import { audioTracksOf, createRecorderCollector, probeAudioUrl, probeRecordedBlob, selectRecorderMimeType, SYSTEM_AUDIO_ERROR, type RecorderCollector } from './lib/recording'

const formatOptions: { value: OutputFormat; label: string; hint: string }[] = [
  { value: 'mp3', label: 'MP3', hint: '兼容性好' },
  { value: 'wav', label: 'WAV', hint: '无损' },
  { value: 'm4a', label: 'M4A', hint: '高压缩' },
]
const qualityOptions: { value: Quality; label: string }[] = [
  { value: 'economy', label: '省空间' },
  { value: 'standard', label: '标准 192 kbps' },
  { value: 'high', label: '高品质 256 kbps' },
  { value: 'lossless', label: '无损 / WAV' },
]

function uid() { return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}` }

function readableError(error: unknown, fallback: string): string {
  if (error instanceof Error && error.message.trim()) return error.message
  if (typeof error === 'string' && error.trim()) return error
  if (typeof error === 'object' && error !== null) {
    const value = error as Record<string, unknown>
    if (typeof value.message === 'string' && value.message.trim()) return value.message
    if (typeof value.error === 'string' && value.error.trim()) return value.error
    try {
      const serialized = JSON.stringify(error)
      if (serialized && serialized !== '{}') return serialized
    } catch { /* fall through to the stable user-facing fallback */ }
  }
  return fallback
}

type AppPreferences = {
  saveDirectory: string
  outputFormat: OutputFormat
  quality: Quality
  theme: 'dark' | 'system'
}

const defaultPreferences: AppPreferences = { saveDirectory: 'RinkoSound 音乐库目录', outputFormat: 'mp3', quality: 'standard', theme: 'dark' }

function loadPreferences(): AppPreferences {
  try {
    const raw = window.localStorage.getItem('soundforge-preferences-v1')
    if (!raw) return defaultPreferences
    const value = JSON.parse(raw) as Partial<AppPreferences>
    return {
      saveDirectory: typeof value.saveDirectory === 'string' ? value.saveDirectory : defaultPreferences.saveDirectory,
      outputFormat: value.outputFormat === 'wav' || value.outputFormat === 'm4a' ? value.outputFormat : 'mp3',
      quality: value.quality === 'economy' || value.quality === 'high' || value.quality === 'lossless' ? value.quality : 'standard',
      theme: value.theme === 'system' ? 'system' : 'dark',
    }
  } catch { return defaultPreferences }
}

function loadLibrarySnapshot(): LibrarySnapshot {
  const snapshot = loadSnapshot()
  return { ...snapshot, tracks: snapshot.tracks.map((asset) => asset.path && isTauriRuntime() ? { ...asset, url: nativeAssetUrl(asset.path) } : asset) }
}

export default function App() {
  const [initialSnapshot] = useState(loadLibrarySnapshot)
  const [library, setLibrary] = useState<AudioAsset[]>(initialSnapshot.tracks)
  const [playlists, setPlaylists] = useState<Playlist[]>(initialSnapshot.playlists)
  const [queue, setQueue] = useState<string[]>(initialSnapshot.queue)
  const [playbackMode, setPlaybackMode] = useState<PlaybackMode>(initialSnapshot.settings.mode)
  const [volume, setVolume] = useState(initialSnapshot.settings.volume)
  const [muted, setMuted] = useState(initialSnapshot.settings.muted)
  const [history, setHistory] = useState<string[]>([])
  const [activePage, setActivePage] = useState<AppPage>('library')
  const [activePlaylistId, setActivePlaylistId] = useState<string | null>(null)
  const [preferences, setPreferences] = useState<AppPreferences>(loadPreferences)
  const [showQueue, setShowQueue] = useState(false)
  // The playlist is a durable collection; this is the origin of the current
  // ephemeral playback queue. Keeping it separate makes it clear when queue
  // edits are temporary and prevents playback from mutating playlist order.
  const [queueSource, setQueueSource] = useState<string | null>(initialSnapshot.settings.queueSource ?? null)
  const [selectedTrackIds, setSelectedTrackIds] = useState<string[]>([])
  const [queueDragIndex, setQueueDragIndex] = useState<number | null>(null)
  const [playlistDragIndex, setPlaylistDragIndex] = useState<number | null>(null)
  const [playlistPickerOpen, setPlaylistPickerOpen] = useState(false)
  const [clipLibraryPickerOpen, setClipLibraryPickerOpen] = useState(false)
  const [clipLibrarySearch, setClipLibrarySearch] = useState('')
  const coverInputRef = useRef<HTMLInputElement>(null)
  const currentIdRef = useRef<string | null>(initialSnapshot.settings.lastTrackId)
  const selectedIdRef = useRef<string | null>(null)
  const nativeHydratedRef = useRef(!isTauriRuntime())
  const playerRef = useRef<PlaybackStateMachine<AudioAsset> | null>(null)
  const [playerState, setPlayerState] = useState<PlaybackState<AudioAsset> | null>(null)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [activeFilter, setActiveFilter] = useState<'all' | 'source' | 'clip'>('all')
  const [search, setSearch] = useState('')
  const [sort, setSort] = useState<'recent' | 'title' | 'duration'>('recent')
  const [start, setStart] = useState(0)
  const [end, setEnd] = useState(0)
  const [playhead, setPlayhead] = useState(0)
  const [format, setFormat] = useState<OutputFormat>(preferences.outputFormat)
  const [quality, setQuality] = useState<Quality>(preferences.quality)
  // Clip output gain is independent from the shared player volume. Unity is
  // the default so existing exports keep their original loudness.
  const [clipVolume, setClipVolume] = useState(1)
  const [isPlaying, setIsPlaying] = useState(false)
  // Clip preview uses the shared audio element but has its own state so the
  // preview button can pause/resume without changing the playback queue.
  const [isPreviewPlaying, setIsPreviewPlaying] = useState(false)
  const [waveformSamples, setWaveformSamples] = useState<number[]>([])
  const [isDragging, setIsDragging] = useState(false)
  const [isProcessing, setIsProcessing] = useState(false)
  const [progress, setProgress] = useState(0)
  const [clipResultId, setClipResultId] = useState<string | null>(null)
  const [recording, setRecording] = useState(false)
  const [notice, setNotice] = useState<{ type: 'error' | 'success' | 'info'; text: string } | null>(null)
  const [metadataDraft, setMetadataDraft] = useState({ title: '', artist: '', album: '' })
  const audioRef = useRef<HTMLAudioElement>(null)
  // The WebView can reject play() when a newly assigned local asset has not
  // reached HAVE_METADATA/HAVE_FUTURE_DATA yet.  Keep a monotonically
  // increasing token so a late canplay event from the previous track can
  // never start the wrong file.
  const audioSyncTokenRef = useRef(0)
  // Reject a late `ended` event while a user initiated delete/clear is tearing
  // down the shared audio element.  This ref is synchronous by design.
  const manualStopRef = useRef(false)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const abortRef = useRef<AbortController | null>(null)
  const recorderRef = useRef<MediaRecorder | null>(null)
  const recordingStreamRef = useRef<MediaStream | null>(null)
  const recordingCollectorRef = useRef<RecorderCollector | null>(null)
  const recordingFinalizingRef = useRef(false)
  const urlsRef = useRef(new Set<string>())
  const previewEndRef = useRef<number | null>(null)

  useEffect(() => {
    selectedIdRef.current = selectedId
  }, [selectedId])

  if (!playerRef.current) {
    playerRef.current = PlaybackStateMachine.fromPersisted({ queueIds: initialSnapshot.queue, currentTrackId: initialSnapshot.settings.lastTrackId, position: initialSnapshot.settings.lastPosition, mode: initialSnapshot.settings.mode, volume: initialSnapshot.settings.volume, muted: initialSnapshot.settings.muted, queueSource: initialSnapshot.settings.queueSource ? { type: 'manual', name: initialSnapshot.settings.queueSource.replace(/^来自：/, '') } : null }, initialSnapshot.tracks)
  }

  const active = library.find((item) => item.id === selectedId) ?? null
  const duration = active?.duration ?? 0
  const activePlaylist = playlists.find((playlist) => playlist.id === activePlaylistId) ?? null
  const filteredLibrary = useMemo(() => {
    const query = search.trim().toLowerCase()
    const playlistIds = activePlaylist?.trackIds
    return library
      .filter((item) => activePage !== 'favorites' || item.favorite)
      .filter((item) => activePage !== 'recent' || Date.now() - item.createdAt < 1000 * 60 * 60 * 24 * 30)
      .filter((item) => activePage !== 'playlists' || Boolean(playlistIds?.includes(item.id)))
      .filter((item) => activeFilter === 'all' || item.kind === activeFilter)
      .filter((item) => !query || [item.title, item.artist, item.album, item.fileName].join(' ').toLowerCase().includes(query))
      .sort((a, b) => activePage === 'playlists' && playlistIds ? playlistIds.indexOf(a.id) - playlistIds.indexOf(b.id) : sort === 'title' ? a.title.localeCompare(b.title) : sort === 'duration' ? b.duration - a.duration : b.createdAt - a.createdAt)
  }, [activeFilter, activePage, activePlaylist, library, search, sort])

  // Each navigation destination owns its query.  The old MVP rendered the same
  // editor and library panel for every destination; keeping this derived list
  // separate makes the page contract explicit and keeps the editor out of list
  // pages.
  const pageTracks = useMemo(() => {
    const query = search.trim().toLowerCase()
    let tracks = library
    if (activePage === 'recent') tracks = [...tracks].sort((a, b) => b.createdAt - a.createdAt)
    if (activePage === 'favorites') tracks = tracks.filter((track) => Boolean(track.favorite))
    if (activePage === 'playlists' && activePlaylist) {
      tracks = activePlaylist.trackIds
        .map((id) => library.find((track) => track.id === id))
        .filter((track): track is AudioAsset => Boolean(track))
    }
    if (activePage === 'clip') tracks = tracks.filter((track) => track.kind === 'clip')
    if (query && activePage !== 'clip') tracks = tracks.filter((track) => [track.title, track.artist, track.album, track.fileName].join(' ').toLowerCase().includes(query))
    if (activePage !== 'recent' && activePage !== 'playlists') {
      tracks = [...tracks].sort((a, b) => sort === 'title' ? a.title.localeCompare(b.title) : sort === 'duration' ? b.duration - a.duration : b.createdAt - a.createdAt)
    }
    return tracks
  }, [activePage, activePlaylist, library, search, sort])

  const clipLibraryTracks = useMemo(() => {
    const query = clipLibrarySearch.trim().toLowerCase()
    return [...library]
      .filter((track) => !query || [track.title, track.artist, track.album, track.fileName].join(' ').toLowerCase().includes(query))
      .sort((a, b) => b.createdAt - a.createdAt)
  }, [clipLibrarySearch, library])

  useEffect(() => {
    const timer = window.setTimeout(() => {
      try {
        saveSnapshot({ schemaVersion: 2, tracks: library, playlists, queue, settings: { mode: playbackMode, volume, muted, lastTrackId: currentIdRef.current, lastPosition: playhead, queueSource } })
      } catch (error) {
        setNotice({ type: 'error', text: error instanceof Error ? error.message : '无法保存音乐库索引，请检查磁盘空间。' })
      }
    }, 350)
    return () => window.clearTimeout(timer)
  }, [library, playlists, queue, playbackMode, volume, muted, playhead, queueSource])

  useEffect(() => {
    try { window.localStorage.setItem('soundforge-preferences-v1', JSON.stringify(preferences)) } catch { /* storage may be unavailable in private browser mode */ }
    if (isTauriRuntime() && nativeHydratedRef.current) {
      void dbSetAppState('preferences', JSON.stringify(preferences)).catch(() => undefined)
    }
  }, [preferences])

  useEffect(() => {
    if (!isTauriRuntime() || !nativeHydratedRef.current) return
    const timer = window.setTimeout(() => {
      void dbSetQueue(queue).catch(() => undefined)
      void dbSetAppState('playback', JSON.stringify({ currentTrackId: currentIdRef.current, position: playhead, mode: playbackMode, volume, muted, queueSource: playerRef.current?.getState().queueSource ?? null })).catch(() => undefined)
    }, 500)
    return () => window.clearTimeout(timer)
  }, [queue, playbackMode, volume, muted, playhead, queueSource])

  useEffect(() => {
    const onOffline = () => setNotice({ type: 'error', text: '网络连接中断；本地导入和剪辑仍可继续，在线资源暂不可用。' })
    window.addEventListener('offline', onOffline)
    return () => window.removeEventListener('offline', onOffline)
  }, [])

  useEffect(() => {
    const player = playerRef.current!
    const unsubscribe = player.subscribe((snapshot) => {
      setPlayerState(snapshot)
      setIsPlaying(snapshot.isPlaying)
      // Any explicit transition back into playback (including the global
      // dock/keyboard toggle) clears a previous manual-stop guard.
      if (snapshot.isPlaying) manualStopRef.current = false
      currentIdRef.current = snapshot.currentTrackId
      setPlaybackMode(snapshot.mode)
      setVolume(snapshot.volume)
      setMuted(snapshot.muted)
      setQueue(snapshot.queue.map((track) => track.id))
    })
    return unsubscribe
  }, []) // playerRef is initialized before the first render

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null
      if (target && ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName)) return
      if (event.code === 'Space') { event.preventDefault(); playerRef.current?.toggle() }
      else if (event.key === 'ArrowRight') { event.preventDefault(); const state = playerRef.current?.getState(); if (state) playerRef.current?.seek(state.position + 5) }
      else if (event.key === 'ArrowLeft') { event.preventDefault(); const state = playerRef.current?.getState(); if (state) playerRef.current?.seek(state.position - 5) }
      else if (event.key.toLowerCase() === 'n') { playerRef.current?.next() }
      else if (event.key.toLowerCase() === 'p') { playerRef.current?.previous() }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [])

  useEffect(() => {
    if (playerRef.current && library.length) {
      const currentQueue = playerRef.current.getState().queue.map((track) => track.id)
      // An empty queue is a valid persisted state.  Do not silently turn it
      // into the whole library while replacing hydrated track objects; a
      // cleared queue must stay empty across reloads and native DB hydration.
      const nextQueue = currentQueue.map((id) => library.find((track) => track.id === id)).filter((track): track is AudioAsset => Boolean(track))
      playerRef.current.setQueue(nextQueue)
    }
  }, [library])

  useEffect(() => {
    if (!isTauriRuntime()) return
    void nativeMusicDirectory().then((directory) => setPreferences((current) => current.saveDirectory === defaultPreferences.saveDirectory ? { ...current, saveDirectory: directory } : current)).catch(() => undefined)
    void (async () => {
      try {
        let records = await dbListTracks()
        if (!records.length && initialSnapshot.tracks.length) {
          await dbImportLegacyLibrary(initialSnapshot.tracks)
          records = await dbListTracks()
        }
        if (records.length) setLibrary(records.map(recordToTrack))
        const [queueRows, savedPlayback, savedPreferences] = await Promise.all([dbGetQueue(), dbGetAppState('playback'), dbGetAppState('preferences')])
        if (queueRows.length) {
          const tracks = records.map(recordToTrack)
          const queued = queueRows.sort((a, b) => a.position - b.position).map((row) => tracks.find((track) => track.id === row.track_id)).filter((track): track is AudioAsset => Boolean(track))
          if (queued.length) playerRef.current?.setQueue(queued, { preserveCurrent: false })
          if (queued.length < queueRows.length) setNotice({ type: 'info', text: `已从播放队列清理 ${queueRows.length - queued.length} 个不可用文件。` })
        }
        if (savedPlayback) {
          try {
            const saved = JSON.parse(savedPlayback) as Partial<{ currentTrackId: string; position: number; mode: PlaybackMode; volume: number; muted: boolean; queueSource: QueueSource | string | null }>
            if (saved.mode) playerRef.current?.setMode(saved.mode)
            if (typeof saved.volume === 'number') playerRef.current?.setVolume(saved.volume)
            if (typeof saved.muted === 'boolean' && saved.muted !== playerRef.current?.getState().muted) playerRef.current?.toggleMute()
            if (saved.currentTrackId) { playerRef.current?.play(saved.currentTrackId); playerRef.current?.pause() }
            if (typeof saved.position === 'number') playerRef.current?.seek(saved.position)
            if (saved.queueSource && typeof saved.queueSource === 'object' && typeof saved.queueSource.name === 'string') setQueueSource(`来自：${saved.queueSource.name}`)
            else if (typeof saved.queueSource === 'string') setQueueSource(saved.queueSource)
            else if (saved.queueSource === null) setQueueSource(null)
          } catch { /* ignore a corrupted player snapshot */ }
        }
        if (savedPreferences) {
          try {
            const saved = JSON.parse(savedPreferences) as Partial<AppPreferences>
            const next: AppPreferences = {
              saveDirectory: typeof saved.saveDirectory === 'string' ? saved.saveDirectory : defaultPreferences.saveDirectory,
              outputFormat: saved.outputFormat === 'wav' || saved.outputFormat === 'm4a' ? saved.outputFormat : 'mp3',
              quality: saved.quality === 'economy' || saved.quality === 'high' || saved.quality === 'lossless' ? saved.quality : 'standard',
              theme: saved.theme === 'system' ? 'system' : 'dark',
            }
            setPreferences(next); setFormat(next.outputFormat); setQuality(next.quality)
            if (next.saveDirectory !== defaultPreferences.saveDirectory) void setNativeSaveDirectory(next.saveDirectory).catch(() => undefined)
          } catch { /* ignore a corrupted preference snapshot */ }
        }
        const playlistRecords = await dbListPlaylists()
        const hydrated = await Promise.all(playlistRecords.map(async (record) => {
          const trackRows = await dbListPlaylistTracks(record.id)
          return { id: record.id, name: record.name, trackIds: trackRows.sort((a, b) => a.position - b.position).map((row) => row.track_id), createdAt: record.created_at, updatedAt: record.updated_at }
        }))
        setPlaylists(hydrated)
      } catch (error) {
        setNotice({ type: 'error', text: error instanceof Error ? error.message : '无法读取本地音乐库数据库。' })
      } finally {
        nativeHydratedRef.current = true
      }
    })()
  }, [])

  useEffect(() => {
    if (!isTauriRuntime()) return
    let unlisten: (() => void) | undefined
    void listen<{ paths?: string[] }>('tauri://drag-drop', (event) => {
      const paths = Array.isArray(event.payload?.paths) ? event.payload.paths : []
      if (paths.length) void addNativePaths(paths)
    }).then((cleanup) => { unlisten = cleanup })
    return () => { unlisten?.() }
  }, []) // addNativePaths is stable for the lifetime of this component

  useEffect(() => {
    return () => {
      urlsRef.current.forEach((url) => URL.revokeObjectURL(url))
      recorderRef.current?.stream.getTracks().forEach((track) => track.stop())
    }
  }, [])

  useEffect(() => {
    if (!active) return
    setMetadataDraft({ title: active.title, artist: active.artist, album: active.album })
    const currentTrackId = playerRef.current?.getState().currentTrackId
    if (activePage !== 'clip' && currentTrackId !== selectedId) return
    const nextEnd = active.kind === 'clip' ? active.duration : active.duration || 0
    setStart(0)
    setEnd(nextEnd)
    setPlayhead(0)
    setIsPlaying(false)
    setIsPreviewPlaying(false)
    previewEndRef.current = null
    if (audioRef.current) {
      audioRef.current.pause()
      audioRef.current.currentTime = 0
      audioRef.current.src = active.url || ''
      if (active.url) void audioRef.current.load()
    }
  }, [selectedId, activePage]) // eslint-disable-line react-hooks/exhaustive-deps

  // Build the clip editor waveform from decoded PCM instead of a decorative
  // repeating pattern. Native Tauri files use the FFmpeg-backed command first;
  // browser imports use the original Blob through Web Audio. Unsupported
  // codecs keep the existing static fallback bars.
  useEffect(() => {
    if (activePage !== 'clip' || !active) {
      setWaveformSamples([])
      return
    }
    const source = active.blob ?? active.url
    if (!source) {
      setWaveformSamples([])
      return
    }
    const controller = new AbortController()
    setWaveformSamples([])
    const loadWaveform = async () => {
      try {
        if (isTauriRuntime() && active.path) {
          try {
            const nativeSamples = await waveformNativeMedia(active.path, 72)
            if (!controller.signal.aborted && nativeSamples.length) {
              setWaveformSamples(nativeSamples)
              return
            }
          } catch {
            // Fall through to Web Audio for test harnesses and unusual codecs.
          }
        }
        const samples = await createWaveformSamples(source, 72, controller.signal)
        if (!controller.signal.aborted) setWaveformSamples(samples)
      } catch {
        if (!controller.signal.aborted) setWaveformSamples([])
      }
    }
    void loadWaveform()
    return () => controller.abort()
  }, [activePage, active?.id, active?.url, active?.blob])

  const selectAsset = (asset: AudioAsset) => {
    selectedIdRef.current = asset.id
    setSelectedId(asset.id)
    setNotice(asset.url ? null : { type: 'info', text: '这是上次会话保存的条目，请重新导入原文件后再编辑。' })
  }

  const selectClipAsset = async (asset: AudioAsset) => {
    const native = isTauriRuntime()
    let resolvedUrl = asset.url
    let resolvedDuration = asset.duration
    if (native) {
      if (!asset.path) {
        setLibrary((items) => items.map((item) => item.id === asset.id ? { ...item, url: '', unavailable: true } : item))
        resolvedUrl = ''
      } else {
        try {
          const metadata = await probeNativeMedia(asset.path)
          resolvedUrl = nativeAssetUrl(metadata.path || asset.path)
          resolvedDuration = metadata.duration
          setLibrary((items) => items.map((item) => item.id === asset.id ? { ...item, path: metadata.path || asset.path, url: resolvedUrl, duration: resolvedDuration, unavailable: false } : item))
        } catch {
          setLibrary((items) => items.map((item) => item.id === asset.id ? { ...item, url: '', unavailable: true } : item))
          resolvedUrl = ''
        }
      }
    } else if (!asset.blob || !asset.url) {
      setLibrary((items) => items.map((item) => item.id === asset.id ? { ...item, url: '', unavailable: true } : item))
      resolvedUrl = ''
    }
    selectedIdRef.current = asset.id
    setSelectedId(asset.id)
    setClipResultId(null)
    setStart(0)
    setEnd(Math.max(0, resolvedDuration))
    setPlayhead(0)
    setClipLibraryPickerOpen(false)
    setIsPlaying(false)
    setIsPreviewPlaying(false)
    previewEndRef.current = null
    if (audioRef.current) {
      audioRef.current.pause()
      audioRef.current.currentTime = 0
      audioRef.current.src = resolvedUrl
      if (resolvedUrl) void audioRef.current.load()
    }
    if (!resolvedUrl) {
      setNotice({ type: 'info', text: native ? '该音乐库条目对应的本地文件已失效或缺少路径，请重新导入原文件后再试。' : '该音乐库条目缺少可用文件地址，请重新导入原文件后再试。' })
    } else {
      setNotice(null)
    }
  }

  const addFiles = async (files: FileList | File[]) => {
    const incoming = Array.from(files)
    if (!incoming.length) return
    const seenPaths = new Set(library.map((item) => item.path?.replace(/\\/g, '/').toLowerCase()).filter((value): value is string => Boolean(value)))
    const seenMetadata = new Set(library.filter((item) => !item.path).map((item) => `${item.fileName.toLowerCase()}:${item.size}`))
    for (const file of incoming) {
      if (file.size > MAX_FILE_BYTES) {
        setNotice({ type: 'error', text: `${file.name} 超过 2 GB 限制，未导入。` })
        continue
      }
      if (!isSupportedFile(file)) {
        setNotice({ type: 'error', text: `${file.name} 格式不受支持，请选择 MP4、MKV、WebM、MOV、MP3、WAV、M4A 等文件。` })
        continue
      }
      const nativePath = (file as File & { path?: string }).path
      const url = URL.createObjectURL(file)
      urlsRef.current.add(url)
      let duration = 0
      if (isTauriRuntime() && nativePath) {
        try {
          duration = (await probeNativeMedia(nativePath)).duration
        } catch (error) {
          URL.revokeObjectURL(url); urlsRef.current.delete(url)
          setNotice({ type: 'error', text: error instanceof Error ? error.message : `${file.name} 无法读取媒体信息。` })
          continue
        }
      } else {
        duration = await new Promise<number>((resolve) => {
          const probe = document.createElement('audio')
          probe.preload = 'metadata'
          probe.onloadedmetadata = () => { resolve(Number.isFinite(probe.duration) ? probe.duration : 0); probe.src = '' }
          probe.onerror = () => resolve(0)
          probe.src = url
        })
      }
      const title = file.name.replace(/\.[^.]+$/, '')
      const asset: AudioAsset = {
        id: uid(), name: title, fileName: file.name, kind: 'source', duration, size: file.size,
        format: extensionOf(file.name).toUpperCase(), url, path: nativePath, blob: file, title, artist: '未知艺术家', album: '未分类', createdAt: Date.now(),
      }
      const normalizedPath = nativePath?.replace(/\\/g, '/').toLowerCase()
      const metadataKey = `${file.name.toLowerCase()}:${file.size}`
      const duplicate = normalizedPath ? seenPaths.has(normalizedPath) : seenMetadata.has(metadataKey)
      if (duplicate) { URL.revokeObjectURL(url); urlsRef.current.delete(url); setNotice({ type: 'info', text: `${file.name} 已在音乐库中。` }); continue }
      if (normalizedPath) seenPaths.add(normalizedPath)
      else seenMetadata.add(metadataKey)
      setLibrary((current) => dedupeTracks([asset, ...current]))
      if (isTauriRuntime()) void dbUpsertTrack(asset).catch((error) => setNotice({ type: 'error', text: error instanceof Error ? error.message : '无法保存音乐库记录。' }))
      // A newly imported source starts a fresh clip-editing session.  Clear
      // the previous saved-clip panel and preview boundary before selecting
      // it so the shared audio element cannot keep targeting the old item.
      setClipResultId(null)
      setIsPreviewPlaying(false)
      previewEndRef.current = null
      setSelectedId(asset.id)
      setNotice({ type: 'success', text: `已导入 ${file.name}` })
    }
  }

  const addNativePaths = async (paths: string[]) => {
    const seenPaths = new Set(library.map((item) => item.path?.replace(/\\/g, '/').toLowerCase()).filter((value): value is string => Boolean(value)))
    for (const path of paths) {
      try {
        const metadata = await probeNativeMedia(path)
        const fileName = metadata.file_name || path.split(/[\\/]/).pop() || 'media'
        const title = fileName.replace(/\.[^.]+$/, '')
        const asset: AudioAsset = {
          id: uid(), name: title, fileName, kind: 'source', duration: metadata.duration, size: metadata.size,
          format: metadata.format, url: nativeAssetUrl(metadata.path || path), path: metadata.path || path,
          title, artist: '未知艺术家', album: '未分类', createdAt: Date.now(),
        }
        const normalizedPath = (metadata.path || path).replace(/\\/g, '/').toLowerCase()
        if (seenPaths.has(normalizedPath)) { setNotice({ type: 'info', text: `${fileName} 已在音乐库中。` }); continue }
        seenPaths.add(normalizedPath)
        setLibrary((current) => dedupeTracks([asset, ...current]))
        if (isTauriRuntime()) void dbUpsertTrack(asset).catch((error) => setNotice({ type: 'error', text: error instanceof Error ? error.message : '无法保存音乐库记录。' }))
        setClipResultId(null)
        setIsPreviewPlaying(false)
        previewEndRef.current = null
        setSelectedId(asset.id)
        setNotice({ type: 'success', text: `已导入 ${fileName}` })
      } catch (error) {
        setNotice({ type: 'error', text: error instanceof Error ? error.message : '无法读取媒体文件。' })
      }
    }
  }

  const handleImportClick = async () => {
    if (!isTauriRuntime()) { fileInputRef.current?.click(); return }
    let captureStream: MediaStream | null = null
    try {
      const paths = await pickNativeMediaPaths()
      if (paths.length) await addNativePaths(paths)
    } catch (error) {
      setNotice({ type: 'error', text: error instanceof Error ? error.message : '无法打开文件选择器。' })
    }
  }

  const onFileChange = (event: ChangeEvent<HTMLInputElement>) => {
    if (event.target.files) void addFiles(event.target.files)
    event.target.value = ''
  }

  const onDrop = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault(); setIsDragging(false)
    void addFiles(event.dataTransfer.files)
  }

  const playbackModeLabel = (mode: PlaybackMode) => mode === 'repeat-all' ? '循环播放全部' : mode === 'repeat-one' ? '单曲循环' : mode === 'shuffle' ? '随机播放' : '顺序播放'
  const setQueueOrigin = (source: QueueSource | null) => {
    const player = playerRef.current
    if (player) {
      const state = player.getState()
      player.setQueue(state.queue, { preserveCurrent: true, queueSource: source })
    }
    setQueueSource(source?.name ? `来自：${source.name}` : null)
  }

  /** Start a track while preserving the current queue. A track clicked from
   * another page may not yet be in that queue, so add it first; calling
   * PlaybackStateMachine.play on an unknown id is intentionally a no-op. */
  const playTrack = (trackId: string, source?: string) => {
    const track = library.find((item) => item.id === trackId)
    if (!track?.url) { setNotice({ type: 'error', text: '该歌曲文件不可用，请重新导入。' }); return }
    const player = playerRef.current
    if (!player) return
    const current = player.getState()
    if (!current.queue.some((item) => item.id === trackId)) player.addToQueue(track)
    // Do not update selectedId here. selectedId controls the details drawer;
    // playback controls are independent actions and must never open it.
    if (source) setQueueOrigin({ type: 'manual', name: source.replace(/^来自：/, '') })
    manualStopRef.current = false
    player.play(trackId)
  }

  /** Append a track without interrupting the current one. If the queue was
   * empty, the newly appended item becomes the first item and starts. */
  const addTrackToQueue = (track: AudioAsset, source = '来自：音乐库') => {
    const player = playerRef.current
    if (!player || !track.url) { setNotice({ type: 'error', text: '该歌曲文件不可用，请重新导入后再播放。' }); return }
    const before = player.getState()
    const alreadyQueued = before.queue.some((item) => item.id === track.id)
    if (!alreadyQueued) player.addToQueue(track)
    setQueueOrigin({ type: 'library', name: source.replace(/^来自：/, '') })
    if (!before.currentTrackId) {
      manualStopRef.current = false
      player.play(track.id)
    }
    setNotice({ type: 'success', text: alreadyQueued ? `“${track.title}”已在播放队列中。` : `已将“${track.title}”加入播放队列。` })
  }

  /** Put a track directly after the current item, without changing the
   * durable playlist order. Existing future occurrences are moved there. */
  const playTrackNext = (track: AudioAsset, source = '来自：音乐库') => {
    const player = playerRef.current
    if (!player || !track.url) { setNotice({ type: 'error', text: '该歌曲文件不可用，请重新导入后再播放。' }); return }
    const before = player.getState()
    if (!before.currentTrackId) {
      player.addToQueue(track)
      setQueueOrigin({ type: 'library', name: source.replace(/^来自：/, '') })
      manualStopRef.current = false
      player.play(track.id)
      return
    }
    if (track.id !== before.currentTrackId && before.queue.some((item) => item.id === track.id)) player.removeFromQueue(track.id)
    const latest = player.getState()
    const currentIndex = latest.queue.findIndex((item) => item.id === latest.currentTrackId)
    player.addToQueue(track, currentIndex < 0 ? 0 : currentIndex + 1)
    setQueueOrigin({ type: 'manual', name: source.replace(/^来自：/, '') })
    setNotice({ type: 'success', text: `“${track.title}”将作为下一首播放。` })
  }

  const stopAudioPlayback = () => {
    manualStopRef.current = true
    const audio = audioRef.current
    audioSyncTokenRef.current += 1
    if (audio) {
      audio.pause()
      try { audio.currentTime = 0 } catch { /* the element may be unloading */ }
      audio.dataset.trackId = ''
      audio.removeAttribute('src')
      audio.load()
    }
    setPlayhead(0)
    setIsPlaying(false)
  }

  const clearPlaybackQueue = () => {
    stopAudioPlayback()
    playerRef.current?.clearQueue()
    setQueueSource(null)
    setNotice({ type: 'info', text: '播放队列已清空。' })
  }

  /** Remove one queue row.  Deleting the current row is an explicit stop;
   * remaining rows stay queued but no replacement is selected automatically. */
  const removeTrackFromPlaybackQueue = (trackId: string) => {
    const player = playerRef.current
    if (!player) return
    if (player.getState().currentTrackId === trackId) stopAudioPlayback()
    player.removeFromQueue(trackId)
  }

  const togglePlay = () => {
    if (!active) return
    if (playerRef.current?.getState().currentTrackId !== active.id) playTrack(active.id)
    else playerRef.current?.toggle()
  }

  const playNext = () => { manualStopRef.current = false; playerRef.current?.next() }
  const playPrevious = () => { manualStopRef.current = false; playerRef.current?.previous() }

  const handleAudioEnded = () => {
    if (previewEndRef.current !== null) {
      previewEndRef.current = null
      setIsPreviewPlaying(false)
      return
    }
    if (manualStopRef.current) return
    const audio = audioRef.current
    const transition = playerRef.current?.ended()
    if (!transition) return
    // `repeat-one` keeps the same track id and `isPlaying=true`, so the
    // state-driven source effect quite correctly has no dependency change.
    // Restart the already-loaded element explicitly in that case.  For a
    // normal next-track transition, changing currentTrackId lets the effect
    // wait for canplay before starting the new source.
    if (transition.isPlaying && audio && transition.currentTrackId === audio.dataset.trackId) {
      audio.currentTime = 0
      void audio.play().catch(() => setNotice({ type: 'error', text: '播放失败：媒体地址不可用或当前文件不包含可播放的音轨。' }))
    }
  }

  useEffect(() => {
    const state = playerState
    const audio = audioRef.current
    if (!state?.currentTrackId || !audio) return
    // The clip editor also uses this shared audio element for preview.  When
    // a new source is selected there, the queue may still point at the last
    // played clip; letting this effect react to every library update would
    // immediately replace the new source with that stale queue item.
    if (activePage === 'clip' && selectedId !== state.currentTrackId) return
    const track = library.find((item) => item.id === state.currentTrackId)
    if (!track?.url) return

    const token = ++audioSyncTokenRef.current
    let cancelled = false
    let readyHandled = false
    const handleReady = () => {
      // `canplay` may arrive after a queue transition.  Ignore stale events
      // instead of starting the previous track over the new one.
      if (cancelled || token !== audioSyncTokenRef.current || readyHandled) return
      readyHandled = true
      try {
        audio.currentTime = Math.max(0, state.position)
      } catch {
        // Some WebViews briefly expose an invalid seek target while metadata
        // is being decoded.  The next canplay/loadedmetadata event retries.
        readyHandled = false
        return
      }
      if (!state.isPlaying) {
        audio.pause()
        return
      }
      void audio.play().catch(() => {
        if (!cancelled && token === audioSyncTokenRef.current) {
          setNotice({ type: 'error', text: '播放失败：媒体地址不可用或当前文件不包含可播放的音轨。' })
        }
      })
    }

    const sourceChanged = audio.dataset.trackId !== track.id || audio.src !== track.url
    if (sourceChanged) {
      audio.pause()
      audio.dataset.trackId = track.id
      audio.src = track.url
      audio.addEventListener('loadedmetadata', handleReady)
      audio.addEventListener('canplay', handleReady)
      audio.load()
    } else {
      // A pause/play toggle on the same source does not emit canplay again.
      handleReady()
    }

    return () => {
      cancelled = true
      audio.removeEventListener('loadedmetadata', handleReady)
      audio.removeEventListener('canplay', handleReady)
    }
  }, [activePage, playerState?.currentTrackId, playerState?.isPlaying, selectedId, library])

  useEffect(() => {
    if (!audioRef.current || !playerState) return
    audioRef.current.volume = playerState.volume
    audioRef.current.muted = playerState.muted
  }, [playerState?.volume, playerState?.muted])

  const pausePreview = () => {
    audioRef.current?.pause()
    previewEndRef.current = null
    setIsPreviewPlaying(false)
  }

  const finishPreview = () => {
    audioRef.current?.pause()
    previewEndRef.current = null
    setIsPreviewPlaying(false)
  }

  const previewClip = async () => {
    if (!audioRef.current || !active?.url) return
    const rangeError = validateRange(start, end, duration)
    if (rangeError) { setNotice({ type: 'error', text: rangeError }); return }
    previewEndRef.current = end
    audioRef.current.currentTime = start
    setPlayhead(start)
    try {
      await audioRef.current.play()
      setIsPreviewPlaying(true)
    } catch {
      previewEndRef.current = null
      setIsPreviewPlaying(false)
      setNotice({ type: 'error', text: '片段试听失败：媒体地址不可用或当前文件不包含可播放的音轨。' })
    }
  }

  const togglePreviewClip = async () => {
    if (isPreviewPlaying) {
      pausePreview()
      return
    }
    const audio = audioRef.current
    if (audio && previewEndRef.current !== null && audio.currentTime >= start && audio.currentTime < end) {
      try {
        await audio.play()
        setIsPreviewPlaying(true)
      } catch {
        setNotice({ type: 'error', text: '片段试听失败：媒体地址不可用或当前文件不包含可播放的音轨。' })
      }
      return
    }
    await previewClip()
  }

  const handleClip = async () => {
    if (!active?.blob && !active?.path) { setNotice({ type: 'error', text: '当前条目没有可用的本地文件，请重新导入。' }); return }
    const rangeError = validateRange(start, end, duration)
    if (rangeError) { setNotice({ type: 'error', text: rangeError }); return }
    const controller = new AbortController()
    abortRef.current = controller
    setIsProcessing(true); setProgress(4); setNotice({ type: 'info', text: '正在解码并渲染音频片段…' })
    const progressTimer = window.setInterval(() => setProgress((value) => Math.min(value + 7, 92)), 180)
    try {
      const native = isTauriRuntime() && Boolean(active.path)
      const nativeResult = native ? await clipNativeMedia(active.path as string, { start, end, format, quality, volume: clipVolume, outputDir: selectedNativeSaveDirectory() }) : null
      const blob = nativeResult ? undefined : await createClip(active.blob as Blob, { start, end, format, quality, volume: clipVolume }, controller.signal)
      const actualFormat = nativeResult?.format.toLowerCase() ?? 'wav'
      const clipUrl = nativeResult ? nativeAssetUrl(nativeResult.path) : URL.createObjectURL(blob as Blob)
      const clipped: AudioAsset = {
        id: uid(), name: `${active.title} · ${formatTime(start)}–${formatTime(end)}`, fileName: nativeResult?.file_name ?? `${active.title}-${Date.now()}.${actualFormat}`,
        kind: 'clip', duration: end - start, size: nativeResult?.size ?? (blob as Blob).size, format: actualFormat.toUpperCase(), url: clipUrl, path: nativeResult?.path, blob,
        sourceId: active.id, start, end, title: active.title, artist: active.artist, album: active.album, createdAt: Date.now(),
      }
      if (!nativeResult) urlsRef.current.add(clipped.url)
      setLibrary((current) => [clipped, ...current])
      if (isTauriRuntime()) void dbUpsertTrack(clipped).catch((error) => setNotice({ type: 'error', text: error instanceof Error ? error.message : '无法保存截取片段记录。' }))
      setSelectedId(clipped.id)
      setClipResultId(clipped.id)
      setProgress(100)
      setNotice({ type: 'success', text: nativeResult ? `片段已保存为 ${nativeResult.format}。` : format === 'wav' ? '片段已保存到音乐库。' : '片段已保存为无损 WAV（浏览器模式）；原生 Tauri 版会按选择输出 MP3/M4A。' })
    } catch (error) {
      if ((error as DOMException)?.name === 'AbortError' || error instanceof Error && /取消/.test(error.message)) setNotice({ type: 'info', text: '已取消截取，临时数据已清理。' })
      else if (error instanceof Error && /空间|quota|disk/i.test(error.message)) setNotice({ type: 'error', text: '磁盘空间不足，无法保存片段。请清理空间后重试。' })
      else setNotice({ type: 'error', text: error instanceof Error ? error.message : '无法解码该媒体。请确认文件完整，或先转换为 WAV/MP3 后重试。' })
    } finally {
      window.clearInterval(progressTimer); abortRef.current = null; setIsProcessing(false)
    }
  }

  const cancelClip = () => {
    abortRef.current?.abort()
    if (isTauriRuntime()) void cancelNativeClip().catch(() => undefined)
    setIsProcessing(false); setProgress(0)
  }

  const startRecording = async () => {
    if (!navigator.mediaDevices?.getDisplayMedia || typeof MediaRecorder === 'undefined') {
      setNotice({ type: 'error', text: '当前环境不支持系统音频录制，请使用支持 MediaRecorder 的 Windows 原生版本。' })
      return
    }
    if (recording || recorderRef.current || recordingFinalizingRef.current) {
      if (recordingFinalizingRef.current) setNotice({ type: 'info', text: '上一段录音仍在处理，请稍候。' })
      return
    }
    let captureStream: MediaStream | null = null
    try {
      // A video track is requested because Windows exposes the system-audio
      // checkbox through the display-share picker. It is never sent to the
      // recorder or persisted in the resulting file.
      const stream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true })
      captureStream = stream
      const allAudioTracks = stream.getAudioTracks()
      console.info('[RinkoSound recording] capture stream', {
        audioTrackCount: allAudioTracks.length,
        tracks: allAudioTracks.map((track) => ({ readyState: track.readyState, enabled: track.enabled, muted: track.muted })),
      })
      const activeAudioTracks = audioTracksOf(stream)
      if (!allAudioTracks.length || !activeAudioTracks.length) {
        stream.getTracks().forEach((track) => track.stop())
        setNotice({ type: 'error', text: SYSTEM_AUDIO_ERROR })
        return
      }
      const mime = selectRecorderMimeType((type) => MediaRecorder.isTypeSupported(type))
      if (!mime) {
        stream.getTracks().forEach((track) => track.stop())
        setNotice({ type: 'error', text: '当前 WebView 不支持可用的音频录制格式，无法创建录音。' })
        return
      }
      console.info('[RinkoSound recording] MediaRecorder', { mimeType: mime })
      // Keep only audio tracks in the encoder stream. The original display
      // stream remains alive until recorder.onstop so the final data chunk is
      // flushed before Windows revokes the capture permission.
      const audioStream = new MediaStream(activeAudioTracks)
      const recorder = new MediaRecorder(audioStream, { mimeType: mime, audioBitsPerSecond: 256000 })
      const collector = createRecorderCollector(recorder)
      recordingCollectorRef.current = collector
      let recorderFailed = false
      recorder.onerror = () => {
        recorderFailed = true
        console.error('[RinkoSound recording] MediaRecorder error')
        setNotice({ type: 'error', text: '系统音频录制失败，MediaRecorder 报告了编码错误。' })
        try { if (recorder.state !== 'inactive') recorder.stop() } catch { /* onstop cleanup remains best effort */ }
      }
      recorder.onstop = () => {
        void (async () => {
          if (recordingFinalizingRef.current) return
          recordingFinalizingRef.current = true
          const chunks = collector.chunks()
          const chunkCount = chunks.length
          const blob = new Blob(chunks, { type: recorder.mimeType || mime })
          const title = `系统录音 ${new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}`
          console.info('[RinkoSound recording] stopped', { mimeType: recorder.mimeType || mime, chunkCount, blobSize: blob.size })
          setNotice({ type: 'info', text: '录音已停止，正在验证音频轨道和真实时长…' })
          // The recorder must finish before tracks are stopped. This is the
          // only cleanup path, so failures cannot leave a live capture stream.
          stream.getTracks().forEach((track) => track.stop())
          collector.dispose()
          recordingCollectorRef.current = null
          recorderRef.current = null
          recordingStreamRef.current = null
          setRecording(false)
          setNotice({ type: 'info', text: '录音已停止，正在验证音频轨道并生成可播放文件…' })
          let generatedNativePath: string | null = null
          try {
            if (recorderFailed) throw new Error('系统音频录制编码失败，MediaRecorder 无法生成有效音频。')
            if (blob.size <= 0) throw new Error('录音数据为空，未生成有效音频。')
            let item: AudioAsset
            if (isTauriRuntime()) {
              const bytes = new Uint8Array(await blob.arrayBuffer())
              let binary = ''
              const block = 0x8000
              for (let offset = 0; offset < bytes.length; offset += block) binary += String.fromCharCode(...bytes.subarray(offset, Math.min(bytes.length, offset + block)))
              const dataBase64 = btoa(binary)
              const native = await processNativeRecording(dataBase64, recorder.mimeType || mime, selectedNativeSaveDirectory())
              generatedNativePath = native.path
              const url = nativeAssetUrl(native.path)
              const playerDuration = await probeAudioUrl(url)
              if (Math.abs(playerDuration - native.duration) > 1) console.warn('[RinkoSound recording] player duration differs from ffprobe', { ffprobe: native.duration, player: playerDuration })
              item = { id: uid(), name: title, fileName: native.file_name, kind: 'recording', duration: native.duration, size: native.size, format: native.format, url, path: native.path, title, artist: '系统录音', album: '录音', createdAt: Date.now() }
              console.info('[RinkoSound recording] ffprobe validated', { path: native.path, duration: native.duration, size: native.size, format: native.format })
              await dbUpsertTrack(item)
            } else {
              const duration = await probeRecordedBlob(blob)
              console.info('[RinkoSound recording] browser audio validated', { duration, blobSize: blob.size, mimeType: recorder.mimeType || mime })
              const url = URL.createObjectURL(blob)
              urlsRef.current.add(url)
              item = { id: uid(), name: title, fileName: `${title}.webm`, kind: 'recording', duration, size: blob.size, format: 'WEBM', url, blob, title, artist: '系统录音', album: '录音', createdAt: Date.now() }
            }
            setLibrary((current) => [item, ...current])
            setSelectedId(item.id)
            setNotice({ type: 'success', text: `录音已验证并加入音乐库（${formatTime(item.duration)}）。` })
          } catch (error) {
            console.error('[RinkoSound recording] validation failed', error)
            if (generatedNativePath) void deleteNativeMedia(generatedNativePath).catch(() => undefined)
            const message = readableError(error, `录音失败，输出文件未加入音乐库（${chunkCount} 个数据块，${blob.size} 字节）。`)
            setNotice({ type: 'error', text: !isTauriRuntime() && /时长|播放器|元数据/.test(message) ? `${message} 浏览器模式无法修复该 WebM，请使用 Windows 原生版本（内置 FFmpeg）重试。` : message })
          }
          recordingFinalizingRef.current = false
        })()
      }
      recorder.start(250)
      recorderRef.current = recorder
      recordingStreamRef.current = stream
      setRecording(true)
      setNotice({ type: 'info', text: '正在录制当前屏幕的系统音频，点击停止结束。' })
      const videoTrack = stream.getVideoTracks()[0]
      videoTrack?.addEventListener('ended', () => { if (recorder.state !== 'inactive') void stopRecording() }, { once: true })
    } catch (error) {
      recordingCollectorRef.current?.dispose()
      recordingCollectorRef.current = null
      captureStream?.getTracks().forEach((track) => track.stop())
      recordingStreamRef.current?.getTracks().forEach((track) => track.stop())
      recorderRef.current = null
      setRecording(false)
      setNotice({ type: 'error', text: error instanceof Error && /abort|cancel/i.test(error.name + error.message) ? '录制被取消。' : '录制被取消，或系统没有授予音频共享权限。' })
    }
  }

  const stopRecording = () => {
    const recorder = recorderRef.current
    if (!recorder || recordingFinalizingRef.current) return
    try {
      if (recorder.state !== 'inactive') {
        if (recorder.state === 'recording') {
          try { recorder.requestData() } catch { /* final dataavailable is still emitted by stop */ }
        }
        recorder.stop()
      }
    } catch (error) {
      recordingCollectorRef.current?.dispose()
      recordingCollectorRef.current = null
      recordingStreamRef.current?.getTracks().forEach((track) => track.stop())
      recorderRef.current = null
      recordingStreamRef.current = null
      recordingFinalizingRef.current = false
      setRecording(false)
      setNotice({ type: 'error', text: error instanceof Error ? error.message : '无法停止录音。' })
    }
  }

  const updateActive = (patch: Partial<AudioAsset>) => {
    if (!active) return
    setLibrary((items) => items.map((item) => item.id === active.id ? { ...item, ...patch } : item))
  }

  const createPlaylist = async (): Promise<Playlist | null> => {
    const name = window.prompt('新歌单名称', '我的歌单')?.trim()
    if (!name) return null
    const now = Date.now()
    const playlist: Playlist = { id: uid(), name, trackIds: [], createdAt: now, updatedAt: now }
    setPlaylists((items) => [...items, playlist])
    if (isTauriRuntime()) { try { await dbCreatePlaylist(playlist) } catch (error) { setNotice({ type: 'error', text: error instanceof Error ? error.message : '无法创建歌单。' }) } }
    return playlist
  }

  const renamePlaylist = async (playlist: Playlist) => {
    const name = window.prompt('重命名歌单', playlist.name)?.trim()
    if (!name || name === playlist.name) return
    setPlaylists((items) => items.map((item) => item.id === playlist.id ? { ...item, name, updatedAt: Date.now() } : item))
    if (isTauriRuntime()) { try { await dbRenamePlaylist(playlist.id, name) } catch (error) { setNotice({ type: 'error', text: error instanceof Error ? error.message : '无法重命名歌单。' }) } }
  }

  const deletePlaylist = async (playlist: Playlist) => {
    if (!window.confirm(`删除歌单“${playlist.name}”？歌曲文件不会被删除。`)) return
    setPlaylists((items) => items.filter((item) => item.id !== playlist.id))
    if (activePlaylistId === playlist.id) { setActivePlaylistId(null); setActivePage('playlists') }
    if (isTauriRuntime()) { try { await dbDeletePlaylist(playlist.id) } catch (error) { setNotice({ type: 'error', text: error instanceof Error ? error.message : '无法删除歌单。' }) } }
  }

  const addActiveToPlaylist = async (playlist: Playlist) => {
    if (!active) return
    const next = addTrackToPlaylist(playlist, active.id)
    setPlaylists((items) => items.map((item) => item.id === playlist.id ? next : item))
    if (isTauriRuntime()) { try { await dbAddPlaylistTrack(playlist.id, active.id) } catch (error) { setNotice({ type: 'error', text: error instanceof Error ? error.message : '无法加入歌单。' }) } }
  }

  const toggleTrackSelection = (trackId: string) => {
    setSelectedTrackIds((ids) => ids.includes(trackId) ? ids.filter((id) => id !== trackId) : [...ids, trackId])
  }

  const addTracksToPlaylist = async (playlist: Playlist, trackIds: string[]) => {
    const ids = [...new Set(trackIds)].filter((id) => library.some((track) => track.id === id) && !playlist.trackIds.includes(id))
    if (!ids.length) return
    const next = ids.reduce((current, id) => addTrackToPlaylist(current, id), playlist)
    const previousPlaylists = playlists
    setPlaylists((items) => items.map((item) => item.id === playlist.id ? next : item))
    if (isTauriRuntime()) {
      try {
        await Promise.all(ids.map((id) => dbAddPlaylistTrack(playlist.id, id)))
      } catch (error) {
        setPlaylists(previousPlaylists)
        setNotice({ type: 'error', text: error instanceof Error ? error.message : '无法加入歌单。' })
        return
      }
    }
    setSelectedTrackIds([])
    setPlaylistPickerOpen(false)
    setNotice({ type: 'success', text: `已将 ${ids.length} 首歌曲加入“${playlist.name}”。` })
  }

  const removeActiveFromPlaylist = async (playlist: Playlist) => {
    if (!active) return
    const next = removeTrackFromPlaylist(playlist, active.id)
    setPlaylists((items) => items.map((item) => item.id === playlist.id ? next : item))
    if (isTauriRuntime()) { try { await dbRemovePlaylistTrack(playlist.id, active.id) } catch (error) { setNotice({ type: 'error', text: error instanceof Error ? error.message : '无法从歌单移除歌曲。' }) } }
  }

  const removeTrackFromPlaylistById = async (playlist: Playlist, trackId: string) => {
    if (!playlist.trackIds.includes(trackId)) return
    const next = removeTrackFromPlaylist({ ...playlist }, trackId)
    setPlaylists((items) => items.map((item) => item.id === playlist.id ? next : item))
    if (isTauriRuntime()) {
      try { await dbRemovePlaylistTrack(playlist.id, trackId) }
      catch (error) { setNotice({ type: 'error', text: error instanceof Error ? error.message : '无法从歌单移除歌曲。' }); return }
    }
    setNotice({ type: 'success', text: '已从当前歌单移除歌曲。' })
  }

  const playPlaylist = (playlist: Playlist, randomize = false) => {
    const allTracks = playlist.trackIds.map((id) => library.find((item) => item.id === id)).filter((track): track is AudioAsset => Boolean(track))
    const tracks = allTracks.filter((track) => Boolean(track.url) && !track.unavailable)
    if (!tracks.length) {
      setNotice({ type: 'info', text: allTracks.length ? '这个歌单中的文件都不可用，请重新导入后再播放。' : '这个歌单还没有可播放的歌曲。' })
      return
    }
    if (tracks.length < allTracks.length) setNotice({ type: 'info', text: `已跳过 ${allTracks.length - tracks.length} 个不可用文件。` })
    const ordered = [...tracks]
    if (randomize) {
      // Fisher–Yates gives a real queue order; changing the playback mode alone
      // would leave the first pass in playlist order and made shuffle look inert.
      for (let index = ordered.length - 1; index > 0; index -= 1) {
        const swapIndex = Math.floor(Math.random() * (index + 1))
        ;[ordered[index], ordered[swapIndex]] = [ordered[swapIndex], ordered[index]]
      }
    }
    const player = playerRef.current
    player?.setMode(randomize ? 'shuffle' : 'sequential')
    player?.setQueue(ordered, { preserveCurrent: false, queueSource: { type: 'playlist', id: playlist.id, name: playlist.name } })
    setQueueSource(`来自：${playlist.name}`)
    player?.play(ordered[0].id)
    setActivePlaylistId(playlist.id); setActivePage('playlists')
  }

  const playPlaylistFromTrack = (playlist: Playlist, trackId: string) => {
    const allTracks = playlist.trackIds.map((id) => library.find((item) => item.id === id)).filter((track): track is AudioAsset => Boolean(track))
    const available = allTracks.filter((track) => Boolean(track.url) && !track.unavailable)
    const startIndex = available.findIndex((track) => track.id === trackId)
    if (startIndex < 0) { setNotice({ type: 'error', text: '该歌曲文件不可用，请重新导入。' }); return }
    const ordered = [...available.slice(startIndex), ...available.slice(0, startIndex)]
    playerRef.current?.setQueue(ordered, { preserveCurrent: false, queueSource: { type: 'playlist', id: playlist.id, name: playlist.name } })
    setQueueSource(`来自：${playlist.name}`)
    playerRef.current?.play(ordered[0].id)
  }

  const handleCoverChange = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0]
    if (!file || !active) return
    const reader = new FileReader()
    reader.onload = () => {
      const coverDataUrl = typeof reader.result === 'string' ? reader.result : undefined
      updateActive({ coverDataUrl })
      if (isTauriRuntime() && coverDataUrl) void dbUpsertTrack({ ...active, coverDataUrl }).catch((error) => setNotice({ type: 'error', text: error instanceof Error ? error.message : '无法保存封面。' }))
    }
    reader.readAsDataURL(file)
    event.target.value = ''
  }

  const toggleFavorite = async () => {
    if (!active) return
    const favorite = !active.favorite
    updateActive({ favorite })
    if (isTauriRuntime()) { try { await dbSetFavorite(active.id, favorite) } catch (error) { setNotice({ type: 'error', text: error instanceof Error ? error.message : '无法更新收藏状态。' }) } }
  }

  const toggleTrackFavorite = async (track: AudioAsset) => {
    const favorite = !track.favorite
    setLibrary((items) => items.map((item) => item.id === track.id ? { ...item, favorite } : item))
    if (isTauriRuntime()) {
      try { await dbSetFavorite(track.id, favorite) } catch (error) {
        setNotice({ type: 'error', text: error instanceof Error ? error.message : '无法更新收藏状态。' })
      }
    }
  }

  const reorderActivePlaylist = async (fromIndex: number, toIndex: number) => {
    if (!activePlaylist) return
    const next = reorderPlaylist(activePlaylist, fromIndex, toIndex)
    setPlaylists((items) => items.map((item) => item.id === next.id ? next : item))
    if (isTauriRuntime()) { try { await dbReorderPlaylistTracks(next.id, next.trackIds) } catch (error) { setNotice({ type: 'error', text: error instanceof Error ? error.message : '无法保存歌单顺序。' }) } }
  }

  const saveDetails = () => {
    if (!active) return
    const updated = { ...active, ...metadataDraft }
    updateActive(metadataDraft)
    if (isTauriRuntime()) void dbUpsertTrack(updated).catch((error) => setNotice({ type: 'error', text: error instanceof Error ? error.message : '无法保存歌曲信息。' }))
    setNotice({ type: 'success', text: '标签信息已更新。' })
  }

  const selectedNativeSaveDirectory = () => {
    const value = preferences.saveDirectory.trim()
    return value && value !== defaultPreferences.saveDirectory ? value : undefined
  }

  const chooseSaveDirectory = async () => {
    if (!isTauriRuntime()) {
      setNotice({ type: 'info', text: '浏览器开发模式无法选择本地保存文件夹，请使用 Windows 原生版设置。' })
      return
    }
    try {
      const selected = await pickNativeDirectory()
      if (!selected) return
      const normalized = await setNativeSaveDirectory(selected)
      setPreferences((current) => ({ ...current, saveDirectory: normalized }))
      setNotice({ type: 'success', text: `已将新的截取和录音保存目录设为：${normalized}` })
    } catch (error) {
      setNotice({ type: 'error', text: error instanceof Error ? error.message : '无法设置保存目录。' })
    }
  }

  const repairRecording = async () => {
    if (!active || active.kind !== 'recording' || active.duration > 0) return
    let generatedPath: string | null = null
    try {
      setNotice({ type: 'info', text: '正在重新检测录音并修复音频容器…' })
      if (isTauriRuntime() && active.path) {
        const native = await repairNativeRecording(active.path)
        generatedPath = native.path
        const repairedUrl = nativeAssetUrl(native.path)
        await probeAudioUrl(repairedUrl)
        const repaired: AudioAsset = {
          ...active,
          fileName: native.file_name,
          format: native.format,
          duration: native.duration,
          size: native.size,
          path: native.path,
          url: repairedUrl,
          blob: undefined,
        }
        await dbUpsertTrack(repaired)
        if (active.path !== native.path) await deleteNativeMedia(active.path).catch(() => undefined)
        setLibrary((items) => items.map((item) => item.id === active.id ? repaired : item))
        setEnd(native.duration)
        setNotice({ type: 'success', text: `录音已修复并重新检测（${formatTime(native.duration)}）。` })
        return
      }
      if (active.blob) {
        const duration = await probeRecordedBlob(active.blob)
        updateActive({ duration })
        setEnd(duration)
        setNotice({ type: 'success', text: `已重新检测录音时长（${formatTime(duration)}）。` })
        return
      }
      throw new Error('当前录音没有可读取的文件。')
    } catch (error) {
      if (generatedPath && generatedPath !== active.path) void deleteNativeMedia(generatedPath).catch(() => undefined)
      setNotice({ type: 'error', text: error instanceof Error ? error.message : '重新检测录音失败。' })
    }
  }

  const deleteActive = async () => {
    if (!active) return
    // Stop playback before any asynchronous native-file deletion so the
    // current row cannot continue producing sound while it is being removed.
    removeTrackFromPlaybackQueue(active.id)
    if (isTauriRuntime() && active.kind === 'clip' && active.path) {
      try { await deleteNativeMedia(active.path) } catch (error) {
        setNotice({ type: 'error', text: error instanceof Error ? error.message : '无法删除音乐文件。' }); return
      }
    }
    if (active.url) { URL.revokeObjectURL(active.url); urlsRef.current.delete(active.url) }
    if (isTauriRuntime()) void dbDeleteTrack(active.id).catch((error) => setNotice({ type: 'error', text: error instanceof Error ? error.message : '无法更新数据库。' }))
    setLibrary((items) => items.filter((item) => item.id !== active.id)); setPlaylists((items) => items.map((playlist) => removeTrackFromPlaylist(playlist, active.id))); setSelectedId(null); selectedIdRef.current = null; setNotice({ type: 'success', text: '已从音乐库移除。' })
  }

  /** Remove the rows selected in the library list.  Files imported from an
   * arbitrary source location are left on disk; only clips and recordings
   * created inside an app-managed output directory are safe to remove here.
   * The database command cascades playlist and queue relations, while the
   * playback state is updated immediately so a deleted current track cannot
   * keep playing during the asynchronous cleanup.
   */
  const deleteSelectedTracks = async () => {
    const ids = [...new Set(selectedTrackIds)].filter((id) => library.some((track) => track.id === id))
    if (!ids.length) return
    const tracks = ids.map((id) => library.find((track) => track.id === id)).filter((track): track is AudioAsset => Boolean(track))
    const confirmed = window.confirm(`确定从音乐库删除选中的 ${tracks.length} 首歌曲？\n截取片段和录音文件会一并删除，导入原文件会保留在原位置。`)
    if (!confirmed) return

    const currentId = playerRef.current?.getState().currentTrackId
    if (currentId && ids.includes(currentId)) stopAudioPlayback()
    const player = playerRef.current
    ids.forEach((id) => player?.removeFromQueue(id))

    const deleted: AudioAsset[] = []
    const failures: string[] = []
    for (const track of tracks) {
      // Imported source files may live anywhere on the user's machine. Do
      // not turn a library removal into an unexpected filesystem deletion.
      if (isTauriRuntime() && (track.kind === 'clip' || track.kind === 'recording') && track.path) {
        try {
          await deleteNativeMedia(track.path)
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error)
          // A stale clip/recording path is already gone; remove its library
          // record while reporting only real filesystem/safety failures.
          if (!message.includes('文件不存在')) {
            failures.push(`${track.title}: ${message || '文件删除失败'}`)
            continue
          }
        }
      }
      if (track.url?.startsWith('blob:')) {
        URL.revokeObjectURL(track.url)
        urlsRef.current.delete(track.url)
      }
      if (isTauriRuntime()) {
        try {
          // db_delete_track uses foreign-key cascades to remove playlist and
          // queue relations for this track in the same database operation.
          await dbDeleteTrack(track.id)
        } catch (error) {
          failures.push(`${track.title}: ${error instanceof Error ? error.message : '数据库记录删除失败'}`)
          continue
        }
      }
      deleted.push(track)
    }

    const deletedIds = new Set(deleted.map((track) => track.id))
    if (deletedIds.size) {
      setLibrary((items) => items.filter((item) => !deletedIds.has(item.id)))
      setPlaylists((items) => items.map((playlist) => {
        const nextIds = playlist.trackIds.filter((id) => !deletedIds.has(id))
        return nextIds.length === playlist.trackIds.length ? playlist : { ...playlist, trackIds: nextIds, updatedAt: Date.now() }
      }))
      if (selectedIdRef.current && deletedIds.has(selectedIdRef.current)) {
        setSelectedId(null)
        selectedIdRef.current = null
      }
    }
    setSelectedTrackIds([])
    if (failures.length) {
      const summary = failures.slice(0, 2).join('；')
      setNotice({ type: deleted.length ? 'info' : 'error', text: `${deleted.length ? `已删除 ${deleted.length} 首歌曲。` : '未能删除所选歌曲。'}${failures.length > 2 ? `另有 ${failures.length - 2} 项失败。` : ''} ${summary}` })
    } else {
      setNotice({ type: 'success', text: `已删除 ${deleted.length} 首歌曲。` })
    }
  }

  const saveDownload = () => {
    if (active?.path && isTauriRuntime()) {
      setNotice({ type: 'success', text: '文件已保存在 RinkoSound 音乐库目录。' })
      return
    }
    if (!active?.blob) return
    downloadBlob(active.blob, active.fileName)
    setNotice({ type: 'success', text: '已开始保存到本地下载目录。' })
  }

  const canEdit = Boolean(active && active.url && duration > 0 && (isTauriRuntime() ? active.path : active.blob))
  const updateOutputFormat = (value: OutputFormat) => { setFormat(value); setPreferences((current) => ({ ...current, outputFormat: value })) }
  const updateQuality = (value: Quality) => { setQuality(value); setPreferences((current) => ({ ...current, quality: value })) }
  const pageTitle = activePage === 'playlists' ? (activePlaylist?.name || pageTitles.playlists) : pageTitles[activePage]
  const queueDisplaySource = playerState?.queueSource?.name ? `来自：${playerState.queueSource.name}` : (queueSource || '临时队列')
  const openPlaylistPicker = (trackIds: string[]) => {
    setSelectedTrackIds([...new Set(trackIds)])
    setPlaylistPickerOpen(true)
  }

  const renderTrackRows = (tracks: AudioAsset[], options?: { draggable?: boolean; showDate?: boolean; playlist?: Playlist }) => tracks.length ? (
    <div className="track-table">
      <div className="track-table-head"><span>歌曲</span><span>专辑</span><span>{options?.showDate ? '添加日期' : '时长'}</span><span /></div>
      {tracks.map((item, index) => (
        <div className={`track-row ${selectedId === item.id ? 'selected' : ''} ${playerState?.currentTrackId === item.id ? 'playing' : ''}`} key={item.id} draggable={options?.draggable} onClick={(event) => { const target = event.target; if (target instanceof Element && target.closest('button,input,select,a')) return; selectAsset(item) }} onDragStart={() => options?.draggable && setPlaylistDragIndex(index)} onDragOver={(event) => options?.draggable && event.preventDefault()} onDrop={() => { if (options?.draggable && playlistDragIndex !== null) void reorderActivePlaylist(playlistDragIndex, index); setPlaylistDragIndex(null) }}>
          <div className="track-main" role="button" tabIndex={0} onKeyDown={(event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); selectAsset(item) } }}>
            <input className="track-select" type="checkbox" checked={selectedTrackIds.includes(item.id)} onChange={() => toggleTrackSelection(item.id)} onClick={(event) => event.stopPropagation()} aria-label={`选择 ${item.title}`} />
            <span className={`asset-icon ${item.kind}`}><AudioLines size={16} /></span>
            <span className="track-info"><strong>{item.title}</strong><small>{item.artist} · {item.format}</small></span>
          </div>
          <span className="track-album">{item.album || '未分类'}</span>
          <span className="track-duration">{options?.showDate ? new Date(item.createdAt).toLocaleDateString('zh-CN') : formatTime(item.duration)}</span>
          <span className="track-row-actions">
            {options?.playlist ? <>
              <button aria-label="播放" title="立即播放" onClick={(event) => { event.preventDefault(); event.stopPropagation(); playPlaylistFromTrack(options.playlist as Playlist, item.id) }}>▶</button>
              <button aria-label="下一首播放" title="下一首播放" onClick={(event) => { event.preventDefault(); event.stopPropagation(); playTrackNext(item, `来自：${options.playlist?.name ?? '我的歌单'}`) }}>下首</button>
            </> : <button aria-label="播放" title="立即播放" onClick={(event) => { event.preventDefault(); event.stopPropagation(); playTrack(item.id) }}>▶</button>}
            <button aria-label="加入歌单" title="加入歌单" onClick={(event) => { event.preventDefault(); event.stopPropagation(); openPlaylistPicker([item.id]) }}>+歌单</button>
            <button aria-label={item.favorite ? '取消收藏' : '收藏'} title={item.favorite ? '取消收藏' : '收藏'} onClick={(event) => { event.preventDefault(); event.stopPropagation(); void toggleTrackFavorite(item) }}>{item.favorite ? '★' : '☆'}</button>
            <button aria-label="加入播放队列" title="加入播放队列" onClick={(event) => { event.preventDefault(); event.stopPropagation(); addTrackToQueue(item, options?.playlist ? `来自：${options.playlist.name}` : '来自：音乐库') }}>+队列</button>
            {options?.playlist && <button aria-label="从歌单移除" title="从当前歌单移除" onClick={(event) => { event.preventDefault(); event.stopPropagation(); void removeTrackFromPlaylistById(options.playlist as Playlist, item.id) }}>移除</button>}
            {options?.draggable && <GripVertical size={15} className="grip" />}
          </span>
        </div>
      ))}
    </div>
  ) : (
    <div className="page-empty"><Library size={30} /><strong>{activePage === 'favorites' ? '还没有收藏歌曲' : activePage === 'recent' ? '最近还没有添加歌曲' : activePage === 'playlists' ? '歌单还是空的' : '音乐库是空的'}</strong><span>{activePage === 'favorites' ? '在歌曲行点击 ☆，收藏的歌曲会显示在这里。' : activePage === 'recent' ? '导入本地音频或视频后，歌曲会出现在这里。' : '点击“导入媒体”开始整理本地音乐。'}</span>{activePage !== 'favorites' && activePage !== 'playlists' && <button className="primary-button" onClick={handleImportClick}><Upload size={15} />导入媒体</button>}</div>
  )

  const renderListPage = (kind: 'library' | 'recent' | 'favorites') => {
    const tracks = pageTracks
    const isLibrary = kind === 'library'
    return <section className="page-card library-page">
      <div className="page-toolbar"><div><span className="eyebrow">{isLibrary ? 'ALL LOCAL TRACKS' : kind === 'recent' ? 'ADDED RECENTLY' : 'YOUR FAVORITES'}</span><h2>{isLibrary ? '全部歌曲' : kind === 'recent' ? '按添加时间查看' : '只显示收藏歌曲'}</h2></div><div className="toolbar-actions">{selectedTrackIds.length > 0 && <><button className="record-button" onClick={() => openPlaylistPicker(selectedTrackIds)}>加入歌单 ({selectedTrackIds.length})</button><button className="record-button danger-button" onClick={() => void deleteSelectedTracks()}><Trash2 size={14} />删除歌曲 ({selectedTrackIds.length})</button></>}{isLibrary && <button className="primary-button compact" onClick={handleImportClick}><Plus size={15} />导入媒体</button>}</div></div>
      <div className="list-tools"><div className="search-box"><Search size={16} /><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="搜索标题、艺术家、专辑…" /><ListFilter size={15} /></div><div className="list-tool-right"><span>{tracks.length} 首歌曲</span><select value={sort} onChange={(event) => setSort(event.target.value as typeof sort)}><option value="recent">最近添加</option><option value="title">按标题</option><option value="duration">按时长</option></select></div></div>
      <div className="batch-select"><label><input type="checkbox" checked={tracks.length > 0 && tracks.every((track) => selectedTrackIds.includes(track.id))} onChange={(event) => setSelectedTrackIds(event.target.checked ? tracks.map((track) => track.id) : [])} />全选本页</label><span>双击歌曲播放；将鼠标移到歌曲行可加入歌单或队列。</span></div>
      {renderTrackRows(tracks, { showDate: kind === 'recent' })}
    </section>
  }

  const renderPlaylistPage = () => {
    if (!activePlaylist) return <section className="page-card playlist-index"><div className="page-toolbar"><div><span className="eyebrow">PLAYLISTS</span><h2>我的歌单</h2></div><button className="primary-button compact" onClick={() => void createPlaylist()}><Plus size={15} />新建歌单</button></div>{playlists.length ? <div className="playlist-grid">{playlists.map((playlist) => <button key={playlist.id} className="playlist-card" onClick={() => { setActivePlaylistId(playlist.id); setActivePage('playlists') }}><span className="playlist-cover"><AudioLines size={24} /></span><strong>{playlist.name}</strong><small>{playlist.trackIds.length} 首歌曲</small></button>)}</div> : <div className="page-empty"><ListFilter size={30} /><strong>还没有歌单</strong><span>创建歌单后，在歌曲行点击“+歌单”即可添加歌曲。</span><button className="primary-button" onClick={() => void createPlaylist()}><Plus size={15} />新建歌单</button></div>}</section>
    const tracks = pageTracks
    return <section className="page-card playlist-detail"><div className="playlist-hero"><span className="playlist-cover large"><AudioLines size={34} /></span><div><span className="eyebrow">PLAYLIST</span><h2>{activePlaylist.name}</h2><p>{tracks.length} 首歌曲 · {formatTime(tracks.reduce((sum, track) => sum + track.duration, 0))}</p></div><div className="playlist-hero-actions"><button className="primary-button compact" onClick={() => playPlaylist(activePlaylist)} disabled={!tracks.length}><Play size={15} />播放全部</button><button className="record-button" onClick={() => playPlaylist(activePlaylist, true)} disabled={!tracks.length}><Sparkles size={15} />随机播放</button><button className="record-button" onClick={() => void renamePlaylist(activePlaylist)}><Pencil size={14} />重命名</button><button className="record-button danger-button" onClick={() => void deletePlaylist(activePlaylist)}><Trash2 size={14} />删除歌单</button></div></div><div className="playlist-list-tools"><span>拖拽歌曲调整顺序 · 播放队列的临时排序不会改变歌单</span><button className="record-button" onClick={() => { setActivePage('library'); setNotice({ type: 'info', text: `已打开音乐库，请在歌曲行点击“+歌单”添加到“${activePlaylist.name}”。` }) }} disabled={!library.length}>从音乐库添加</button></div>{renderTrackRows(tracks, { draggable: true, playlist: activePlaylist })}</section>
  }

  const renderClipPage = () => <section className="clip-page"><div className={`drop-zone ${isDragging ? 'dragging' : ''}`} onDragOver={(event) => { event.preventDefault(); setIsDragging(true) }} onDragLeave={() => setIsDragging(false)} onDrop={onDrop}><div className="drop-icon"><Upload size={21} /></div><div><strong>第一步：选择视频或音频素材</strong><span>支持从音乐库选择，或浏览 MP4 · MKV · WebM · MOV · MP3 · WAV · M4A</span></div><div className="clip-source-actions"><button className="record-button compact" onClick={() => { setClipLibrarySearch(''); setClipLibraryPickerOpen(true) }}><Library size={14} />从音乐库选择</button><button className="record-button compact" onClick={handleImportClick}><FolderOpen size={14} />浏览文件</button></div></div>{active && <div className="clip-step-hint"><span>2</span><div><strong>已选择：{active.title}</strong><small>试听并设置开始、结束时间；保存后可继续编辑。</small></div></div>}<div className="clip-editor-layout"><div className="editor-column"><div className="section-heading"><div><span className="eyebrow">{active?.kind === 'clip' ? 'REFINE CLIP' : 'CLIP EDITOR'}</span><h2>{active ? active.title : '选择一个素材开始'}</h2></div>{active && <span className="file-chip">{active.format} · {formatTime(duration)}</span>}</div><div className="player-card">{active ? <><div className="track-visual"><div className="cover-art">{active.coverDataUrl ? <img src={active.coverDataUrl} alt="" /> : <AudioLines size={28} />}</div><div className="track-copy"><strong>{active.title}</strong><span>{active.artist} · {active.album}</span><small>{active.fileName}</small></div><button className="round-play" onClick={() => void togglePreviewClip()} disabled={!canEdit} aria-label={isPreviewPlaying ? '暂停试听' : '试听片段'}>{isPreviewPlaying ? <Pause size={20} /> : <Play size={20} fill="currentColor" />}</button></div><div className="waveform"><div className="wave-bars">{(waveformSamples.length ? waveformSamples : Array.from({ length: 72 }, (_, i) => (18 + ((i * 31) % 55)) / 100)).map((amplitude, i) => <i key={i} style={{ height: `${Math.max(8, Math.round(amplitude * 100))}%`, opacity: i / 72 < (duration ? playhead / duration : 0) ? 1 : 0.45 }} />)}</div><div className="range-line"><span style={{ left: `${duration ? (start / duration) * 100 : 0}%` }} /><span style={{ left: `${duration ? (end / duration) * 100 : 100}%` }} /></div></div><div className="timeline"><span>{formatTime(playhead)}</span><input aria-label="播放进度" type="range" min="0" max={duration || 1} step="0.01" value={playhead} onChange={(event) => { const value = Number(event.target.value); setPlayhead(value); playerRef.current?.seek(value); if (audioRef.current) audioRef.current.currentTime = value }} /><span>{formatTime(duration)}</span></div></> : <div className="empty-player"><FileAudio size={28} /><strong>还没有选择音频</strong><span>导入文件后，在这里试听和精确设置剪辑范围。</span></div>}</div><div className="clip-controls"><div className="control-header"><div><span className="eyebrow">TRIM RANGE</span><h3>第三步：设置时间与输出格式</h3></div><button className="ghost-button" onClick={() => { setStart(0); setEnd(duration) }} disabled={!active}><RotateCcw size={15} />重置范围</button></div><div className="time-inputs"><label><span>开始时间</span><div className="time-field"><Clock3 size={15} /><input type="number" min="0" step="0.01" value={start} onChange={(event) => setStart(Number(event.target.value))} /><em>秒</em></div></label><div className="arrow">→</div><label><span>结束时间</span><div className="time-field"><Clock3 size={15} /><input type="number" min="0" step="0.01" value={end} onChange={(event) => setEnd(Number(event.target.value))} /><em>秒</em></div></label><div className="selection-length"><small>片段长度</small><strong>{formatTime(Math.max(0, end - start))}</strong></div></div><div className="range-sliders"><span className="range-track" /><span className="range-selected" style={{ left: `${duration ? (start / duration) * 100 : 0}%`, right: `${duration ? 100 - (end / duration) * 100 : 0}%` }} /><input aria-label="开始时间滑块" type="range" min="0" max={duration || 1} step="0.01" value={start} onChange={(event) => setStart(Math.min(Number(event.target.value), end - 0.01))} /><input aria-label="结束时间滑块" type="range" min="0" max={duration || 1} step="0.01" value={end} onChange={(event) => setEnd(Math.max(Number(event.target.value), start + 0.01))} /></div><div className="output-row"><label><span>输出格式</span><div className="segmented">{formatOptions.map((option) => <button key={option.value} className={format === option.value ? 'selected' : ''} onClick={() => updateOutputFormat(option.value)}>{option.label}<small>{option.hint}</small></button>)}</div></label><label className="quality-select"><span>音质</span><div className="select-wrap"><select value={quality} onChange={(event) => updateQuality(event.target.value as Quality)}>{qualityOptions.map((option) => <option value={option.value} key={option.value}>{option.label}</option>)}</select><ChevronDown size={15} /></div></label><label className="volume-control"><span>音量 <strong>{Math.round(clipVolume * 100)}%</strong></span><div className="volume-control-input"><input aria-label="截取音频音量" type="range" min="0" max="2" step="0.01" value={clipVolume} onChange={(event) => setClipVolume(Math.min(2, Math.max(0, Number(event.target.value))))} /><output>{Math.round(clipVolume * 100)}%</output></div></label></div><div className="clip-actions"><button className="secondary-button" onClick={() => void togglePreviewClip()} disabled={!canEdit || isProcessing}>{isPreviewPlaying ? <Pause size={16} /> : <Play size={16} />} {isPreviewPlaying ? '暂停试听' : '试听片段'}</button>{isProcessing ? <button className="primary-button cancel" onClick={cancelClip}><X size={16} />取消 <span className="progress-mini">{Math.round(progress)}%</span></button> : <button className="primary-button" onClick={handleClip} disabled={!canEdit}><Sparkles size={16} />截取并保存<span className="shortcut">Enter</span></button>}</div>{isProcessing && <div className="progress-bar"><span style={{ width: `${progress}%` }} /></div>}<p className="helper-text"><SlidersHorizontal size={14} />第四步：保存后在成功提示中继续播放、加入歌单或重新截取。</p></div></div><div className="clip-side-card"><span className="eyebrow">AFTER SAVE</span><h3>{clipResultId ? '片段已保存' : '保存后你可以'}</h3><p>{clipResultId ? '这段音频已进入音乐库和最近添加。可以先完善歌曲信息，再选择下一步操作。' : '修改标题、艺术家和专辑，上传封面，再加入一个或多个歌单。'}</p>{clipResultId && <div className="clip-result-metadata"><label>标题<input value={metadataDraft.title} onChange={(event) => setMetadataDraft({ ...metadataDraft, title: event.target.value })} /></label><label>艺术家<input value={metadataDraft.artist} onChange={(event) => setMetadataDraft({ ...metadataDraft, artist: event.target.value })} /></label><label>专辑<input value={metadataDraft.album} onChange={(event) => setMetadataDraft({ ...metadataDraft, album: event.target.value })} /></label><button className="record-button" onClick={saveDetails}><Save size={14} />保存歌曲信息</button><button className="record-button" onClick={() => coverInputRef.current?.click()}>添加封面</button></div>}{clipResultId ? <div className="drawer-actions"><button className="primary-button" onClick={() => playTrack(clipResultId)}><Play size={15} />播放片段</button><button className="record-button" onClick={() => openPlaylistPicker([clipResultId])}>+ 加入歌单</button><button className="record-button" onClick={() => { setClipResultId(null); setSelectedId(null); setStart(0); setEnd(0) }}>继续截取</button></div> : active && <button className="record-button" onClick={() => openPlaylistPicker([active.id])}>+ 加入当前素材到歌单</button>}</div></div>{clipLibraryPickerOpen && <div className="modal-backdrop" role="presentation" onClick={() => setClipLibraryPickerOpen(false)}><div className="playlist-modal clip-library-modal" role="dialog" aria-modal="true" aria-label="从音乐库选择素材" onClick={(event) => event.stopPropagation()}><div className="playlist-modal-head"><div><span className="eyebrow">CLIP SOURCE</span><h2>从音乐库选择</h2><p>选择已有音频、视频或截取片段作为当前素材。</p></div><button className="icon-button" onClick={() => setClipLibraryPickerOpen(false)} aria-label="关闭素材选择"><X size={16} /></button></div><label className="modal-search"><Search size={16} /><input autoFocus value={clipLibrarySearch} onChange={(event) => setClipLibrarySearch(event.target.value)} placeholder="搜索标题、艺术家、专辑或文件名" /></label><div className="clip-library-list">{clipLibraryTracks.length ? clipLibraryTracks.map((track) => { const available = !track.unavailable && (isTauriRuntime() ? Boolean(track.path) : Boolean(track.url && track.blob)); return <button key={track.id} className={`clip-library-row ${available ? '' : 'unavailable'}`} onClick={() => { void selectClipAsset(track) }}><span className="clip-library-icon"><FileAudio size={18} /></span><span className="clip-library-copy"><strong>{track.title || track.fileName}</strong><small>{track.artist} · {track.album}</small><small>{track.format || '未知格式'} · {formatTime(track.duration)} · {track.fileName}</small></span><span className="clip-library-status">{available ? '选择' : '请重新导入'}</span></button> }) : <div className="modal-empty">音乐库中没有匹配的素材。</div>}</div></div></div>}</section>

  const renderSettingsPage = () => <section className="settings-page">
    <div className="settings-card"><span className="eyebrow">PLAYER</span><h2>播放设置</h2><label>默认播放模式<select value={playbackMode} onChange={(event) => playerRef.current?.setMode(event.target.value as PlaybackMode)}><option value="sequential">顺序播放</option><option value="repeat-all">循环播放全部</option><option value="repeat-one">单曲循环</option><option value="shuffle">随机播放</option></select></label><label>默认音量<input type="range" min="0" max="1" step="0.01" value={volume} onChange={(event) => playerRef.current?.setVolume(Number(event.target.value))} /></label></div>
    <div className="settings-card"><span className="eyebrow">OUTPUT</span><h2>截取默认值</h2><label>输出保存目录（截取 / 录音）<div className="save-directory-picker"><input value={preferences.saveDirectory} readOnly onClick={() => void chooseSaveDirectory()} placeholder="RinkoSound 音乐库目录" /><button className="record-button" onClick={() => void chooseSaveDirectory()}>选择文件夹</button></div><small className="setting-helper">导入原文件仍保留原路径；这里控制截取片段和录音的输出位置。</small></label><label>默认输出格式<select value={preferences.outputFormat} onChange={(event) => updateOutputFormat(event.target.value as OutputFormat)}><option value="mp3">MP3</option><option value="wav">WAV</option><option value="m4a">M4A</option></select></label><label>默认音质<select value={preferences.quality} onChange={(event) => updateQuality(event.target.value as Quality)}>{qualityOptions.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}</select></label></div>
    <div className="settings-card"><span className="eyebrow">DATA & PRIVACY</span><h2>数据管理</h2><p>音乐文件、歌单、收藏和播放状态仅保存在本机 SQLite 数据库与音乐库目录。</p><p>不上传用户文件，不添加遥测，也不会访问视频网站或浏览器 Cookie。</p><button className="record-button" onClick={() => setNotice({ type: 'info', text: '数据保存在本机应用数据目录，可在此目录备份数据库。' })}>查看数据位置</button></div>
    <div className="settings-card"><span className="eyebrow">SHORTCUTS</span><h2>快捷键</h2><div className="shortcut-list"><span><kbd>Space</kbd>播放/暂停</span><span><kbd>←</kbd> / <kbd>→</kbd>前后跳 5 秒</span><span><kbd>N</kbd>下一首　<kbd>P</kbd>上一首</span></div><label>主题<select value={preferences.theme} onChange={(event) => setPreferences((current) => ({ ...current, theme: event.target.value as AppPreferences['theme'] }))}><option value="dark">深色</option><option value="system">跟随系统（界面保持深色）</option></select></label></div>
  </section>

  const renderDetailsDrawer = () => {
    if (!active || activePage === 'clip') return null
    return <aside className="track-detail-drawer" aria-label="歌曲详情">
      <div className="drawer-head"><div><span className="eyebrow">TRACK DETAILS</span><h2>歌曲详情</h2></div><button className="icon-button" onClick={() => setSelectedId(null)} aria-label="关闭详情"><X size={16} /></button></div>
      <div className="drawer-cover">{active.coverDataUrl ? <img src={active.coverDataUrl} alt="" /> : <AudioLines size={30} />}</div>
      <strong className="drawer-title">{active.title}</strong><span className="drawer-subtitle">{active.artist} · {active.album}</span>
      <label>标题<input value={metadataDraft.title} onChange={(event) => setMetadataDraft({ ...metadataDraft, title: event.target.value })} /></label>
      <label>艺术家<input value={metadataDraft.artist} onChange={(event) => setMetadataDraft({ ...metadataDraft, artist: event.target.value })} /></label>
      <label>专辑<input value={metadataDraft.album} onChange={(event) => setMetadataDraft({ ...metadataDraft, album: event.target.value })} /></label>
      <div className="drawer-actions drawer-primary-actions"><button className="primary-button" onClick={saveDetails}><Save size={14} />保存标签</button><button className="record-button drawer-favorite-button" onClick={toggleFavorite}>{active.favorite ? '★ 已收藏' : '☆ 收藏'}</button></div>
      <div className="drawer-actions drawer-playback-actions"><button className="primary-button drawer-play-button" onClick={() => playTrack(active.id)}><Play size={15} />立即播放</button><button className="record-button" onClick={() => openPlaylistPicker([active.id])}><Plus size={14} />加入歌单</button><button className="record-button" onClick={() => addTrackToQueue(active)}><ListFilter size={14} />播放队列</button><button className="record-button" onClick={() => playTrackNext(active)}>下一首</button></div>
      {active.kind === 'recording' && active.duration <= 0 && <div className="drawer-actions"><button className="record-button" onClick={() => void repairRecording()}>重新检测/转换录音</button></div>}
      <div className="drawer-actions drawer-secondary-actions"><button className="record-button" onClick={() => coverInputRef.current?.click()}>更换封面</button><button className="record-button danger-button" onClick={() => void deleteActive()}><Trash2 size={14} />移除歌曲</button></div>
    </aside>
  }

  const renderPage = () => {
    if (activePage === 'settings') return renderSettingsPage()
    if (activePage === 'clip') return renderClipPage()
    if (activePage === 'playlists') return renderPlaylistPage()
    return renderListPage(activePage)
  }

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand"><span className="brand-mark"><AudioLines size={19} /></span><span>RinkoSound</span><span className="brand-beta">LOCAL</span></div>
        <button className="import-button" onClick={handleImportClick}><Plus size={18} />导入媒体</button>
        <input ref={fileInputRef} type="file" hidden multiple accept=".mp4,.mkv,.webm,.mov,.mp3,.wav,.m4a,.aac,.flac,.ogg" onChange={onFileChange} /><input ref={coverInputRef} type="file" hidden accept="image/*" onChange={handleCoverChange} />
        <nav className="side-nav">
          <button className={activePage === 'library' ? 'active' : ''} onClick={() => { setActivePage('library'); setActiveFilter('all'); setActivePlaylistId(null) }}><Library size={17} />音乐库<span>{library.length}</span></button>
          <button className={activePage === 'recent' ? 'active' : ''} onClick={() => { setActivePage('recent'); setActiveFilter('all'); setActivePlaylistId(null) }}><Clock3 size={17} />最近添加<span>{library.length}</span></button>
          <button className={activePage === 'favorites' ? 'active' : ''} onClick={() => { setActivePage('favorites'); setActiveFilter('all'); setActivePlaylistId(null) }}><Sparkles size={17} />收藏<span>{library.filter((item) => item.favorite).length}</span></button>
          <button className={activePage === 'clip' ? 'active' : ''} onClick={() => { setActivePage('clip'); setActiveFilter('clip'); setActivePlaylistId(null) }}><FileAudio size={17} />截取工具<span>{library.filter((item) => item.kind === 'clip').length}</span></button>
          <button className={activePage === 'settings' ? 'active' : ''} onClick={() => { setActivePage('settings'); setActivePlaylistId(null) }}><SlidersHorizontal size={17} />设置</button>
        </nav>
        <div className="playlist-nav"><div className="playlist-nav-head"><button className="playlist-nav-title" onClick={() => { setActivePage('playlists'); setActivePlaylistId(null) }}>我的歌单</button><button onClick={() => void createPlaylist()} title="新建歌单"><Plus size={14} /></button></div>{playlists.map((playlist) => <button key={playlist.id} className={activePage === 'playlists' && activePlaylistId === playlist.id ? 'active' : ''} onClick={() => { setActivePage('playlists'); setActivePlaylistId(playlist.id); setActiveFilter('all') }}><span className="playlist-dot" />{playlist.name}<small>{playlist.trackIds.length}</small></button>)}</div>
        <div className="sidebar-bottom"><div className="storage-card"><div className="storage-icon"><Headphones size={17} /></div><div><strong>本地音乐库</strong><small>文件只保留在当前设备</small></div><span className="status-dot" /></div><div className="native-note">Windows 原生版将使用 FFmpeg + WASAPI，保留更高音质。</div></div>
      </aside>

      <main className="main-content">
        <header className="topbar"><div><div className="eyebrow">LOCAL AUDIO WORKSPACE</div><h1>{pageTitle}</h1></div>{(isListPage(activePage) || activePage === 'playlists') && <label className="topbar-search"><Search size={16} /><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="搜索歌曲、艺术家或专辑" /></label>}<div className="top-actions">{activePage === 'playlists' && activePlaylist && <><button className="record-button" onClick={() => void renamePlaylist(activePlaylist)}><Pencil size={14} />重命名</button><button className="record-button" onClick={() => void deletePlaylist(activePlaylist)}><Trash2 size={14} />删除歌单</button></>}<button className={`record-button ${showQueue ? 'active' : ''}`} onClick={() => setShowQueue((value) => !value)}><ListFilter size={16} />播放队列 {playerState?.queue.length || 0}</button><button className="record-button" onClick={recording ? stopRecording : startRecording}>{recording ? <><span className="record-pulse" />停止录音</> : <><Radio size={16} />录制系统音频</>}</button></div></header>
        {notice && <div className={`notice ${notice.type}`}><span>{notice.type === 'error' ? '!' : notice.type === 'success' ? '✓' : 'i'}</span>{notice.text}<button onClick={() => setNotice(null)}><X size={15} /></button></div>}
        {renderPage()}
        {renderDetailsDrawer()}
        <audio ref={audioRef} className="global-audio" onTimeUpdate={() => { const position = audioRef.current?.currentTime || 0; setPlayhead(position); playerRef.current?.seek(position); if (previewEndRef.current !== null && position >= previewEndRef.current) finishPreview() }} onEnded={handleAudioEnded} onError={() => setNotice({ type: 'error', text: '无法播放此媒体。请确认文件仍可访问，或重新导入。' })} onLoadedMetadata={() => { const loaded = audioRef.current?.duration || 0; if (active && active.duration === 0 && Number.isFinite(loaded)) { updateActive({ duration: loaded }); setEnd(loaded) } }} />
      </main>

      <AddToPlaylistModal open={playlistPickerOpen} tracks={selectedTrackIds.map((id) => library.find((track) => track.id === id)).filter((track): track is AudioAsset => Boolean(track))} playlists={playlists} onClose={() => setPlaylistPickerOpen(false)} onAdd={addTracksToPlaylist} onCreatePlaylist={createPlaylist} />

      {playerState && <footer className="player-dock">
        <div className="dock-track" onClick={() => { const current = library.find((track) => track.id === playerState.currentTrackId); if (current) selectAsset(current) }}><div className="dock-cover" style={{ backgroundImage: library.find((track) => track.id === playerState.currentTrackId)?.coverDataUrl ? `url(${library.find((track) => track.id === playerState.currentTrackId)?.coverDataUrl})` : undefined }}><AudioLines size={18} /></div><div><strong>{library.find((track) => track.id === playerState.currentTrackId)?.title || '尚未播放'}</strong><span>{library.find((track) => track.id === playerState.currentTrackId)?.artist || '选择歌曲开始播放'}</span></div></div>
        <div className="dock-controls"><button onClick={playPrevious} title="上一首">⏮</button><button className="dock-play" onClick={() => playerRef.current?.toggle()} title={playerState.isPlaying ? '暂停' : '播放'}>{playerState.isPlaying ? <Pause size={17} /> : <Play size={17} fill="currentColor" />}</button><button onClick={playNext} title="下一首">⏭</button></div>
        <div className="dock-progress"><span>{formatTime(playerState.position)}</span><input aria-label="播放器进度" type="range" min="0" max={library.find((track) => track.id === playerState.currentTrackId)?.duration || 1} step="0.01" value={playerState.position} onChange={(event) => { const value = Number(event.target.value); playerRef.current?.seek(value); if (audioRef.current) audioRef.current.currentTime = value }} /><span>{formatTime(library.find((track) => track.id === playerState.currentTrackId)?.duration || 0)}</span></div>
        <div className="dock-actions"><button className={`dock-queue ${showQueue ? 'active' : ''}`} onClick={() => setShowQueue((value) => !value)} title="打开播放队列"><ListFilter size={14} />队列 {playerState.queue.length}</button><button className="dock-playlist" onClick={() => playerState.currentTrackId && openPlaylistPicker([playerState.currentTrackId])} title="加入歌单">+歌单</button><select value={playerState.mode} onChange={(event) => playerRef.current?.setMode(event.target.value as PlaybackMode)} title="播放模式"><option value="sequential">顺序</option><option value="repeat-all">循环全部</option><option value="repeat-one">单曲循环</option><option value="shuffle">随机</option></select><button onClick={() => playerRef.current?.toggleMute()} title="静音">{playerState.muted ? '🔇' : '🔊'}</button><input aria-label="音量" type="range" min="0" max="1" step="0.01" value={playerState.muted ? 0 : playerState.volume} onChange={(event) => playerRef.current?.setVolume(Number(event.target.value))} /></div>
        {showQueue && <div className="queue-drawer">
          <div className="queue-head"><div><strong>播放队列</strong><span>{playerState.queue.length} 首 · {queueDisplaySource}</span></div><div className="queue-head-actions"><button onClick={playNext} disabled={!playerState.currentTrackId || playerState.queue.length < 2} title="播放下一首"><Play size={13} />播放下一首</button><button onClick={clearPlaybackQueue} disabled={!playerState.queue.length}><Trash2 size={14} />清空</button></div></div>
          <div className="queue-mode">当前模式：{playbackModeLabel(playerState.mode)}{playerState.currentTrackId && <span> · 当前 {Math.max(1, playerState.queue.findIndex((track) => track.id === playerState.currentTrackId) + 1)} / {playerState.queue.length}</span>}</div>
          {playerState.queue.length ? playerState.queue.map((track, index) => <div className={`queue-row ${track.id === playerState.currentTrackId ? 'playing' : ''}`} key={track.id} draggable onDragStart={() => setQueueDragIndex(index)} onDragOver={(event) => event.preventDefault()} onDrop={() => { if (queueDragIndex !== null) playerRef.current?.reorderQueue(queueDragIndex, index); setQueueDragIndex(null) }}>
            <button className="queue-track-button" onClick={(event) => { event.preventDefault(); event.stopPropagation(); playTrack(track.id, queueSource || undefined) }}><span>{index + 1}</span><strong>{track.title}</strong><small>{track.id === playerState.currentTrackId ? '正在播放' : index > playerState.queue.findIndex((item) => item.id === playerState.currentTrackId) ? '接下来' : track.artist} · {formatTime(track.duration)}</small></button>
            <div className="queue-row-actions"><button title="立即播放" onClick={(event) => { event.preventDefault(); event.stopPropagation(); playTrack(track.id, queueSource || undefined) }}>▶</button><button title="下一首播放" onClick={(event) => { event.preventDefault(); event.stopPropagation(); playTrackNext(track, queueSource || '来自：播放队列') }}>下首</button><button title="移除" onClick={(event) => { event.preventDefault(); event.stopPropagation(); removeTrackFromPlaybackQueue(track.id) }}><X size={13} /></button></div>
          </div>) : <div className="queue-empty"><ListFilter size={24} /><strong>播放队列为空</strong><span>从歌曲行点击“+队列”，或使用“播放全部”开始。</span></div>}
        </div>}
      </footer>}
    </div>
  )
}

