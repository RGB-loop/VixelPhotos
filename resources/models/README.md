# Vixel 本地模型

本目录在打包时通过 electron-builder 的 `extraResources` 落到生产包的 `Contents/Resources/models/`。

| 子目录 / 文件 | 用途 | 大小 | 获取方式 |
|---|---|---|---|
| `siglip2/` | 图文 CLIP（语义搜索） | ~190 MB | `npm run models:download siglip` |
| `paddleocr/` | OCR（图内文字搜索） | ~12 MB | `npm run models:download paddleocr` |
| `scrfd_2.5g_kps.onnx` | 人脸检测 | ~3 MB | 已随仓库 |
| `mobilefacenet.onnx` | 人脸 embedding（InsightFace w600k_mbf，512 维；权重仅限非商用） | ~13 MB | 已随仓库 |

## 首次准备

```bash
npm run models:download              # 全部
npm run models:download siglip       # 仅 SigLIP 2
npm run models:download paddleocr    # 仅 PaddleOCR
```

## 镜像与覆盖

如果 Hugging Face 在你那里访问慢，可以通过环境变量切换源：

```bash
SIGLIP_REPO=mirror-org/siglip2-base-patch16-256 npm run models:download siglip
PADDLEOCR_REPO=YourFork/RapidOCR npm run models:download paddleocr
```

## 完全离线分发

只要这些文件都到位，应用就完全不联网（除非用户在 Settings 显式切到外部
Embedding API 兜底模式）。OCR 是可选能力——`paddleocr/` 不存在时主流程不
受影响，只是图内文字搜索这一通道空跑。
