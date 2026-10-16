import { useMemo, useState } from 'react'
import { Check, ListPlus, Plus, Search, X } from 'lucide-react'
import type { AudioAsset, Playlist } from '../types'

export interface AddToPlaylistModalProps {
  open: boolean
  tracks: AudioAsset[]
  playlists: Playlist[]
  onClose: () => void
  onAdd: (playlist: Playlist, trackIds: string[]) => Promise<void> | void
  onCreatePlaylist: () => Promise<Playlist | null> | Playlist | null
}

/**
 * Shared playlist picker used by library rows, the player and clip completion.
 * It deliberately owns only transient UI state; the parent remains the source
 * of truth for tracks and playlist membership.
 */
export default function AddToPlaylistModal({ open, tracks, playlists, onClose, onAdd, onCreatePlaylist }: AddToPlaylistModalProps) {
  const [query, setQuery] = useState('')
  const [busyId, setBusyId] = useState<string | null>(null)
  const normalizedQuery = query.trim().toLowerCase()
  const visiblePlaylists = useMemo(() => {
    if (!normalizedQuery) return playlists
    return playlists.filter((playlist) => playlist.name.toLowerCase().includes(normalizedQuery))
  }, [normalizedQuery, playlists])

  if (!open) return null

  const close = () => {
    setQuery('')
    setBusyId(null)
    onClose()
  }

  const addTo = async (playlist: Playlist) => {
    const pending = tracks.filter((track) => !playlist.trackIds.includes(track.id)).map((track) => track.id)
    if (!pending.length) return
    setBusyId(playlist.id)
    try {
      await onAdd(playlist, pending)
      close()
    } finally {
      setBusyId(null)
    }
  }

  const create = async () => {
    const playlist = await onCreatePlaylist()
    if (playlist) await addTo(playlist)
  }

  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) close() }}>
      <section className="playlist-modal" role="dialog" aria-modal="true" aria-labelledby="add-to-playlist-title">
        <header className="playlist-modal-head">
          <div><span className="eyebrow">PLAYLISTS</span><h2 id="add-to-playlist-title">加入歌单</h2><p>{tracks.length === 1 ? `选择要加入“${tracks[0].title}”的歌单` : `已选择 ${tracks.length} 首歌曲`}</p></div>
          <button className="icon-button" onClick={close} aria-label="关闭"><X size={17} /></button>
        </header>
        <label className="modal-search"><Search size={16} /><input autoFocus value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索歌单…" /></label>
        <div className="playlist-picker-list">
          {visiblePlaylists.length ? visiblePlaylists.map((playlist) => {
            const pending = tracks.filter((track) => !playlist.trackIds.includes(track.id)).length
            const complete = pending === 0
            return <button className="playlist-picker-row" key={playlist.id} disabled={complete || busyId === playlist.id} onClick={() => void addTo(playlist)}>
              <span className="playlist-picker-icon"><ListPlus size={16} /></span><span className="playlist-picker-copy"><strong>{playlist.name}</strong><small>{playlist.trackIds.length} 首歌曲{complete ? ' · 已添加' : ''}</small></span>{complete ? <Check size={17} className="playlist-added" /> : <span className="playlist-add-label">{busyId === playlist.id ? '添加中…' : '加入'}</span>}
            </button>
          }) : <div className="modal-empty">没有匹配的歌单</div>}
        </div>
        <button className="new-playlist-button" onClick={() => void create()}><Plus size={16} />新建歌单</button>
      </section>
    </div>
  )
}
