import { describe, it, expect } from 'vitest'
import { createFfmpegCommand, ffmpeg } from '../src/services/fluent-ffmpeg.js'

describe('Fluent-FFmpeg Service Adapter', () => {
  it('initializes ffmpeg command instance correctly', () => {
    expect(typeof ffmpeg).toBe('function')
    const cmd = createFfmpegCommand()
    expect(cmd).toBeDefined()
    expect(typeof cmd.format).toBe('function')
    expect(typeof cmd.audioCodec).toBe('function')
  })
})
