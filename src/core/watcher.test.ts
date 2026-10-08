import { describe, it, expect } from 'vitest'
import { classifyMedia } from './watcher'

describe('classifyMedia', () => {
  it('图片 / 视频 / 音频按扩展名分类，大小写不敏感', () => {
    expect(classifyMedia('/a/IMG_0001.HEIC')).toBe('image')
    expect(classifyMedia('/a/DJI_0127_D.MP4')).toBe('video')
    expect(classifyMedia('/a/clip.mov')).toBe('video')
    for (const ext of ['mp3', 'm4a', 'aac', 'wav', 'flac', 'ogg', 'opus', 'MP3']) {
      expect(classifyMedia(`/a/song.${ext}`)).toBe('audio')
    }
  })

  it('其他文件忽略', () => {
    expect(classifyMedia('/a/notes.txt')).toBeNull()
    expect(classifyMedia('/a/.DS_Store')).toBeNull()
    expect(classifyMedia('/a/noext')).toBeNull()
  })
})
