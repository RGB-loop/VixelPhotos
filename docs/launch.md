# 宣发准备清单

## 一句话

**Vixel：用一句话找到照片和视频里的那一刻。完全离线，不上传，不需要账号。**

三个支点（**主打本地和隐私，不宣传速度**）：

1. **真的离线，没有例外**：模型、地图底图都随应用分发；渲染进程的一切网络请求被代码强制拦截（`enforceOfflinePolicy`），`vixel doctor` 可自查。不需要账号，没有遥测。
2. **连视频里的字和人都能搜**：视频按全分辨率帧做 OCR 和人脸识别（招牌、白板、菜单上的字都能搜到）。
3. **不糊弄**：语义 + 图中文字 + 文件名四路融合；没有把握时直说，不硬凑一屏结果。

> 不要对外引用速度数字（搜索延迟、索引速度）。首次语义索引在 CPU 上约 3 秒 / 张，文案只说
> “导入后立刻可以浏览，语义索引在后台进行”。

## 演示脚本（录屏 / 现场）

在演示用的库上先跑一遍，挑稳定命中的查询（用 CLI 先验：`vixel search "<查询>" --json`）：

1. 自然语言：一个**物体**（“西瓜”）+ 一个**场景**（“清真寺”）+ 一个**动作**（“跳舞”）。
2. 图中文字：招牌 / 价签上的词（“微信支付”），结果卡片上会出现“图中文字”角标。
3. 说“没有”：搜一个库里确实没有的东西（“海边”），展示“没有明确匹配”提示。
4. 视频：悬停拖动预览、详情里时间轴高亮命中片段。
5. 人物：人物页 →“是同一个人吗？”→ 合并 → 命名。
6. 离线：断网后重复第 1 步。

### 素材怎么重做

演示库：`~/workspace/dancer/vixel-demo/library`（34 项，来自 [Immich test-assets](https://github.com/immich-app/test-assets)，公有领域），
索引数据在同目录的 `data/`。重新生成（先 `npm run build`）：

```bash
D=~/workspace/dancer/vixel-demo
# 宣传片：按脚本操作真实界面录屏（src/main/capture.ts 的 PROMO_SCENES），再合成片头 / 字幕 / 片尾
VIXEL_RECORD=$D/promo/raw.mp4 npx electron . --user-data-dir=$D/data
node scripts/make-promo.mjs $D/promo/raw.mp4 docs/media/vixel-promo.mp4
# 截图：浅色 / 深色各一套
VIXEL_CAPTURE=$D/shots VIXEL_CAPTURE_QUERIES="花,STARBUCKS,猫" npx electron . --user-data-dir=$D/data
```

宣传片目前没有配乐；需要的话在剪辑软件里加，或用 ffmpeg 混入一段有授权的音乐。

⚠️ 不要用个人照片库做公开素材（家人、路人的脸）。Immich 官方 demo 服务器上的 3 万张照片**没有声明许可**，也不要用。

## 发布前必须完成（阻塞项）

- [x] **签名 + 公证**：决定暂不加入 Developer Program，发布 ad-hoc 签名版本（`build/adhoc-sign.cjs`），release 说明里写清首次打开步骤。（2026-10-10 查过：当前 Apple 账号**未加入** Apple Developer Program，只是免费账号）。
      - 推荐：加入 Developer Program（个人约 ¥688 / 年，需 Apple 账号开启双重认证，审核一般 1–2 天），之后用
        Developer ID 证书签名，发布构建跑 `electron-builder --mac --c.mac.notarize=true`，配置 `APPLE_ID` / `APPLE_APP_SPECIFIC_PASSWORD` / `APPLE_TEAM_ID`。
      - 暂不加入：只能发未公证的版本。用户第一次打开会被拦截，需在「系统设置 → 隐私与安全性」里点“仍要打开”，
        或执行 `xattr -dr com.apple.quarantine /Applications/Vixel.app`。适合内测，不适合公开宣发。
- [ ] **模型随包**：确认 `resources/models` 下有 `gemma2/`、`paddleocr/ppocrv5_dict.txt`（v5 字典，不是 `ppocr_keys_v1.txt`）、人脸模型；DMG 体积约 700 MB，下载页注明。
- [x] **全新目录冒烟**：打包后的 app 用空数据目录启动、用演示库跑完截图巡检（搜索 / 图中文字 / 视频 / 地图 / 人物）均正常。真机全新用户仍建议再试一次。
- [x] **版本号**：v0.2.0 已发布（2026-10-10）：https://github.com/RGB-loop/Vixel/releases/tag/v0.2.0
- [x] **宣传片 / README 配图**：已用演示库按真实界面重做（2026-10-10）。README 里内嵌播放的视频需要把新的 mp4 拖进 GitHub 网页编辑器生成附件链接。

## 发布后一周盯什么

- 首次索引卡在哪一步、多久（任务面板 / `vixel doctor`）。
- “没有明确匹配”出现的频率：太高说明门槛 2.5σ 偏严（`RELEVANCE_MIN_Z`）。
- 人脸：非人脸（雕像、画像）被识别成人物的反馈 —— 目前靠用户“隐藏”。

## 已知局限（FAQ 里写清楚）

- 只在 macOS（Apple Silicon）充分测试；Windows / Linux 可构建，RAW 用相机内嵌预览（分辨率以相机写入的预览为准）。
- 长视频只用首帧识别人脸（多帧采样待做）。
- 没有相册 / 收藏 / 编辑：Vixel 是“找”的工具，不替代照片管理软件。
