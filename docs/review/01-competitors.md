# 竞品研究（2026-10）

## 1. 对比表

| 产品 | 语义搜索 | OCR | 人脸 | 视频时刻 | 音频搜索 | 地图 | 去重 | 离线/隐私 | 平台 | 定价 | 库管理/编辑 | 相册/分享 |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| **Vixel** | ✅ 多语言，4 路 RRF | ✅ PaddleOCR 中英 | ✅ 聚类+命名 | ✅ 32s 段+跳转 | ✅ 独立音频向量 | ✅ | ✅ 哈希级 | ✅✅ 零网络 | macOS（主） | 免费开源 | ❌ 只读 | ❌ |
| Immich | ✅ CLIP/SigLIP2 多语言 | ✅ | ✅ +人脸过滤 | ❌ 仅缩略帧 | ❌ | ✅ | ✅ 相似去重 | ✅ 自托管 | Docker+移动端 | 免费开源 | 部分 | ✅ |
| PhotoPrism | ⚡ 标签为主 | ⚡ | ✅ | ❌ | ❌ | ✅ | ✅ | ✅ 自托管 | Docker | 免费+订阅 | 元数据编辑 | ✅ |
| Ente | ✅ 端侧 Magic Search | ❌ | ✅ | ❌ | ❌ | ✅ | ✅ | ✅ E2EE 云 | 全平台 | 按存储付费 | 基础 | ✅ |
| Apple Photos | ✅ 自然语言（含视频时刻） | ✅ Live Text | ✅ | ✅ | ❌ | ✅ | ✅ | ✅ 端侧 | Apple 生态 | 免费 | ✅ | ✅ |
| Google Photos | ✅ Ask Photos（2026/3 加回经典搜索开关） | ✅ | ✅ | ⚡ | ❌ | ✅ | ✅ | ❌ 云端 | 全平台 | 免费 15GB 起 | ✅ | ✅✅ |
| Mylio Photos | ⚡ 本地标签 | ✅ | ✅ | ❌ | ❌ | ✅ | ✅ | ✅ 本地+P2P | 全平台 | $99/年 | ✅ | ✅ |
| Excire Foto 2027 | ✅ 本地自由文本 | ✅ | ✅ | ❌ | ❌ | ✅ | ✅ 强 | ✅ | Win/Mac | $249 买断 | ✅ | ⚡ |
| Peakto | ✅ +美学评分 | ⚡ | ✅ | ✅ 对白搜索 | ⚡ 对白 | ✅ | ⚡ | ✅ | macOS | 订阅 | ✅ | ✅ |
| digiKam | ⚡ 自动标签 | ❌ | ✅ | ❌ | ❌ | ✅ | ✅ | ✅ | 全桌面 | 免费开源 | ✅✅ | ⚡ |
| Synology Deep Search | ✅（2026/7） | ⚡ | ✅ | ❌ | ❌ | ✅ | ⚡ | ✅ NAS | NAS | 随硬件 | ⚡ | ✅ |
| Lightroom | ✅ 仅云端 | ❌ | ✅ | ❌ | ❌ | ✅ | ⚡ | ❌ | 全平台 | 订阅 | ✅✅ | ✅ |
| rclip / Queryable / SCM | ✅ CLIP | SCM 有 | ❌ | SCM 有 | SCM 有 | ❌ | ❌ | ✅ | CLI/iOS/mac | 免费/低价 | ❌ | ❌ |

## 2. 差异化与差距

**差异化**
- 音频 + 视频片段进同一向量空间并带时间码跳转：主流产品几乎没有“听到的也能搜”。
- 零部署桌面全本地：Immich/PhotoPrism 需服务器，Ente 依赖云。
- 中文优先：PaddleOCR + jieba + 多语言 embedding。
- 面向 Agent 的 CLI（`--json`）。

**明显落后（table stakes）**
1. 无相册 / 收藏 / 评分。
2. 无时间线视图 / 回忆。
3. 搜索无结构化过滤（语义 × 人物 × 日期 × 地点）。
4. 无地名搜索（离线反向地理编码）。
5. 仅 macOS 成熟，无移动端。
6. 去重仅精确哈希，无视觉近重复清理。
7. 无编辑 / 导出 / 分享（可接受，但应明确“只读搜索层”定位）。

## 3. 建议（按优先级）

**Quick wins**
1. 搜索过滤 chips（人物 / 日期 / 地点 / 类型 / 文件夹）+ 查询中时间词解析。
2. 离线反向地理编码（GeoNames 级），让“大理”“东京”可搜。
3. 结果可解释性：标注命中通道（OCR 命中词高亮 / 画面相似度 / 文件名）。竞品普遍黑盒，这是差异化机会。
4. 零输入发现页：聚焦搜索框时展示人物、地点、最近搜索、示例查询；空结果给改写建议。

**中等投入**
5. 时间线视图 + 年/月 scrubber + “X 年前的今天”。
6. 轻量组织层：收藏 / 虚拟相册 / 评分；用现有向量做视觉近重复审查 UI。

**战略级**
7. Windows 完整支持（含 RAW）——免费零部署本地语义搜索在 Windows 上是空白。
8. CLI 升级为 MCP Server，成为“照片库的 Agent 接口”。

**警示**：Google Ask Photos 因 AI 搜索“更慢更不准”被迫加回经典搜索开关。应保留精确模式（纯 FTS / 文件名），并把几十 ms 的延迟作为卖点。

## 来源
- Immich: https://docs.immich.app/features/searching/ · https://immich.app/blog/2026-july-recap
- Google Ask Photos: https://techcrunch.com/2026/03/10/google-gives-in-to-users-complaints-over-ai-powered-ask-photos-search-feature/
- Apple Photos: https://support.apple.com/en-in/guide/iphone/iphf7de217f0/ios
- Ente: https://alternativeto.net/news/2026/9/ente-photos-introduces-encrypted-library-sharing-and-faster-on-device-machine-learning/
- Excire/Peakto: https://www.photoworkout.com/best-ai-photo-organizer/ · https://excire.com/en/peakto-alternative/
- Mylio: https://mylio.com/features/ai-photo-search/
- digiKam: https://www.digikam.org/news/2025-10-19-8.8.0_release_announcement/
- Synology: https://www.synology.com/en-uk/company/news/article/synologydeepsearch
- Lightroom: https://helpx.adobe.com/ca/lightroom-cc/web/create-albums-and-organize-photos/add-and-organize-photos/semantic-search.html
- rclip / Queryable / SCM: https://github.com/yurijmikhalevich/rclip · https://queryable.app/offline-ai-photo-search
