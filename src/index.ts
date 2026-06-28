import path from 'path'
import fsp from 'fs/promises'
import { glob } from 'glob'
import OSS from 'ali-oss'
import pc from 'picocolors'
import pLimit from 'p-limit'
import type { Plugin, ResolvedConfig } from 'vite'

import {
  defaultOption,
  DEFAULT_FILE_SUFFIX,
  type PluginOptions,
  type UploadStats,
} from './type'
import { cleanEmptyDir, detectInternalNetwork, escapeRegExp, normalize, resolveInternalHost, slash } from './utils'

const REQUIRED_OSS_KEYS: ReadonlyArray<keyof PluginOptions> = [
  'accessKeyId',
  'accessKeySecret',
  'bucket',
]

const log = {
  info: (msg: string) => console.log(pc.green(msg)),
  error: (msg: string) => console.log(pc.red(msg)),
  step: (msg: string) => console.log(pc.cyan(msg)),
}

/** 仅在 verbose 开启时输出日志 */
const makeDebug = (verbose: boolean) => (msg: string) => {
  if (verbose) console.log(msg)
}

/**
 * 校验配置项：
 * - `accessKeyId` / `accessKeySecret` / `bucket` 必填
 * - `region` 与 `endpoint` 至少传入一个（OSS 客户端要求二选一）
 * 返回错误信息数组（空数组表示通过）。
 */
const validateOptions = (options: PluginOptions): string[] => {
  const errors: string[] = []
  for (const key of REQUIRED_OSS_KEYS) {
    const v = options[key]
    if (v === undefined || v === null || v === '') {
      errors.push(String(key))
    }
  }
  const hasRegion = typeof options.region === 'string' && options.region.trim() !== ''
  const hasEndpoint = typeof options.endpoint === 'string' && options.endpoint.trim() !== ''
  if (!hasRegion && !hasEndpoint) {
    errors.push('region/endpoint（至少配置其一）')
  }
  return errors
}

/**
 * 默认的 OSS 路径生成：以构建输出目录为基准，截取相对路径作为 OSS key。
 * 适配 `outputDirectory`，不再硬编码 "dist"。
 */
const defaultSetOssPath =
  (outputDirectory: string) =>
  (filePath: string): string => {
    const idx = filePath.lastIndexOf(outputDirectory)
    const rel = idx >= 0 ? filePath.slice(idx + outputDirectory.length) : path.basename(filePath)
    return slash(rel).replace(/^\/+/, '')
  }

