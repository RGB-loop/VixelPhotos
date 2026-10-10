/**
 * 离线底图数据：Natural Earth（公有领域）→ 精简 GeoJSON，打进渲染端，地图不再请求任何在线瓦片。
 *
 *   node scripts/build-basemap.mjs <natural-earth geojson 目录>
 *
 * 需要 ne_50m_admin_0_countries / ne_50m_lakes / ne_10m_populated_places_simple 三个 .geojson
 * （github.com/nvkelso/natural-earth-vector/tree/master/geojson）。
 * 坐标保留 3 位小数（约 100 m），只留渲染用的属性。
 */
import { readFileSync, writeFileSync, mkdirSync } from 'fs'
import { join } from 'path'

const src = process.argv[2]
if (!src) { console.error('usage: node scripts/build-basemap.mjs <dir>'); process.exit(1) }
const out = 'src/renderer/src/assets/basemap'
mkdirSync(out, { recursive: true })

const round = (c) => (typeof c[0] === 'number' ? [Math.round(c[0] * 1000) / 1000, Math.round(c[1] * 1000) / 1000] : c.map(round))
// 相邻重复点去掉（取整后常出现）
const dedupe = (ring) => ring.filter((p, i) => i === 0 || p[0] !== ring[i - 1][0] || p[1] !== ring[i - 1][1])
const geom = (g) => {
  const c = round(g.coordinates)
  if (g.type === 'Polygon') return { type: g.type, coordinates: c.map(dedupe) }
  if (g.type === 'MultiPolygon') return { type: g.type, coordinates: c.map((poly) => poly.map(dedupe)) }
  return { type: g.type, coordinates: c }
}
const read = (f) => JSON.parse(readFileSync(join(src, `${f}.geojson`), 'utf8'))
const write = (name, features) => {
  const json = JSON.stringify({ type: 'FeatureCollection', features })
  writeFileSync(join(out, `${name}.json`), json)
  console.log(`${name}.json  ${features.length} features  ${(json.length / 1024).toFixed(0)} KB`)
}

write('countries', read('ne_50m_admin_0_countries').features.map((f) => ({
  type: 'Feature', properties: { name: f.properties.NAME_ZH || f.properties.NAME }, geometry: geom(f.geometry),
})))
write('lakes', read('ne_50m_lakes').features.map((f) => ({ type: 'Feature', properties: {}, geometry: geom(f.geometry) })))
// 城市：按等级分层显示（scalerank 越小越重要），只留人口较多或首都
write('places', read('ne_10m_populated_places_simple').features
  .filter((f) => f.properties.scalerank <= 4 || f.properties.pop_max >= 2_000_000 || f.properties.featurecla === 'Admin-0 capital')
  .map((f) => ({
    type: 'Feature',
    // 城市名用英文：Natural Earth 的中文名不可靠（旧金山写成"聖弗朗西斯科"）
    properties: { name: f.properties.name, rank: f.properties.scalerank, capital: f.properties.featurecla === 'Admin-0 capital' },
    geometry: geom(f.geometry),
  })))
