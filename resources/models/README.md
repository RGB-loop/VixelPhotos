# Vixel 本地模型

本目录在打包时通过 electron-builder 的 `extraResources` 落到生产包的 `Contents/Resources/models/`。

| 子目录 / 文件 | 用途 | 大小 | 获取方式 |
|---|---|---|---|
| `siglip2/` | 图文 CLIP（语义搜索） | ~190 MB | `node scripts/download-models.mjs` |
| `scrfd_2.5g_kps.onnx` | 人脸检测 | ~3 MB | 已随仓库 |
| `mobilefacenet.onnx` | 人脸 embedding | ~5 MB | 已随仓库 |

## 首次准备

```bash
node scripts/download-models.mjs
```

会从 `onnx-community/siglip2-base-patch16-256` 拉取 SigLIP 2 的 ONNX 权重与
tokenizer / preprocessor 配置文件到 `siglip2/`。可通过环境变量切换：

```bash
SIGLIP_REPO=Xenova/siglip-base-patch16-256-multilingual node scripts/download-models.mjs
```

## 完全离线分发

只要 `siglip2/` 下的文件都到位，应用就完全不联网（除非用户在 Settings 显式
切到外部 Embedding API 兜底模式）。
