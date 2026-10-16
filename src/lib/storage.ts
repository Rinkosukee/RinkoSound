import type { AudioAsset, LibrarySnapshot } from '../types'
import { dedupeSnapshot, emptySnapshot, migrateSnapshot } from './library'

const KEY = 'soundforge-library-v1'
const SNAPSHOT_KEY = 'soundforge-library-v2'

export function loadMetadata(): AudioAsset[] {
  try {
    const value = JSON.parse(localStorage.getItem(KEY) || '[]') as AudioAsset[]
    return value.map((asset) => ({ ...asset, url: '' }))
  } catch {
    return []
  }
}

export function saveMetadata(items: AudioAsset[]): void {
  const serializable = items.map(({ blob: _blob, url: _url, ...item }) => item)
  try {
    localStorage.setItem(KEY, JSON.stringify(serializable))
  } catch (error) {
    const quotaError = error as DOMException
    if (quotaError?.name === 'QuotaExceededError' || quotaError?.name === 'NS_ERROR_DOM_QUOTA_REACHED') {
      throw new Error('磁盘空间不足，无法保存音乐库索引')
    }
    throw error
  }
}

export function loadSnapshot(): LibrarySnapshot {
  try {
    const current = localStorage.getItem(SNAPSHOT_KEY)
    if (current) return migrateSnapshot(JSON.parse(current))
    const legacy = localStorage.getItem(KEY)
    return legacy ? migrateSnapshot(JSON.parse(legacy)) : emptySnapshot()
  } catch {
    return emptySnapshot()
  }
}

export function saveSnapshot(snapshot: LibrarySnapshot): void {
  const safe = dedupeSnapshot(snapshot)
  const serializable = {
    ...safe,
    tracks: safe.tracks.map(({ blob: _blob, url: _url, ...track }) => track),
  }
  try {
    localStorage.setItem(SNAPSHOT_KEY, JSON.stringify(serializable))
  } catch (error) {
    const quotaError = error as DOMException
    if (quotaError?.name === 'QuotaExceededError' || quotaError?.name === 'NS_ERROR_DOM_QUOTA_REACHED') throw new Error('磁盘空间不足，无法保存音乐库数据')
    throw error
  }
}
