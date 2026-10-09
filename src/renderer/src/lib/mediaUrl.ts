import type { Photo } from '../../../shared/types'

/**
 * vixel://thumb 和 vixel://sprite 响应带 Cache-Control: immutable；
 * 原位编辑后 photo id 不变但内容（fileHash）会变，URL 必须带 ?v= 破缓存。
 * 人脸裁剪的 faceId 不复用，vixel://face 无需缓存参数。
 */
export function thumbUrl(photo: Pick<Photo, 'id' | 'fileHash'>): string {
  return `vixel://thumb/${photo.id}?v=${photo.fileHash}`
}

export function spriteUrl(videoId: number, fileHash: string): string {
  return `vixel://sprite/${videoId}?v=${fileHash}`
}

export function faceUrl(faceId: number): string {
  return `vixel://face/${faceId}`
}
