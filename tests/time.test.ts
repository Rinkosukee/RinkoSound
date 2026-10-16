import { describe, expect, it } from 'vitest'
import { formatTime, parseTime, validateRange } from '../src/lib/time'

describe('time helpers', () => {
  it('parses common time formats', () => {
    expect(parseTime('12.5')).toBe(12.5)
    expect(parseTime('01:12')).toBe(72)
    expect(parseTime('01:02:03')).toBe(3723)
  })

  it('formats durations for compact UI', () => {
    expect(formatTime(0)).toBe('00:00')
    expect(formatTime(72.2)).toBe('01:12')
    expect(formatTime(3723)).toBe('01:02:03')
  })

  it('rejects invalid clip ranges', () => {
    expect(validateRange(0, 2, 10)).toBeNull()
    expect(validateRange(3, 2, 10)).toContain('结束时间')
    expect(validateRange(-1, 2, 10)).toContain('必须在')
    expect(validateRange(0, 0.1, 10)).toContain('0.25')
  })
})
