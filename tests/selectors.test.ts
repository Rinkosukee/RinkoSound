import { describe, expect, it } from 'vitest'
import type { AudioAsset, Playlist } from '../src/types'
import { selectFavoriteTracks, selectLibraryTracks, selectPlaylistTracks, selectRecentTracks, totalDuration } from '../src/lib/selectors'

const track = (id: string, createdAt: number, favorite = false): AudioAsset => ({
  id, name: id, fileName: `${id}.mp3`, kind: 'source', duration: createdAt / 10, size: 1,
  format: 'MP3', url: '', title: id, artist: 'artist', album: 'album', createdAt, favorite,
})

describe('library selectors', () => {
  const tracks = [track('old', 10), track('new', 30, true), track('middle', 20)]

  it('keeps all recent tracks and orders newest first', () => {
    expect(selectRecentTracks(tracks).map((item) => item.id)).toEqual(['new', 'middle', 'old'])
  })

  it('filters favorites without leaking other tracks', () => {
    expect(selectFavoriteTracks(tracks).map((item) => item.id)).toEqual(['new'])
  })

  it('supports search and deterministic sorting', () => {
    expect(selectLibraryTracks(tracks, { search: 'mid', sort: 'title' }).map((item) => item.id)).toEqual(['middle'])
  })

  it('keeps playlist order and ignores missing ids', () => {
    const playlist: Playlist = { id: 'p', name: 'P', trackIds: ['middle', 'missing', 'old'], createdAt: 1, updatedAt: 1 }
    expect(selectPlaylistTracks(tracks, playlist).map((item) => item.id)).toEqual(['middle', 'old'])
    expect(totalDuration(selectPlaylistTracks(tracks, playlist))).toBe(3)
  })
})
