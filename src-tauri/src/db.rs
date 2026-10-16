//! SQLite persistence for the local music library.
//!
//! The UI can still run in browser-only mode using its existing localStorage
//! fallback.  The Tauri application uses this module as the durable source of
//! truth for tracks, playlists, the play queue and player settings.  All
//! writes are parameterized and are performed in short transactions so a
//! failed update never leaves a half-written playlist.

use rusqlite::{params, Connection, OptionalExtension, Row};
use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use std::path::PathBuf;
use std::sync::{Mutex, MutexGuard};
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::{Manager, State};

pub const DB_FILE_NAME: &str = "soundforge.db";

#[derive(Debug)]
pub struct DatabaseState {
    connection: Mutex<Connection>,
    path: PathBuf,
}

impl DatabaseState {
    pub fn open(path: PathBuf) -> Result<Self, String> {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).map_err(|error| format!("无法创建数据目录：{error}"))?;
        }
        let connection = Connection::open(&path).map_err(|error| format!("无法打开音乐库数据库：{error}"))?;
        migrate(&connection)?;
        Ok(Self { connection: Mutex::new(connection), path })
    }

    #[cfg(test)]
    fn in_memory() -> Self {
        let connection = Connection::open_in_memory().expect("open in-memory database");
        migrate(&connection).expect("migrate in-memory database");
        Self { connection: Mutex::new(connection), path: PathBuf::from(":memory:") }
    }

    fn lock(&self) -> Result<MutexGuard<'_, Connection>, String> {
        self.connection.lock().map_err(|_| "音乐库数据库已损坏或被其他任务锁定。".to_string())
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TrackRecord {
    pub id: String,
    pub path: String,
    pub file_name: String,
    pub title: String,
    pub artist: String,
    pub album: String,
    pub kind: String,
    pub duration: f64,
    pub size: i64,
    pub format: String,
    #[serde(default)]
    pub cover_path: Option<String>,
    #[serde(default)]
    pub source_id: Option<String>,
    #[serde(default)]
    pub source_start: Option<f64>,
    #[serde(default)]
    pub source_end: Option<f64>,
    pub created_at: i64,
    pub updated_at: i64,
    #[serde(default)]
    pub is_favorite: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PlaylistRecord {
    pub id: String,
    pub name: String,
    pub created_at: i64,
    pub updated_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PlaylistTrackRecord {
    pub playlist_id: String,
    pub track_id: String,
    pub position: i64,
    pub track: TrackRecord,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct QueueItemRecord {
    pub position: i64,
    pub track_id: String,
    pub added_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LegacyTrackRecord {
    pub id: String,
    #[serde(default)]
    pub path: Option<String>,
    pub file_name: String,
    pub title: String,
    #[serde(default = "unknown_artist")]
    pub artist: String,
    #[serde(default = "unknown_album")]
    pub album: String,
    #[serde(default = "source_kind")]
    pub kind: String,
    #[serde(default)]
    pub duration: f64,
    #[serde(default)]
    pub size: i64,
    #[serde(default)]
    pub format: String,
    #[serde(default)]
    pub source_id: Option<String>,
    #[serde(default)]
    pub source_start: Option<f64>,
    #[serde(default)]
    pub source_end: Option<f64>,
    #[serde(default)]
    pub created_at: i64,
    #[serde(default)]
    pub cover_path: Option<String>,
    #[serde(default)]
    pub is_favorite: bool,
}

fn unknown_artist() -> String { "未知艺术家".to_string() }
fn unknown_album() -> String { "未分类".to_string() }
fn source_kind() -> String { "source".to_string() }

const MIGRATIONS: &[(i64, &str)] = &[(
    1,
    r#"
    CREATE TABLE IF NOT EXISTS tracks (
      id TEXT PRIMARY KEY NOT NULL,
      path TEXT NOT NULL,
      file_name TEXT NOT NULL,
      title TEXT NOT NULL,
      artist TEXT NOT NULL,
      album TEXT NOT NULL,
      kind TEXT NOT NULL DEFAULT 'source',
      duration REAL NOT NULL DEFAULT 0,
      size INTEGER NOT NULL DEFAULT 0,
      format TEXT NOT NULL DEFAULT '',
      cover_path TEXT,
      source_id TEXT,
      source_start REAL,
      source_end REAL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      is_favorite INTEGER NOT NULL DEFAULT 0 CHECK (is_favorite IN (0, 1)),
      UNIQUE(path)
    );
    CREATE INDEX IF NOT EXISTS idx_tracks_created_at ON tracks(created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_tracks_title ON tracks(title COLLATE NOCASE);
    CREATE TABLE IF NOT EXISTS playlists (
      id TEXT PRIMARY KEY NOT NULL,
      name TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_playlists_name ON playlists(name COLLATE NOCASE);
    CREATE TABLE IF NOT EXISTS playlist_tracks (
      playlist_id TEXT NOT NULL REFERENCES playlists(id) ON DELETE CASCADE,
      track_id TEXT NOT NULL REFERENCES tracks(id) ON DELETE CASCADE,
      position INTEGER NOT NULL,
      PRIMARY KEY (playlist_id, track_id)
    );
    CREATE INDEX IF NOT EXISTS idx_playlist_tracks_order ON playlist_tracks(playlist_id, position);
    CREATE TABLE IF NOT EXISTS queue_items (
      position INTEGER PRIMARY KEY NOT NULL,
      track_id TEXT NOT NULL REFERENCES tracks(id) ON DELETE CASCADE,
      added_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS app_state (
      key TEXT PRIMARY KEY NOT NULL,
      value TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    );
    "#,
)];

fn now_ms() -> i64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|duration| duration.as_millis() as i64).unwrap_or_default()
}

pub fn migrate(connection: &Connection) -> Result<(), String> {
    connection.pragma_update(None, "foreign_keys", "ON").map_err(|error| format!("启用数据库约束失败：{error}"))?;
    connection.execute_batch("CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY NOT NULL, applied_at INTEGER NOT NULL);")
        .map_err(|error| format!("创建迁移表失败：{error}"))?;
    let current: i64 = connection.query_row("SELECT COALESCE(MAX(version), 0) FROM schema_migrations", [], |row| row.get(0))
        .map_err(|error| format!("读取数据库版本失败：{error}"))?;
    for (version, sql) in MIGRATIONS.iter().copied().filter(|(version, _)| *version > current) {
        let transaction = connection.unchecked_transaction().map_err(|error| format!("开始数据库迁移失败：{error}"))?;
        transaction.execute_batch(sql).map_err(|error| format!("执行数据库迁移 {version} 失败：{error}"))?;
        transaction.execute("INSERT INTO schema_migrations(version, applied_at) VALUES (?1, ?2)", params![version, now_ms()])
            .map_err(|error| format!("记录数据库迁移 {version} 失败：{error}"))?;
        transaction.commit().map_err(|error| format!("提交数据库迁移 {version} 失败：{error}"))?;
    }
    Ok(())
}

fn row_to_track(row: &Row<'_>) -> rusqlite::Result<TrackRecord> {
    Ok(TrackRecord {
        id: row.get("id")?, path: row.get("path")?, file_name: row.get("file_name")?, title: row.get("title")?,
        artist: row.get("artist")?, album: row.get("album")?, kind: row.get("kind")?, duration: row.get("duration")?,
        size: row.get("size")?, format: row.get("format")?, cover_path: row.get("cover_path")?, source_id: row.get("source_id")?,
        source_start: row.get("source_start")?, source_end: row.get("source_end")?, created_at: row.get("created_at")?,
        updated_at: row.get("updated_at")?, is_favorite: row.get::<_, i64>("is_favorite")? != 0,
    })
}

fn track_select() -> &'static str {
    "SELECT id,path,file_name,title,artist,album,kind,duration,size,format,cover_path,source_id,source_start,source_end,created_at,updated_at,is_favorite FROM tracks"
}

fn track_columns(alias: &str) -> String {
    format!("{alias}.id,{alias}.path,{alias}.file_name,{alias}.title,{alias}.artist,{alias}.album,{alias}.kind,{alias}.duration,{alias}.size,{alias}.format,{alias}.cover_path,{alias}.source_id,{alias}.source_start,{alias}.source_end,{alias}.created_at,{alias}.updated_at,{alias}.is_favorite")
}

/// Explicit initialization command.  The setup hook initializes the database
/// before the window is created, but exposing this command lets an upgraded UI
/// verify that migration completed without having to know the filesystem path.
#[tauri::command]
pub fn db_initialize(state: State<'_, DatabaseState>) -> Result<String, String> {
    drop(state.lock()?);
    Ok(state.path.to_string_lossy().to_string())
}

#[tauri::command]
pub fn db_list_tracks(state: State<'_, DatabaseState>) -> Result<Vec<TrackRecord>, String> {
    let connection = state.lock()?;
    let mut statement = connection.prepare(&format!("{} ORDER BY created_at DESC", track_select())).map_err(|error| format!("读取音乐库失败：{error}"))?;
    let rows = statement.query_map([], row_to_track).map_err(|error| format!("读取音乐库失败：{error}"))?;
    rows.collect::<Result<Vec<_>, _>>().map_err(|error| format!("解析音乐库记录失败：{error}"))
}

#[tauri::command]
pub fn db_get_track(state: State<'_, DatabaseState>, id: String) -> Result<Option<TrackRecord>, String> {
    let connection = state.lock()?;
    connection.query_row(&format!("{} WHERE id = ?1", track_select()), params![id], row_to_track).optional()
        .map_err(|error| format!("读取歌曲失败：{error}"))
}

#[tauri::command]
pub fn db_find_track_by_path(state: State<'_, DatabaseState>, path: String) -> Result<Option<TrackRecord>, String> {
    let connection = state.lock()?;
    connection.query_row(&format!("{} WHERE path = ?1", track_select()), params![path], row_to_track).optional()
        .map_err(|error| format!("检查重复歌曲失败：{error}"))
}

#[tauri::command]
pub fn db_upsert_track(state: State<'_, DatabaseState>, track: TrackRecord) -> Result<TrackRecord, String> {
    if track.id.trim().is_empty() || track.path.trim().is_empty() { return Err("歌曲标识和本地路径不能为空。".to_string()); }
    if !track.duration.is_finite() || track.duration < 0.0 || track.size < 0 { return Err("歌曲时长或文件大小无效。".to_string()); }
    let connection = state.lock()?;
    let timestamp = now_ms();
    connection.execute(
        "INSERT INTO tracks(id,path,file_name,title,artist,album,kind,duration,size,format,cover_path,source_id,source_start,source_end,created_at,updated_at,is_favorite)
         VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,?17)
         ON CONFLICT(id) DO UPDATE SET path=excluded.path,file_name=excluded.file_name,title=excluded.title,artist=excluded.artist,album=excluded.album,
           kind=excluded.kind,duration=excluded.duration,size=excluded.size,format=excluded.format,cover_path=excluded.cover_path,
           source_id=excluded.source_id,source_start=excluded.source_start,source_end=excluded.source_end,updated_at=excluded.updated_at,is_favorite=excluded.is_favorite",
        params![track.id, track.path, track.file_name, track.title, track.artist, track.album, track.kind, track.duration, track.size, track.format,
            track.cover_path, track.source_id, track.source_start, track.source_end, if track.created_at > 0 { track.created_at } else { timestamp }, timestamp, track.is_favorite as i64],
    ).map_err(|error| if error.to_string().contains("UNIQUE constraint failed: tracks.path") { "该文件已经在音乐库中。".to_string() } else { format!("保存歌曲失败：{error}") })?;
    connection.query_row(&format!("{} WHERE id = ?1", track_select()), params![track.id], row_to_track)
        .map_err(|error| format!("读取保存后的歌曲失败：{error}"))
}

#[tauri::command]
pub fn db_delete_track(state: State<'_, DatabaseState>, id: String) -> Result<(), String> {
    let connection = state.lock()?;
    connection.execute("DELETE FROM tracks WHERE id = ?1", params![id]).map_err(|error| format!("从音乐库移除歌曲失败：{error}"))?;
    Ok(())
}

#[tauri::command]
pub fn db_set_track_favorite(state: State<'_, DatabaseState>, id: String, favorite: bool) -> Result<(), String> {
    let connection = state.lock()?;
    connection.execute("UPDATE tracks SET is_favorite = ?2, updated_at = ?3 WHERE id = ?1", params![id, favorite as i64, now_ms()])
        .map_err(|error| format!("更新收藏状态失败：{error}"))?;
    Ok(())
}

#[tauri::command]
pub fn db_list_playlists(state: State<'_, DatabaseState>) -> Result<Vec<PlaylistRecord>, String> {
    let connection = state.lock()?;
    let mut statement = connection.prepare("SELECT id,name,created_at,updated_at FROM playlists ORDER BY name COLLATE NOCASE").map_err(|error| format!("读取歌单失败：{error}"))?;
    let rows = statement.query_map([], |row| Ok(PlaylistRecord { id: row.get(0)?, name: row.get(1)?, created_at: row.get(2)?, updated_at: row.get(3)? }))
        .map_err(|error| format!("读取歌单失败：{error}"))?;
    rows.collect::<Result<Vec<_>, _>>().map_err(|error| format!("解析歌单失败：{error}"))
}

#[tauri::command]
pub fn db_create_playlist(state: State<'_, DatabaseState>, playlist: PlaylistRecord) -> Result<PlaylistRecord, String> {
    if playlist.id.trim().is_empty() || playlist.name.trim().is_empty() { return Err("歌单名称不能为空。".to_string()); }
    let connection = state.lock()?;
    let timestamp = now_ms();
    connection.execute("INSERT INTO playlists(id,name,created_at,updated_at) VALUES(?1,?2,?3,?4)", params![playlist.id, playlist.name.trim(), if playlist.created_at > 0 { playlist.created_at } else { timestamp }, timestamp])
        .map_err(|error| if error.to_string().contains("UNIQUE constraint failed") { "已存在同名歌单。".to_string() } else { format!("创建歌单失败：{error}") })?;
    Ok(PlaylistRecord { id: playlist.id, name: playlist.name.trim().to_string(), created_at: if playlist.created_at > 0 { playlist.created_at } else { timestamp }, updated_at: timestamp })
}

#[tauri::command]
pub fn db_rename_playlist(state: State<'_, DatabaseState>, id: String, name: String) -> Result<(), String> {
    if name.trim().is_empty() { return Err("歌单名称不能为空。".to_string()); }
    let connection = state.lock()?;
    connection.execute("UPDATE playlists SET name = ?2, updated_at = ?3 WHERE id = ?1", params![id, name.trim(), now_ms()])
        .map_err(|error| if error.to_string().contains("UNIQUE constraint failed") { "已存在同名歌单。".to_string() } else { format!("重命名歌单失败：{error}") })?;
    Ok(())
}

#[tauri::command]
pub fn db_delete_playlist(state: State<'_, DatabaseState>, id: String) -> Result<(), String> {
    let connection = state.lock()?;
    connection.execute("DELETE FROM playlists WHERE id = ?1", params![id]).map_err(|error| format!("删除歌单失败：{error}"))?;
    Ok(())
}

#[tauri::command]
pub fn db_list_playlist_tracks(state: State<'_, DatabaseState>, playlist_id: String) -> Result<Vec<PlaylistTrackRecord>, String> {
    let connection = state.lock()?;
    let sql = format!("SELECT pt.playlist_id,pt.track_id,pt.position,{} FROM playlist_tracks pt JOIN tracks t ON t.id=pt.track_id WHERE pt.playlist_id=?1 ORDER BY pt.position", track_columns("t"));
    let mut statement = connection.prepare(&sql).map_err(|error| format!("读取歌单歌曲失败：{error}"))?;
    let rows = statement.query_map(params![playlist_id], |row| Ok(PlaylistTrackRecord { playlist_id: row.get(0)?, track_id: row.get(1)?, position: row.get(2)?, track: row_to_track_at(row, 3)? }))
        .map_err(|error| format!("读取歌单歌曲失败：{error}"))?;
    rows.collect::<Result<Vec<_>, _>>().map_err(|error| format!("解析歌单歌曲失败：{error}"))
}

fn row_to_track_at(row: &Row<'_>, offset: usize) -> rusqlite::Result<TrackRecord> {
    Ok(TrackRecord {
        id: row.get(offset)?, path: row.get(offset + 1)?, file_name: row.get(offset + 2)?, title: row.get(offset + 3)?, artist: row.get(offset + 4)?, album: row.get(offset + 5)?, kind: row.get(offset + 6)?, duration: row.get(offset + 7)?, size: row.get(offset + 8)?, format: row.get(offset + 9)?, cover_path: row.get(offset + 10)?, source_id: row.get(offset + 11)?, source_start: row.get(offset + 12)?, source_end: row.get(offset + 13)?, created_at: row.get(offset + 14)?, updated_at: row.get(offset + 15)?, is_favorite: row.get::<_, i64>(offset + 16)? != 0,
    })
}

#[tauri::command]
pub fn db_add_playlist_track(state: State<'_, DatabaseState>, playlist_id: String, track_id: String, position: Option<i64>) -> Result<(), String> {
    let connection = state.lock()?;
    let exists: bool = connection.query_row("SELECT EXISTS(SELECT 1 FROM playlist_tracks WHERE playlist_id=?1 AND track_id=?2)", params![playlist_id, track_id], |row| row.get(0))
        .map_err(|error| format!("检查歌单歌曲失败：{error}"))?;
    if exists { return Ok(()); }
    let next_position: i64 = position.unwrap_or_else(|| connection.query_row("SELECT COALESCE(MAX(position), -1) + 1 FROM playlist_tracks WHERE playlist_id=?1", params![playlist_id], |row| row.get(0)).unwrap_or(0)).max(0);
    connection.execute("UPDATE playlist_tracks SET position=position+1 WHERE playlist_id=?1 AND position>=?2", params![playlist_id, next_position])
        .map_err(|error| format!("调整歌单顺序失败：{error}"))?;
    connection.execute("INSERT INTO playlist_tracks(playlist_id,track_id,position) VALUES(?1,?2,?3)", params![playlist_id, track_id, next_position])
        .map_err(|error| format!("添加歌曲到歌单失败：{error}"))?;
    Ok(())
}

#[tauri::command]
pub fn db_remove_playlist_track(state: State<'_, DatabaseState>, playlist_id: String, track_id: String) -> Result<(), String> {
    let connection = state.lock()?;
    connection.execute("DELETE FROM playlist_tracks WHERE playlist_id=?1 AND track_id=?2", params![playlist_id, track_id]).map_err(|error| format!("从歌单移除歌曲失败：{error}"))?;
    Ok(())
}

#[tauri::command]
pub fn db_reorder_playlist_tracks(state: State<'_, DatabaseState>, playlist_id: String, track_ids: Vec<String>) -> Result<(), String> {
    let unique: HashSet<&String> = track_ids.iter().collect();
    if unique.len() != track_ids.len() { return Err("歌单排序中包含重复歌曲。".to_string()); }
    let mut connection = state.lock()?;
    let transaction = connection.transaction().map_err(|error| format!("开始排序事务失败：{error}"))?;
    transaction.execute("DELETE FROM playlist_tracks WHERE playlist_id=?1", params![playlist_id]).map_err(|error| format!("清理歌单排序失败：{error}"))?;
    for (position, track_id) in track_ids.iter().enumerate() {
        transaction.execute("INSERT INTO playlist_tracks(playlist_id,track_id,position) VALUES(?1,?2,?3)", params![playlist_id, track_id, position as i64]).map_err(|error| format!("保存歌单排序失败：{error}"))?;
    }
    transaction.execute("UPDATE playlists SET updated_at=?2 WHERE id=?1", params![playlist_id, now_ms()]).map_err(|error| format!("更新歌单时间失败：{error}"))?;
    transaction.commit().map_err(|error| format!("提交歌单排序失败：{error}"))?;
    Ok(())
}

#[tauri::command]
pub fn db_get_queue(state: State<'_, DatabaseState>) -> Result<Vec<QueueItemRecord>, String> {
    let connection = state.lock()?;
    let mut statement = connection.prepare("SELECT position,track_id,added_at FROM queue_items ORDER BY position").map_err(|error| format!("读取播放队列失败：{error}"))?;
    let rows = statement.query_map([], |row| Ok(QueueItemRecord { position: row.get(0)?, track_id: row.get(1)?, added_at: row.get(2)? })).map_err(|error| format!("读取播放队列失败：{error}"))?;
    rows.collect::<Result<Vec<_>, _>>().map_err(|error| format!("解析播放队列失败：{error}"))
}

#[tauri::command]
pub fn db_set_queue(state: State<'_, DatabaseState>, track_ids: Vec<String>) -> Result<Vec<QueueItemRecord>, String> {
    let mut connection = state.lock()?;
    let transaction = connection.transaction().map_err(|error| format!("开始更新队列失败：{error}"))?;
    transaction.execute("DELETE FROM queue_items", []).map_err(|error| format!("清理播放队列失败：{error}"))?;
    let timestamp = now_ms();
    for (position, track_id) in track_ids.iter().enumerate() {
        transaction.execute("INSERT INTO queue_items(position,track_id,added_at) VALUES(?1,?2,?3)", params![position as i64, track_id, timestamp]).map_err(|error| format!("保存播放队列失败：{error}"))?;
    }
    transaction.commit().map_err(|error| format!("提交播放队列失败：{error}"))?;
    Ok(track_ids.into_iter().enumerate().map(|(position, track_id)| QueueItemRecord { position: position as i64, track_id, added_at: timestamp }).collect())
}

#[tauri::command]
pub fn db_get_app_state(state: State<'_, DatabaseState>, key: String) -> Result<Option<String>, String> {
    let connection = state.lock()?;
    connection.query_row("SELECT value FROM app_state WHERE key=?1", params![key], |row| row.get(0)).optional().map_err(|error| format!("读取应用设置失败：{error}"))
}

#[tauri::command]
pub fn db_set_app_state(state: State<'_, DatabaseState>, key: String, value: String) -> Result<(), String> {
    if key.trim().is_empty() { return Err("设置名称不能为空。".to_string()); }
    let connection = state.lock()?;
    connection.execute("INSERT INTO app_state(key,value,updated_at) VALUES(?1,?2,?3) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at", params![key, value, now_ms()])
        .map_err(|error| format!("保存应用设置失败：{error}"))?;
    Ok(())
}

/// Imports records from the v1 localStorage metadata shape.  Browser-only
/// entries without a real local path are deliberately skipped because there
/// is no durable file for the native player to open after restart.
#[tauri::command]
pub fn db_import_legacy_library(state: State<'_, DatabaseState>, assets: Vec<LegacyTrackRecord>) -> Result<usize, String> {
    let mut connection = state.lock()?;
    let transaction = connection.transaction().map_err(|error| format!("开始导入旧音乐库失败：{error}"))?;
    let mut imported = 0usize;
    for asset in assets {
        let Some(path) = asset.path.filter(|path| !path.trim().is_empty()) else { continue };
        let timestamp = if asset.created_at > 0 { asset.created_at } else { now_ms() };
        transaction.execute(
            "INSERT INTO tracks(id,path,file_name,title,artist,album,kind,duration,size,format,cover_path,source_id,source_start,source_end,created_at,updated_at,is_favorite)
             VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?15,?16)
             ON CONFLICT(path) DO UPDATE SET title=excluded.title,artist=excluded.artist,album=excluded.album,updated_at=excluded.updated_at,is_favorite=excluded.is_favorite",
            params![asset.id, path, asset.file_name, asset.title, asset.artist, asset.album, asset.kind, asset.duration.max(0.0), asset.size.max(0), asset.format, asset.cover_path, asset.source_id, asset.source_start, asset.source_end, timestamp, asset.is_favorite as i64],
        ).map_err(|error| format!("导入旧音乐库失败：{error}"))?;
        imported += 1;
    }
    transaction.commit().map_err(|error| format!("提交旧音乐库导入失败：{error}"))?;
    Ok(imported)
}

pub fn setup(app: &mut tauri::App) -> Result<(), Box<dyn std::error::Error>> {
    let path = app.path().app_local_data_dir()?.join(DB_FILE_NAME);
    app.manage(DatabaseState::open(path).map_err(std::io::Error::other)?);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn track(id: &str, path: &str) -> TrackRecord {
        TrackRecord { id: id.to_string(), path: path.to_string(), file_name: format!("{id}.mp3"), title: id.to_string(), artist: "A".to_string(), album: "B".to_string(), kind: "source".to_string(), duration: 1.0, size: 10, format: "MP3".to_string(), cover_path: None, source_id: None, source_start: None, source_end: None, created_at: 1, updated_at: 1, is_favorite: false }
    }

    #[test]
    fn migration_is_idempotent_and_creates_all_tables() {
        let state = DatabaseState::in_memory();
        let connection = state.lock().unwrap();
        assert_eq!(connection.query_row("SELECT MAX(version) FROM schema_migrations", [], |row| row.get::<_, i64>(0)).unwrap(), 1);
        migrate(&connection).unwrap();
        assert!(connection.query_row("SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='playlists'", [], |row| row.get::<_, i64>(0)).unwrap() == 1);
    }

    #[test]
    fn playlist_order_and_cascade_delete_are_durable() {
        let state = DatabaseState::in_memory();
        let connection = state.lock().unwrap();
        let first = track("a", "C:/a.mp3");
        let second = track("b", "C:/b.mp3");
        connection.execute("INSERT INTO tracks(id,path,file_name,title,artist,album,kind,duration,size,format,created_at,updated_at) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,1,1)", params![first.id, first.path, first.file_name, first.title, first.artist, first.album, first.kind, first.duration, first.size, first.format]).unwrap();
        connection.execute("INSERT INTO tracks(id,path,file_name,title,artist,album,kind,duration,size,format,created_at,updated_at) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,1,1)", params![second.id, second.path, second.file_name, second.title, second.artist, second.album, second.kind, second.duration, second.size, second.format]).unwrap();
        connection.execute("INSERT INTO playlists(id,name,created_at,updated_at) VALUES('p','Favorites',1,1)", []).unwrap();
        connection.execute("INSERT INTO playlist_tracks(playlist_id,track_id,position) VALUES('p','a',0)", []).unwrap();
        connection.execute("INSERT INTO playlist_tracks(playlist_id,track_id,position) VALUES('p','b',1)", []).unwrap();
        let sql = format!("SELECT pt.playlist_id,pt.track_id,pt.position,{} FROM playlist_tracks pt JOIN tracks t ON t.id=pt.track_id WHERE pt.playlist_id=?1 ORDER BY pt.position", track_columns("t"));
        let mut statement = connection.prepare(&sql).unwrap();
        let rows = statement.query_map(params!["p"], |row| row_to_track_at(row, 3)).unwrap().collect::<Result<Vec<_>, _>>().unwrap();
        assert_eq!(rows.iter().map(|item| item.id.as_str()).collect::<Vec<_>>(), vec!["a", "b"]);
        connection.execute("DELETE FROM tracks WHERE id='a'", []).unwrap();
        assert_eq!(connection.query_row("SELECT COUNT(*) FROM playlist_tracks", [], |row| row.get::<_, i64>(0)).unwrap(), 1);
    }

    #[test]
    fn duplicate_path_is_rejected_by_schema() {
        let state = DatabaseState::in_memory();
        let connection = state.lock().unwrap();
        connection.execute("INSERT INTO tracks(id,path,file_name,title,artist,album,kind,duration,size,format,created_at,updated_at) VALUES('a','same','a','a','a','a','source',1,1,'MP3',1,1)", []).unwrap();
        assert!(connection.execute("INSERT INTO tracks(id,path,file_name,title,artist,album,kind,duration,size,format,created_at,updated_at) VALUES('b','same','b','b','b','b','source',1,1,'MP3',1,1)", []).is_err());
    }
}
