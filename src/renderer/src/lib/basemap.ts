/**
 * 离线底图：Natural Earth（公有领域）的国家 / 湖泊 / 主要城市，随应用打包，地图不发任何网络请求。
 * 数据由 scripts/build-basemap.mjs 生成在 assets/basemap/。
 *
 * 只到城市级精度（没有街道），对"照片拍在哪"足够；换来的是完全离线 —— 隐私承诺不再有例外。
 */
import type * as Leaflet from 'leaflet'

type Scheme = 'dark' | 'light'

const PALETTE: Record<Scheme, { ocean: string; land: string; border: string; label: string; halo: string }> = {
  light: { ocean: '#DCE5EA', land: '#F5F2EC', border: '#CFC7BA', label: '#5E584F', halo: '#F5F2EC' },
  dark: { ocean: '#11151B', land: '#22252C', border: '#3A3E47', label: '#A9A39A', halo: '#22252C' },
}

/** 每个缩放级别显示到哪一级城市（rank 越小越重要）；首都在国家级缩放时就显示 */
const rankForZoom = (z: number): number => (z <= 2 ? -1 : z <= 3 ? 1 : z <= 4 ? 2 : z <= 5 ? 3 : z <= 6 ? 4 : 99)

interface Place { name: string; rank: number; capital: boolean }

export interface OfflineBasemap {
  setScheme: (scheme: Scheme) => void
}

export async function addOfflineBasemap(L: typeof Leaflet, map: Leaflet.Map, scheme: Scheme): Promise<OfflineBasemap> {
  const [countries, lakes, places] = await Promise.all([
    import('../assets/basemap/countries.json'),
    import('../assets/basemap/lakes.json'),
    import('../assets/basemap/places.json'),
  ])
  // 多边形走 canvas（地图建时 preferCanvas: true）：几百个国家用 SVG 会拖慢缩放
  let colors = PALETTE[scheme]

  map.createPane('basemap-labels')
  const labelPane = map.getPane('basemap-labels')!
  labelPane.style.zIndex = '450' // 底图 canvas（overlayPane 400）之上、照片点位（markerPane 600）之下
  labelPane.style.pointerEvents = 'none'

  const land = L.geoJSON(countries.default as GeoJSON.FeatureCollection, {
    interactive: false,
    style: () => ({ fillColor: colors.land, fillOpacity: 1, color: colors.border, weight: 0.8 }),
  }).addTo(map)
  const water = L.geoJSON(lakes.default as GeoJSON.FeatureCollection, {
    interactive: false,
    style: () => ({ fillColor: colors.ocean, fillOpacity: 1, stroke: false }),
  }).addTo(map)

  const labelHtml = (p: Place): string => {
    const span = document.createElement('span')
    span.textContent = p.name
    span.style.cssText = `font-size:${p.capital ? 12 : 11}px;font-weight:${p.capital ? 600 : 400};color:${colors.label};` +
      `white-space:nowrap;text-shadow:0 0 3px ${colors.halo},0 0 3px ${colors.halo};transform:translate(-50%,-50%);display:inline-block`
    return span.outerHTML
  }
  const placeFeatures = (places.default as GeoJSON.FeatureCollection<GeoJSON.Point, Place>).features
  const labels = L.layerGroup().addTo(map)
  const drawLabels = (): void => {
    // 地图还没定位（fitBounds 在底图之后才调）时 getBounds 会抛错；定位后的 moveend 会再画
    if (!(map as unknown as { _loaded?: boolean })._loaded) return
    labels.clearLayers()
    const maxRank = rankForZoom(map.getZoom())
    const bounds = map.getBounds().pad(0.2)
    for (const f of placeFeatures) {
      const p = f.properties
      if (!(p.rank <= maxRank || (p.capital && map.getZoom() >= 3))) continue
      const [lng, lat] = f.geometry.coordinates
      if (!bounds.contains([lat, lng])) continue
      L.marker([lat, lng], {
        pane: 'basemap-labels', interactive: false, keyboard: false,
        icon: L.divIcon({ className: '', html: labelHtml(p), iconSize: [0, 0] }),
      }).addTo(labels)
    }
  }
  map.on('zoomend moveend', drawLabels)

  const paint = (): void => {
    map.getContainer().style.background = colors.ocean
    land.setStyle({ fillColor: colors.land, color: colors.border })
    water.setStyle({ fillColor: colors.ocean })
    drawLabels()
  }
  paint()

  return {
    setScheme: (s) => { colors = PALETTE[s]; paint() },
  }
}
