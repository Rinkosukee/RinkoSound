import { describe, expect, it } from 'vitest'
import type { AudioAsset, Playlist } from '../src/types'
import { addTrackToPlaylist, dedupeTracks, migrateSnapshot, removeTrackFromPlaylist, reorderPlaylist } from '../src/lib/library'

const track = (id: string, path = `C:/music/${id}.mp3`): AudioAsset => ({ id, name: id, fileName: `${id}.mp3`, kind: 'source', duration: 10, size: 100, format: 'MP3', url: '', path, title: id, artist: 'a', album: 'b', createdAt: 1 })

describe('library model and migration', () => {
  it('migrates the v1 array and deduplicates paths', () => {
    const first = track('one')
    const result = migrateSnapshot([first, { ...first, id: 'duplicate' }])
    expect(result.schemaVersion).toBe(2)
    expect(result.tracks).toHaveLength(1)
  })

  it('deduplicates case and slash variants', () => {
    expect(dedupeTracks([track('a', 'C:\\Music\\A.mp3'), track('b', 'c:/music/a.mp3')])).toHaveLength(1)
  })

  it('keeps playlist order and supports add/remove/reorder', () => {
    const playlist: Playlist = { id: 'p', name: 'Mix', trackIds: ['a', 'b'], createdAt: 1, updatedAt: 1 }
    expect(addTrackToPlaylist(playlist, 'a').trackIds).toEqual(['a', 'b'])
    expect(addTrackToPlaylist(playlist, 'c').trackIds).toEqual(['a', 'b', 'c'])
    expect(removeTrackFromPlaylist(playlist, 'a').trackIds).toEqual(['b'])
    expect(reorderPlaylist(playlist, 0, 1).trackIds).toEqual(['b', 'a'])
  })
})
