import { describe, expect, it } from 'vitest'
import { buildFfmpegArgs } from '../src/lib/ffmpeg'
import { extensionOf, isSupportedFile } from '../src/lib/media'

describe('media validation and native argv adapter', () => {
  it('validates extensions case-insensitively', () => {
    expect(extensionOf('Track.MP3')).toBe('mp3')
    expect(isSupportedFile(new File(['x'], 'video.MKV', { type: 'video/x-matroska' }))).toBe(true)
    expect(isSupportedFile(new File(['x'], 'notes.txt'))).toBe(false)
  })

  it('returns safe argv without shell interpolation', () => {
    const args = buildFfmpegArgs('C:\\Music\\a & b.mp3', 'C:\\Music\\clip.mp3', { start: 2, end: 8.5, format: 'mp3', quality: 'high' })
    expect(args).toEqual(expect.arrayContaining(['-ss', '2.000', '-t', '6.500', '-c:a', 'libmp3lame']))
    expect(args.join(' ')).not.toContain('&&')
    expect(() => buildFfmpegArgs('in', 'out', { start: 4, end: 4, format: 'wav', quality: 'lossless' })).toThrow('invalid clip range')
    expect(() => buildFfmpegArgs('same', 'same', { start: 0, end: 1, format: 'wav', quality: 'lossless' })).toThrow('invalid media paths')
  })
})
