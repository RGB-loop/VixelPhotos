/**
 * LiteRT-LM 原生库（C API）的 Node 绑定，经 koffi（Node-API FFI，一份预编译二进制覆盖 macOS / Windows / Linux）。
 *
 * 库本身来自 Google 发布的 litert-lm-api wheel（py3-none，里面只有 C 库，不含 Python），
 * 由 scripts/download-models.mjs litert-runtime 按平台解压到 resources/litert/<platform>-<arch>/：
 *   macOS   liblitert-lm.dylib（Metal / WebGPU 加速器静态链接在内）
 *   Windows litert-lm.dll + dxcompiler.dll + dxil.dll（GPU 走 WebGPU → D3D12，依赖 DirectX 着色器编译器）
 *   Linux   liblitert-lm.so
 *
 * 函数签名以 wheel 自带的 _ffi.py 为准（与库同版本）；GitHub main 上的头文件可能更新、不一定匹配。
 */
import { existsSync } from 'fs'
import { join } from 'path'
import type * as Koffi from 'koffi'

/** 当前平台的库文件名 */
export const LITERT_LIB_NAME: Record<string, string> = {
  darwin: 'liblitert-lm.dylib',
  win32: 'litert-lm.dll',
  linux: 'liblitert-lm.so',
}

/** resources/litert 下的平台子目录名，例如 darwin-arm64、win32-x64 */
export const litertPlatformDir = (): string => `${process.platform}-${process.arch}`

/** LiteRtLmInputData 的类型标签（见 _ffi.py InputDataType） */
export const enum InputType { Text = 0, Image = 1, Audio = 3 }

export interface LiteRtNative {
  createEngine(modelPath: string, backend: 'gpu' | 'cpu', opts: { cacheDir?: string; numThreads?: number; maxInputTokens?: number }): unknown
  deleteEngine(engine: unknown): void
  /** 一次调用、多个输入 → 一个向量（多帧 + 音频即一个视频片段向量）；同步执行（见实现里的说明） */
  embed(engine: unknown, items: Array<[InputType, Buffer]>): Promise<Float32Array>
}

let loaded: LiteRtNative | null = null

/**
 * Windows：库的依赖（dxcompiler / dxil）要从库自己的目录找，默认 DLL 搜索路径不含它；
 * 先 SetDllDirectoryW 再加载。macOS / Linux 的依赖都在库内部，无需处理。
 */
function prepareDllSearchPath(koffi: typeof Koffi, libDir: string): void {
  if (process.platform !== 'win32') return
  const kernel32 = koffi.load('kernel32.dll')
  const setDllDirectory = kernel32.func('bool __stdcall SetDllDirectoryW(str16 path)')
  if (!setDllDirectory(libDir)) throw new Error(`SetDllDirectoryW failed for ${libDir}`)
}

/**
 * 传给 C API 的路径。C 侧按 UTF-8 / 窄字符打开文件：Windows 上含中文等非 ASCII 字符的路径
 * （比如用户名是中文时的 AppData 目录）可能打不开，退到 8.3 短路径；短路径不可用时原样返回，
 * 由调用方在初始化失败时报出明确错误。
 */
export function nativePath(koffi: typeof Koffi, p: string): string {
  if (process.platform !== 'win32' || /^[\x00-\x7f]*$/.test(p)) return p
  try {
    const kernel32 = koffi.load('kernel32.dll')
    const getShortPathName = kernel32.func('uint32 __stdcall GetShortPathNameW(str16 longPath, _Out_ uint16_t *shortPath, uint32 size)')
    const buf = new Uint16Array(1024)
    const n = getShortPathName(p, buf, buf.length)
    if (n > 0 && n < buf.length) return String.fromCharCode(...buf.subarray(0, n))
  } catch { /* 退回原路径 */ }
  return p
}

