import { useEffect, useState, useRef, useCallback } from 'react'
import type { Photo } from '../../../shared/types'
import { useColorScheme } from '../lib/theme'

const tileUrl = (scheme: 'dark' | 'light'): string =>
  `https://{s}.basemaps.cartocdn.com/${scheme === 'dark' ? 'dark_all' : 'light_all'}/{z}/{x}/{y}{r}.png`

// 模块级别缓存 Leaflet，确保 markercluster 扩展不丢失
let cachedL: typeof import('leaflet') | null = null
async function getLeaflet() {
  if (cachedL) return cachedL
  const L = await import('leaflet')
  await import('leaflet/dist/leaflet.css')
  ;(window as unknown as Record<string, unknown>).L = L
  await import('leaflet.markercluster/dist/leaflet.markercluster.js')
  await import('leaflet.markercluster/dist/MarkerCluster.css')
  await import('leaflet.markercluster/dist/MarkerCluster.Default.css')
  cachedL = L
  return L
}

interface MapViewProps {
  onSelect: (photo: Photo) => void
}

export function MapView({ onSelect }: MapViewProps): JSX.Element {
  const [gpsPhotos, setGpsPhotos] = useState<Photo[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string>('')
  const mapContainerRef = useRef<HTMLDivElement>(null)
  const mapInstanceRef = useRef<unknown>(null)
  const onSelectRef = useRef(onSelect)
  onSelectRef.current = onSelect
  const scheme = useColorScheme()
  const schemeRef = useRef(scheme)
  schemeRef.current = scheme
  const tileLayerRef = useRef<{ setUrl: (url: string) => unknown } | null>(null)

  // 外观切换时只换瓦片源，不重建地图
  useEffect(() => { tileLayerRef.current?.setUrl(tileUrl(scheme)) }, [scheme])

  useEffect(() => {
    window.api.getPhotosWithGPS().then((photos) => {
      setGpsPhotos(photos)
      setLoading(false)
    }).catch((e) => {
      setError(String(e))
      setLoading(false)
    })
  }, [])

  useEffect(() => {
    if (loading || gpsPhotos.length === 0 || !mapContainerRef.current) return
    if (mapInstanceRef.current) return

    let cancelled = false
    const thumbCache = new Map<number, string>()

    const initMap = async () => {
      try {
        const L = await getLeaflet()
        if (cancelled || !mapContainerRef.current) return

        const map = L.map(mapContainerRef.current, {
          zoomControl: false,
          attributionControl: false,
        })

        tileLayerRef.current = L.tileLayer(tileUrl(schemeRef.current), {
          maxZoom: 19,
        }).addTo(map)

        const clusterGroup = L.markerClusterGroup({
          showCoverageOnHover: false,
          maxClusterRadius: 60,
          spiderfyOnMaxZoom: true,
          iconCreateFunction: (cluster) => {
            const count = cluster.getChildCount()
            const size = count < 10 ? 36 : count < 50 ? 44 : count < 200 ? 52 : 60
            return L.divIcon({
              html: `<div style="
                width:${size}px;height:${size}px;
                display:flex;align-items:center;justify-content:center;
                border-radius:50%;
                background:rgb(var(--accent) / 0.9);
                color:#fff;font-size:${size < 44 ? 12 : 14}px;font-weight:600;
                box-shadow:0 2px 8px rgba(0,0,0,0.4);
                border:2px solid rgba(255,255,255,0.2);
                cursor:pointer;
              ">${count}</div>`,
              className: '',
              iconSize: L.point(size, size),
            })
          },
        })

        const photoIcon = L.divIcon({
          html: `<div style="
            width:12px;height:12px;
            border-radius:50%;
            background:rgb(var(--accent));
            border:2px solid rgba(255,255,255,0.4);
            box-shadow:0 1px 4px rgba(0,0,0,0.5);
            cursor:pointer;
          "></div>`,
          className: '',
          iconSize: L.point(12, 12),
          iconAnchor: L.point(6, 6),
        })

        // 构建 popup HTML
        const makePopupHtml = (photo: Photo, thumbSrc?: string) => {
          const dateStr = photo.takenAt
            ? new Date(photo.takenAt).toLocaleDateString('zh-CN', { year: 'numeric', month: 'long', day: 'numeric' })
            : ''
          const thumbHtml = thumbSrc
            ? `<img src="${thumbSrc}" style="width:180px;border-radius:6px;object-fit:cover;" />`
            : '<div style="width:180px;height:120px;background:var(--surface-2);border-radius:6px;display:flex;align-items:center;justify-content:center;color:var(--ink-4);font-size:11px;">加载中...</div>'
          return `
            <div style="cursor:pointer;width:180px;">
              <div class="popup-thumb-${photo.id}">${thumbHtml}</div>
              <div style="font-size:11px;color:var(--ink);margin-top:6px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${photo.fileName}</div>
              ${dateStr ? `<div style="font-size:10px;color:var(--ink-3);margin-top:2px;">${dateStr}</div>` : ''}
              <div style="font-size:10px;color:rgb(var(--accent));margin-top:4px;">点击查看详情 →</div>
            </div>`
        }

        // photoId → photo 映射
        const photoMap = new Map<number, Photo>()

        for (const photo of gpsPhotos) {
          if (photo.lat == null || photo.lng == null) continue
          photoMap.set(photo.id, photo)

          const marker = L.marker([photo.lat, photo.lng], { icon: photoIcon })

          // 一次性绑定 popup（不在 click 里重复 bind）
          const popup = L.popup({
            className: 'dark-popup',
            closeButton: false,
            offset: L.point(0, -4),
          }).setContent(makePopupHtml(photo, thumbCache.get(photo.id)))

          marker.bindPopup(popup)

          // popup 打开时按需加载缩略图 + 绑定点击
          marker.on('popupopen', async () => {
            // 绑定点击事件
            const popupEl = popup.getElement()
            if (popupEl) {
              popupEl.style.cursor = 'pointer'
              popupEl.onclick = (e) => {
                e.stopPropagation()
                map.closePopup()
                onSelectRef.current(photo)
              }
            }

            // 按需加载缩略图
            if (!thumbCache.has(photo.id)) {
              const thumb = await window.api.getThumbnailData(photo.id)
              if (thumb) {
                thumbCache.set(photo.id, thumb)
                popup.setContent(makePopupHtml(photo, thumb))
              }
            }
          })

          clusterGroup.addLayer(marker)
        }

        map.addLayer(clusterGroup)

        const bounds = clusterGroup.getBounds()
        if (bounds.isValid()) {
          map.fitBounds(bounds, { padding: [50, 50], maxZoom: 14 })
        }

        mapInstanceRef.current = map
      } catch (e) {
        console.error('Map init failed:', e)
        setError(String(e))
      }
    }

    initMap()

    return () => {
      cancelled = true
      if (mapInstanceRef.current) {
        (mapInstanceRef.current as { remove: () => void }).remove()
        mapInstanceRef.current = null
      }
    }
  }, [loading, gpsPhotos])

  if (loading) {
    return (
      <div className="h-full flex items-center justify-center bg-canvas">
        <p className="text-ink-3 text-callout">加载中...</p>
      </div>
    )
  }

  if (error) {
    return (
      <div className="h-full flex items-center justify-center bg-canvas">
        <div className="text-center">
          <p className="text-bad/60 text-body">地图加载失败</p>
          <p className="text-ink-4 text-callout mt-1">{error}</p>
        </div>
      </div>
    )
  }

  if (gpsPhotos.length === 0) {
    return (
      <div className="h-full flex items-center justify-center bg-canvas">
        <div className="text-center">
          <svg className="w-12 h-12 mx-auto mb-3 text-ink-ghost" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M17.657 16.657L13.414 20.9a1.998 1.998 0 01-2.827 0l-4.244-4.243a8 8 0 1111.314 0z" />
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M15 11a3 3 0 11-6 0 3 3 0 016 0z" />
          </svg>
          <p className="text-ink-3 text-body">暂无带位置信息的内容</p>
          <p className="text-ink-4 text-callout mt-1">手机拍摄的图片和视频通常包含 GPS 数据</p>
        </div>
      </div>
    )
  }

  return (
    <div className="h-full relative">
      <div ref={mapContainerRef} className="h-full w-full" style={{ background: 'var(--surface-1)' }} />
      <div className="absolute bottom-3 left-3 px-2 py-1 rounded bg-raised border border-line text-micro text-ink-2 pointer-events-none">
        {gpsPhotos.length} 项有位置信息
      </div>
    </div>
  )
}