const assetUploaderPlugin = (rawOptions: PluginOptions): Plugin => {
  // 合并默认值，避免污染 defaultOption（不使用 Object.assign(defaultOption, options)）
  const options: PluginOptions = { ...defaultOption, ...rawOptions }

  const errors = validateOptions(options)
  if (errors.length > 0) {
    throw new Error(
      `[vite-plugin-oss-upload] 配置校验失败，请检查以下配置项: ${errors.join(', ')}。`,
    )
  }

  /**
   * 根据最终的 region / endpoint / secure 创建 OSS 客户端。
   * 提取为函数，便于在 configResolved 探测内网后重建客户端。
   */
  const createOSS = (override?: {
    region?: string
    endpoint?: string
    secure?: boolean
  }) =>
    new OSS({
      ...(override?.region ?? options.region ? { region: override?.region ?? options.region } : {}),
      ...(override?.endpoint ?? options.endpoint
        ? { endpoint: override?.endpoint ?? options.endpoint }
        : {}),
      ...(override?.secure !== undefined
        ? { secure: override.secure }
        : options.secure !== undefined
          ? { secure: options.secure }
          : {}),
      accessKeyId: options.accessKeyId,
      accessKeySecret: options.accessKeySecret,
      bucket: options.bucket,
    })

  let oss = createOSS()

  const {
    quitWpOnError,
    concurrency,
  } = options

  const from = options.from ?? defaultOption.from
  const dist = options.dist ?? defaultOption.dist
  const deleteOrigin = options.deleteOrigin ?? defaultOption.deleteOrigin
  const deleteEmptyDir = options.deleteEmptyDir ?? defaultOption.deleteEmptyDir
  const setOssPath = options.setOssPath
  const timeout = options.timeout ?? defaultOption.timeout
  const verbose = options.verbose ?? defaultOption.verbose
  const test = options.test ?? defaultOption.test
  const overwrite = options.overwrite ?? defaultOption.overwrite
  const version = options.version ?? defaultOption.version
  const setVersion = options.setVersion
  const assetsDirectory = options.assetsDirectory ?? defaultOption.assetsDirectory
  const outputDirectory = options.outputDirectory ?? defaultOption.outputDirectory
  const rewriteQueryString = options.rewriteQueryString

  const fileSuffix = options.fileSuffix ?? [...DEFAULT_FILE_SUFFIX]
  // 仅在用户未自定义 setOssPath 时启用默认实现
  const resolveOssPath = setOssPath ?? defaultSetOssPath(outputDirectory)
  const limit = pLimit(Math.max(1, concurrency ?? 5))
  const debug = makeDebug(verbose)

  // 构建输出目录（configResolved 后被填充）
  let outputPath = ''

  /**
   * 上传文件（并发受 `concurrency` 控制）。
   *
   * @param files 所有需要上传的文件路径列表
   * @param outputPath 构建输出目录的绝对路径
   */
  const upload = async (files: string[], outputPath: string): Promise<UploadStats> => {
    if (test) {
      log.info(`\n Currently running in test mode, your files won't really be uploaded.\n`)
    } else {
      log.info(`\n Your files will be uploaded very soon.\n`)
    }

    const stats: UploadStats = { uploaded: [], ignored: [], errors: [] }
    const fileCount = files.length
    let index = 0

    const tasks = files.map((file) =>
      limit(async () => {
        const n = ++index
        const fullPath = path.resolve(file)
        // OSS 目标路径
        const relativePath = resolveOssPath(fullPath) || (outputPath ? fullPath.split(outputPath)[1] : '')
        const ossFilePath = slash(path.join(dist, relativePath)).replace(/^\/+/, '')

        try {
          // 用 HEAD 而非 GET 检查存在性，避免下载文件内容
          const exists = await getFileExists(ossFilePath)
          debug(`oss中 ${pc.underline(ossFilePath)} ${exists ? '已存在' : '不存在'}`)

          if (exists && !overwrite) {
            stats.ignored.push(fullPath)
            return
          }

          if (test) {
            console.log(pc.blue(file), `is ready to upload to ${pc.green(ossFilePath)}\n`)
            return
          }

          debug(`\n ${n}/${fileCount} ${pc.underline(file)} uploading...`)

          const result = await oss.put(ossFilePath, fullPath, {
            timeout,
            // 覆盖时设置长期缓存；不覆盖时禁止覆盖写入
            headers: overwrite
              ? { 'Cache-Control': 'max-age=31536000' }
              : { 'Cache-Control': 'max-age=31536000', 'x-oss-forbid-overwrite': true },
          })

          const url = normalize(result.url || '')
          stats.uploaded.push(file)
          debug(
            `\n ${n}/${fileCount} ${pc.blue(pc.underline(file))} successfully uploaded, oss url =>  ${pc.green(pc.underline(url))}`,
          )

          if (deleteOrigin) {
            await fsp.unlink(fullPath).catch(() => {})
            if (deleteEmptyDir) {
              cleanEmptyDir(fullPath, outputPath || undefined)
            }
          }
        } catch (err: unknown) {
          const e = err as { code?: string; message?: string; name?: string }
          stats.errors.push({ file, err: { code: e.code, message: e.message, name: e.name } })
          log.error(`\n Failed to upload ${pc.underline(file)}: ${e.name}-${e.code}: ${e.message}`)
        }
      }),
    )

    await Promise.all(tasks)

    // 版本号上报（失败不阻断主流程）
    try {
      if (setVersion && version && !test) {
        await setVersion({ version })
        log.step('版本号已更新')
      }
    } catch (err: unknown) {
      const e = err as { message?: string }
      log.error(`更新版本号出错了: ${e?.message ?? err}`)
    }

    return stats
  }

  /**
   * 使用 HEAD 判断 OSS 中是否存在该文件。
   * 只对 "文件确实不存在"（NoSuchKey / 404）返回 false，
   * 其它错误（鉴权失败、网络异常等）向上抛出，避免被静默吞没。
   */
  const getFileExists = async (filepath: string): Promise<boolean> => {
    try {
      await oss.head(filepath)
      return true
    } catch (e: unknown) {
      const err = e as { code?: string; status?: number }
      if (err.code === 'NoSuchKey' || err.status === 404) return false
      throw e
    }
  }

  /**
   * 替换构建产物中的资源引用为 CDN 地址。
   * 仅替换形如 `/assets/xxx.<ext>` 的引用（前面通常是引号、等号、括号或空白），
   * 并排除已是完整 URL（http(s)://）的情况。
   */
  const rewriteAssetUrls = async (): Promise<void> => {
    if (!options.cdnHost) return

    const base = new URL(dist || '', options.cdnHost).href
    const cdnBaseUrl = normalize(base).replace(/\/$/, '')

    const dirPattern = escapeRegExp(assetsDirectory)
    const suffixPattern = fileSuffix.map(escapeRegExp).join('|')
    // $1 = 前导分隔符（引号/等号/括号/空白/行首），原样保留
    // $2 = /assets/xxx.<ext>，被替换为 ${cdnBaseUrl}$2
    // $3 = 后缀名（仅占位，不使用）
    // $4 = 可选的原 querystring（带前导 `?`，可能包含资源 hash 等），无则 undefined
    const regExp = new RegExp(
      `(^|[\\s'"=()])((?:\\/${dirPattern})\\/[\\w.\\-/]+\\.(${suffixPattern}))(\\?[^\\s'"<>)]*)?(?![\\w])`,
      'ig',
    )

    // 统一签名：未配置 rewriteQueryString 时按原样保留 querystring；否则交给用户改写。
    // 注意：入参与返回值的 query 都带前导 `?`，返回 `''` 表示去掉查询串。
    const replaceFn = (
      _m: string,
      lead: string,
      assetPath: string,
      _ext: string,
      rawQuery: string | undefined,
    ): string => {
      const query = rawQuery ?? ''
      const nextQuery = rewriteQueryString ? rewriteQueryString(assetPath, query) : query
      const querySuffix = nextQuery ? (nextQuery.startsWith('?') ? nextQuery : `?${nextQuery}`) : ''
      return `${lead}${cdnBaseUrl}${assetPath}${querySuffix}`
    }

    const fileList = await glob(`./${outputDirectory}/**/*.{js,css,html}`)
    await Promise.all(
      fileList.map(async (filePath) => {
        const content = await fsp.readFile(filePath, 'utf-8')
        const next = content.replace(regExp, replaceFn)
        if (next !== content) {
          await fsp.writeFile(filePath, next, 'utf-8')
        }
      }),
    )
  }

  return {
    name: 'vite-plugin-oss-upload',
    apply: 'build',
    async configResolved(config: ResolvedConfig) {
      outputPath = path.resolve(slash(config.build.outDir))

      // 仅当用户未显式指定 endpoint 与 secure 时，才自动探测内网环境。
      // 探测命中：使用内网 endpoint 并默认走 HTTP；探测失败：沿用用户原配置，不中断构建。
      const userSpecifiedEndpoint = typeof options.endpoint === 'string' && options.endpoint.trim() !== ''
      const userSpecifiedSecure = options.secure !== undefined
      if (!userSpecifiedEndpoint && !userSpecifiedSecure) {
        const internalHost = resolveInternalHost(options.region, options.endpoint)
        if (internalHost) {
          let internal = false
          try {
            internal = await detectInternalNetwork(internalHost)
          } catch {
            internal = false
          }
          if (internal) {
            oss = createOSS({ endpoint: internalHost, secure: false })
            debug(`检测到内网环境，已切换为内网 endpoint (${internalHost}) + HTTP`)
          }
        }
      }
    },
    async writeBundle() {
      await rewriteAssetUrls()
    },
    async closeBundle() {
      const all = await glob(from)
      console.log('\n')
      if (all.length > 0) {
        console.log(pc.underline(`需要上传的文件目录 ${all[0]}`))
      }

      const regExp = new RegExp(`\\.(${fileSuffix.map(escapeRegExp).join('|')})$`, 'i')
      // 过滤出真实文件且后缀匹配的条目（异步 stat）
      const files: string[] = []
      await Promise.all(
        all.map(async (file) => {
          try {
            const stats = await fsp.stat(file)
            if (stats.isFile() && regExp.test(file)) files.push(file)
          } catch {
            /* ignore */
          }
        }),
      )

      if (files.length === 0) {
        if (verbose) log.error('no files to be uploaded')
        return
      }

      let shouldThrow = false
      try {
        const stats = await upload(files, outputPath)
        // quitWpOnError 触发条件：有上传失败且开启了中断
        if (quitWpOnError && stats.errors.length > 0) {
          shouldThrow = true
        }
      } catch (err: unknown) {
        log.error(String(err))
        if (quitWpOnError) shouldThrow = true
      }
      if (shouldThrow) {
        throw new Error('[vite-plugin-oss-upload] 因 quitWpOnError 开启且存在上传失败，已中断打包。')
      }
    },
  }
}

export default assetUploaderPlugin
export type { PluginOptions, UploadStats } from './type'