export function loadLiteRt(libDir: string): LiteRtNative {
  if (loaded) return loaded
  const name = LITERT_LIB_NAME[process.platform]
  if (!name) throw new Error(`LiteRT is not available on ${process.platform}`)
  const libPath = join(libDir, name)
  if (!existsSync(libPath)) throw new Error(`LiteRT runtime missing: ${libPath} (run \`npm run models:download\`)`)

  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const koffi = require('koffi') as typeof Koffi
  prepareDllSearchPath(koffi, libDir)
  const lib = koffi.load(libPath)
  const P = 'void *'
  const fn = {
    setLogLevel: lib.func('litert_lm_set_min_log_level', 'void', ['int']),
    inputCreate: lib.func('litert_lm_input_data_create', P, ['int', P, 'size_t']),
    inputDelete: lib.func('litert_lm_input_data_delete', 'void', [P]),
    settingsCreate: lib.func('litert_lm_embedding_engine_settings_create', P, ['str', 'str', 'str', 'str']),
    settingsDelete: lib.func('litert_lm_embedding_engine_settings_delete', 'void', [P]),
    settingsThreads: lib.func('litert_lm_embedding_engine_settings_set_num_threads', 'void', [P, 'int']),
    settingsAudioThreads: lib.func('litert_lm_embedding_engine_settings_set_audio_num_threads', 'void', [P, 'int']),
    settingsCacheDir: lib.func('litert_lm_embedding_engine_settings_set_cache_dir', 'void', [P, 'str']),
    settingsMaxInput: lib.func('litert_lm_embedding_engine_settings_set_max_input_length', 'void', [P, 'int']),
    engineCreate: lib.func('litert_lm_embedding_engine_create', P, [P]),
    engineDelete: lib.func('litert_lm_embedding_engine_delete', 'void', [P]),
    optionsCreate: lib.func('litert_lm_embedding_options_create', P, []),
    optionsNormalize: lib.func('litert_lm_embedding_options_set_normalize', 'void', [P, 'bool']),
    compute: lib.func('litert_lm_embedding_engine_compute_embedding', P, [P, koffi.pointer(P), 'size_t', P]),
    responseSize: lib.func('litert_lm_embedding_response_get_size', 'size_t', [P]),
    responseValues: lib.func('litert_lm_embedding_response_get_values', P, [P]),
    responseDelete: lib.func('litert_lm_embedding_response_delete', 'void', [P]),
  }
  fn.setLogLevel(3) // LogSeverity：0 VERBOSE … 2 INFO, 3 WARNING。只留 warning 以上；默认每次图片缩放都打一行 INFO

  // 输出向量 L2 归一化（与库里的余弦检索一致）；options 无状态，全局共用一个
  const options = fn.optionsCreate()
  fn.optionsNormalize(options, true)

  loaded = {
    createEngine(modelPath, backend, opts) {
      const settings = fn.settingsCreate(nativePath(koffi, modelPath), backend, backend, backend)
      if (!settings) throw new Error(`LiteRT: cannot open model ${modelPath}`)
      try {
        if (opts.numThreads) { fn.settingsThreads(settings, opts.numThreads); fn.settingsAudioThreads(settings, opts.numThreads) }
        if (opts.cacheDir) fn.settingsCacheDir(settings, nativePath(koffi, opts.cacheDir))
        if (opts.maxInputTokens) fn.settingsMaxInput(settings, opts.maxInputTokens)
        const engine = fn.engineCreate(settings)
        if (!engine) throw new Error(`LiteRT: failed to create ${backend} engine`)
        return engine
      } finally {
        fn.settingsDelete(settings)
      }
    },
    deleteEngine(engine) {
      fn.engineDelete(engine)
    },
    embed(engine, items) {
      // 同步调用：koffi 的 .async 跑在 libuv 工作线程上，文本输入（分词器）在那个线程栈上会 SIGBUS
      // （图片 / 音频不会）。推理进程本来就是串行处理请求的专用进程，同步调用不影响别人。
      const ptrs = items.map(([type, buf]) => fn.inputCreate(type, buf, buf.length))
      let resp: unknown = null
      try {
        resp = fn.compute(engine, ptrs, ptrs.length, options)
      } finally {
        ptrs.forEach((p) => fn.inputDelete(p))
      }
      if (!resp) return Promise.reject(new Error('LiteRT: compute_embedding failed (see stderr for the reason)'))
      try {
        const n = Number(fn.responseSize(resp))
        return Promise.resolve(Float32Array.from(koffi.decode(fn.responseValues(resp), 'float', n) as number[]))
      } finally {
        fn.responseDelete(resp)
      }
    },
  }
  return loaded
}
