import { useEffect, useState, useRef, useCallback } from 'react'
import type { Photo } from '../../../shared/types'
import { useColorScheme } from '../lib/theme'
import { thumbUrl } from '../lib/mediaUrl'

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
          // 大量点位分帧入组，不卡首屏
          chunkedLoading: true,
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

        // popup 内容用 DOM 构建（fileName 是用户数据，textContent 防注入）；
        // 缩略图直接走 vixel://thumb 协议，不再经 base64 IPC
        const makePopupEl = (photo: Photo): HTMLElement => {
          const root = document.createElement('div')
          root.style.cssText = 'cursor:pointer;width:180px;'
          const img = document.createElement('img')
          img.src = thumbUrl(photo)
          img.decoding = 'async'
          img.style.cssText = 'width:180px;border-radius:6px;object-fit:cover;'
          root.appendChild(img)
          const name = document.createElement('div')
          name.style.cssText = 'font-size:11px;color:var(--ink);margin-top:6px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;'
          name.textContent = photo.fileName
          root.appendChild(name)
          if (photo.takenAt) {
            const date = document.createElement('div')
            date.style.cssText = 'font-size:10px;color:var(--ink-3);margin-top:2px;'
            date.textContent = new Date(photo.takenAt).toLocaleDateString('zh-CN', { year: 'numeric', month: 'long', day: 'numeric' })
            root.appendChild(date)
          }
          const hint = document.createElement('div')
          hint.style.cssText = 'font-size:10px;color:rgb(var(--accent));margin-top:4px;'
          hint.textContent = '点击查看详情 →'
          root.appendChild(hint)
          root.onclick = (e) => {
            e.stopPropagation()
            map.closePopup()
            onSelectRef.current(photo)
          }
          return root
        }

        const markers: ReturnType<typeof L.marker>[] = []
        for (const photo of gpsPhotos) {
          if (photo.lat == null || photo.lng == null) continue

          const marker = L.marker([photo.lat, photo.lng], { icon: photoIcon })

          // 内容函数在 popup 打开时才构建 DOM，两万个点也不会预先建节点
          marker.bindPopup(() => makePopupEl(photo), {
            className: 'dark-popup',
            closeButton: false,
            offset: L.point(0, -4),
          })

          markers.push(marker)
        }
        // 一次性入组（配合 chunkedLoading 分帧），比逐个 addLayer 快一个量级
        clusterGroup.addLayers(markers)

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
          <p className="text-ink-3 text-callout mt-1">{error}</p>
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
          <p className="text-ink-3 text-callout mt-1">手机拍摄的图片和视频通常包含 GPS 数据</p>
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
