# RinkoSound

RinkoSound 是一款 Windows 本地音乐管理、播放、歌单和音频片段截取软件。前端使用 React 19 + TypeScript + Vite，桌面端使用 Tauri 2；媒体处理使用参数数组调用 FFmpeg/FFprobe sidecar。

## 开发与运行

```powershell
npm install
npm run dev                 # 浏览器开发模式，使用 localStorage + Web Audio fallback
npm run typecheck
npm test
npm run build
```

构建 Windows 安装包：

```powershell
cmd /v:on /d /s /c "call D:\VSBuildTools\Common7\Tools\VsDevCmd.bat -arch=x64 >nul && set PATH=C:\Users\chisruk\.cargo\bin;!PATH! && npm exec tauri -- build"
```

安装包路径：`src-tauri/target/release/bundle/nsis/RinkoSound_0.1.0_x64-setup.exe`

## 功能

- 音乐库：全部歌曲、最近添加、收藏、搜索、排序、筛选、重复路径/元数据检测、标签编辑、封面、删除或移除。
- 歌单：创建、重命名、删除、播放歌单、添加/移除歌曲、拖拽排序；删除歌单不会删除本地音频。
- 播放器：播放/暂停、上一首/下一首、进度跳转、音量和静音、顺序/循环全部/单曲循环/随机模式、随机短期去重、播放队列和重启恢复。
- 播放队列：歌单播放会创建独立的临时队列，支持来源显示、当前/下一首、立即播放、下一首播放、追加、移除、清空和拖拽排序；队列顺序不会改写歌单顺序。

播放全部会按歌单顺序重建队列并立即播放第一首；随机播放会生成一次性打乱队列并在本轮内避免重复。播放器使用单个 HTMLAudioElement 适配器，等待 `loadedmetadata/canplay` 后再调用 `play()`，并在 `ended` 时通过播放状态机切换下一首。
- 快捷键：空格播放/暂停，左右方向键快进/后退，N 下一首，P 上一首；输入框获得焦点时不会拦截快捷键。
- 导入和截取：保留本地视频/音频导入、波形范围、试听、取消、重试提示和二次剪辑；原生桌面版输出 MP3/WAV/M4A。
- 录音：使用 Windows WebView 的共享音频能力，选择共享窗口时勾选“共享音频”。录音只保留音频轨，停止后先等待 MediaRecorder 最后一个数据块；Tauri 原生版先用 FFprobe 确认音频轨，再由 FFmpeg 转码为 MP3，即使浏览器 WebM 缺少 duration 也会在转换时重建时长，最后再验证真实时长和播放器加载。验证失败的空文件、视频-only WebM 或 00:00 文件不会进入音乐库。详情抽屉对旧的 00:00 录音提供“重新检测/转换录音”。浏览器开发模式没有 FFmpeg 时只接受可被 HTMLAudioElement 解析出有效时长的录音。

## 页面结构与日常操作

应用壳由左侧导航、中央页面、右侧按需详情抽屉和底部固定播放器组成。音乐库只查询全部歌曲；最近添加按导入时间倒序显示全部新旧条目；收藏只查询已收藏歌曲；截取工具是独立的四步流程（选择文件、试听并设置范围、填写输出信息、保存后的播放/加入歌单操作）；设置只显示播放器、截取默认值、数据和快捷键设置。

设置中的默认输出格式、音质、主题和保存目录会持久化到本地偏好；Windows 原生版可以选择截取片段和录音的输出文件夹，临时文件会放在所选目录的 `.tmp` 子目录中并在失败或取消后清理。导入的原文件仍保留原路径，旧音乐库文件不会因更改目录而迁移。

我的歌单先显示歌单索引，点击歌单进入独立详情页。详情页显示封面、歌曲数、总时长、播放全部/随机播放、重命名、删除和可拖拽排序的歌曲列表；删除歌单只删除关系，不删除本地音频文件。

“加入歌单”使用统一弹窗：音乐库歌曲行悬停时的“+歌单”、批量选择工具栏、歌曲详情抽屉、播放器当前歌曲和截取成功操作都会打开同一个弹窗。弹窗支持搜索歌单、新建歌单，并对已经存在的歌曲显示“已添加”状态。歌曲行还可以直接加入播放队列或收藏。

点击歌曲行打开右侧详情抽屉，可编辑标题、艺术家、专辑、封面、收藏状态、播放队列和歌单；双击歌曲开始播放。播放器队列可以查看、清空、移除和拖拽排序，页面间切换不会再显示重复的音乐库卡片。

## 数据存储与迁移

Windows 原生版使用 SQLite：

`%LOCALAPPDATA%\com.soundforge.local\soundforge.db`

数据库包含 `tracks`、`playlists`、`playlist_tracks`、`queue_items`、`app_state`、`schema_migrations` 表，启动时执行版本化迁移。截取后的真实文件保存在同目录的 `music` 子目录，任务临时文件保存在 `music\.tmp`，失败或取消后清理。旧版 `soundforge-library-v1` localStorage 元数据会在首次启动时导入；没有真实本地路径的浏览器临时 Blob 不会写入 SQLite。

浏览器开发模式使用 `soundforge-library-v2` localStorage 作为 fallback。桌面版以 SQLite 为持久化来源，同时保留 localStorage 作为迁移输入。

## 安全边界

所有 FFmpeg/FFprobe 参数以 argv 数组传递，不拼接 shell 命令。软件只处理用户选择的本地文件，不抓取视频网站页面、不使用浏览器 Cookie、不绕过 DRM、登录限制、验证码、付费墙或防盗链，也不上传文件和启用遥测。

## 验证

```powershell
npm run typecheck
npm test
npm run build
cargo check --manifest-path src-tauri/Cargo.toml
cargo test --manifest-path src-tauri/Cargo.toml
```

当前录音依赖系统共享音频面板；完全无交互的 WASAPI loopback 仍是后续增强项。

## 开源构建

Windows 安装包已经内置 FFmpeg 和 FFprobe sidecar；源码仓库不提交这两个超过 GitHub 单文件限制的二进制文件。要从源码构建原生版，请将与你的平台匹配、具备合法再分发许可的 `ffmpeg` 和 `ffprobe` 放入 `src-tauri/binaries/`，文件名使用 Tauri 配置要求的 sidecar 名称。开发依赖安装完成后，可使用 `npm run typecheck`、`npm test`、`npm run build` 和 `cargo check --manifest-path src-tauri/Cargo.toml` 验证项目；Windows 安装包使用 `npm exec tauri -- build` 生成。用户自己的音乐、视频、录音、数据库和构建目录不会提交到仓库。
