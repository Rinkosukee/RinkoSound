export const clamp = (value: number, min: number, max: number) => Math.min(Math.max(value, min), max)

export function parseTime(value: string): number {
  const parts = value.trim().split(':').map(Number)
  if (parts.some((part) => !Number.isFinite(part) || part < 0)) return Number.NaN
  if (parts.length === 1) return parts[0]
  if (parts.length === 2) return parts[0] * 60 + parts[1]
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2]
  return Number.NaN
}

export function formatTime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return '00:00'
  const whole = Math.floor(seconds)
  const hours = Math.floor(whole / 3600)
  const minutes = Math.floor((whole % 3600) / 60)
  const secs = whole % 60
  return hours > 0
    ? `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(secs).padStart(2, '0')}`
    : `${String(minutes).padStart(2, '0')}:${String(secs).padStart(2, '0')}`
}

export function validateRange(start: number, end: number, duration: number): string | null {
  if (!Number.isFinite(duration) || duration <= 0) return '无法读取音频时长'
  if (!Number.isFinite(start) || !Number.isFinite(end)) return '请输入有效的开始和结束时间'
  if (start < 0 || end > duration) return `时间必须在 00:00 和 ${formatTime(duration)} 之间`
  if (end <= start) return '结束时间必须晚于开始时间'
  if (end - start < 0.25) return '片段至少需要 0.25 秒'
  return null
}
