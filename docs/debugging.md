# 调试与性能诊断

## 一键体检 / 基准（不开界面）

```bash
npm run build:cli
ELECTRON_RUN_AS_NODE=1 npx electron dist/cli/cli/index.js doctor     # 库体检
ELECTRON_RUN_AS_NODE=1 npx electron dist/cli/cli/index.js bench      # 热点操作计时
ELECTRON_RUN_AS_NODE=1 npx electron dist/cli/cli/index.js bench --runs 10 --query "海边,发票" --json
```

（better-sqlite3 按 Electron ABI 编译，所以用 Electron 充当 Node 运行。）

- **doctor**：PRAGMA、各表行数、队列积压、失败原因 Top 10、一致性检查（有照片无向量 / 孤立向量 / 无片段的视频）、热点查询的执行计划（库 ≥ 5000 张时，全表扫描或临时排序会标 `!`）。
- **bench**：网格首页 / 深翻页、库计数、进度统计、人物列表、GPS 列表、各查询冷/热搜索、向量 KNN；中位数 > 100 ms 标 `← slow`。
- 两者都**只读**打开数据库，应用运行中也可以跑。
- 环境变量：`VIXEL_DATA_DIR`（库目录）、`VIXEL_MODELS_DIR`（模型目录，用于语义搜索）。

## 运行时剖析：`VIXEL_PROFILE=1`

```bash
VIXEL_PROFILE=1 npm run dev
```

超过阈值的操作会打印：

```
[perf] sql   getRepresentativePhotos   38.2ms     # 语句 > 8ms
[perf] ipc   search                     182.4ms    # IPC handler > 16ms（主进程掉帧）
[perf] proto vixel://                   61.0ms     # 协议请求 > 50ms
[perf] infer embed.encode               3349.0ms   # 推理（含排队）> 2s
[perf] loop  main blocked (embed a.jpg)  412.0ms   # 主进程事件循环被占 > 50ms，附当前任务
[renderer] [longtask] 87ms @ 12.3s                 # 渲染进程长任务（转发到主进程日志）
```

退出时打印本次会话最慢操作的汇总表（p50 / p95 / max）。关闭时所有包装都是直通，零开销。

实现：`src/core/perf.ts`。挂点：`db.ts` 的 prepared statements、`main/index.ts` 的 IPC handler 与 `vixel://` 协议、`inference-client.ts` 的每次调用、主进程事件循环、渲染进程 `PerformanceObserver('longtask')`（生产包里可设 `localStorage['vixel.profile'] = '1'` 开启）。

## 隔离的索引压测（不碰真实图库）

Electron 支持 `--user-data-dir`，可以用一个临时库完整跑一遍索引：

```bash
npm run build
# 1) 准备 /tmp/vx-perf/photos 下的图片，并用 initDatabase(...).addFolder(...) 在 /tmp/vx-perf/data/library.db 登记该目录
# 2) 跑起来并剖析
VIXEL_PROFILE=1 npx electron . --user-data-dir=/tmp/vx-perf/data
```

实测（M 系列 Mac）：缩略图 150 张 2400×1600 JPEG < 5 s；LiteRT GPU 上 `embed.encode` 约 0.3 s / 张（旧 ONNX CPU 约 3.3 s）；索引全程主进程无 > 50 ms 阻塞，IPC ≤ 1.2 ms。

## 数据库集成测试

```bash
npm run test:db
```

vitest 跑在纯 Node 下加载不了 Electron ABI 的 better-sqlite3，`db.ts` 的删除级联、内容 GC、只读打开、文件名转义等在 `scripts/db-smoke.cjs` 里用 Electron-as-Node 验证。

## 推理卡死

推理进程有看门狗：有在途请求却 10 分钟没有任何请求完成，就杀掉子进程。在途请求以失败结束（任务面板可见），下一次调用自动重启进程。
