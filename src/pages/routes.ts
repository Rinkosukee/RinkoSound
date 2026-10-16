export type AppPage = 'library' | 'recent' | 'favorites' | 'playlists' | 'clip' | 'settings'

export const pageTitles: Record<AppPage, string> = {
  library: '音乐库',
  recent: '最近添加',
  favorites: '收藏歌曲',
  playlists: '我的歌单',
  clip: '截取工具',
  settings: '设置',
}

export const listPages: AppPage[] = ['library', 'recent', 'favorites']

export function isListPage(page: AppPage): boolean {
  return listPages.includes(page)
}
