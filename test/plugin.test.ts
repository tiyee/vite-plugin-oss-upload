import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'fs'
import path from 'path'
import os from 'os'
import type { Plugin, ResolvedConfig } from 'vite'

// 记录对 mock OSS 的调用，供断言使用
const calls = {
  head: [] as string[],
  put: [] as Array<{ name: string; file: string }>,
  // 记录每次 new OSS(options) 收到的配置
  ctor: [] as Array<Record<string, unknown>>,
}

// 每个 OSS 实例的 head/put 行为可通过覆盖这两个函数来定制
let headImpl: (name: string) => Promise<unknown> = async (name) => {
  calls.head.push(name)
  const err: Error & { code?: string; status?: number } = new Error('NoSuchKey')
  err.code = 'NoSuchKey'
  err.status = 404
  throw err
}
let putImpl: (name: string, file: string) => Promise<unknown> = async (name, file) => {
  calls.put.push({ name, file })
  return { url: `https://bucket.oss-cn-test.aliyuncs.com//${name}`, res: { status: 200 } }
}

const setHeadImpl = (fn: (name: string) => Promise<unknown>) => {
  headImpl = fn
}
const setPutImpl = (fn: (name: string, file: string) => Promise<unknown>) => {
  putImpl = fn
}

vi.mock('ali-oss', () => {
  const OSS = vi.fn().mockImplementation((options: Record<string, unknown>) => {
    calls.ctor.push(options)
    return {
      head: vi.fn((name: string) => headImpl(name)),
      put: vi.fn((name: string, file: string) => putImpl(name, file)),
    }
  })
  return { default: OSS }
})

// 默认让内网探测返回 false（沿用原配置）；个别用例可通过 setIsInternal 覆盖
let isInternal = false
const setIsInternal = (v: boolean) => {
  isInternal = v
}
vi.mock('../src/utils', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/utils')>()
  return {
    ...actual,
    detectInternalNetwork: vi.fn(() => Promise.resolve(isInternal)),
  }
})

// 在导入插件之后再 import，确保 mock 生效
const { default: assetUploaderPlugin } = await import('../src/index')

let tmpRoot = ''
let cwd = ''

const mk = (p: string) => fs.mkdirSync(p, { recursive: true })
const write = (p: string, content: string) => {
  mk(path.dirname(p))
  fs.writeFileSync(p, content)
}

/**
 * 用最小化的 ResolvedConfig 触发插件钩子。
 * 单点类型转换，避免在各用例中散落 any / @ts-expect-error。
 */
const runPlugin = async (
  plugin: Plugin,
  outDir: string,
  hooks: Array<'writeBundle' | 'closeBundle'> = ['closeBundle'],
) => {
  const config = { build: { outDir } } as unknown as ResolvedConfig
  const anyPlugin = plugin as Record<string, unknown>
  const configResolved = anyPlugin['configResolved']
  if (typeof configResolved === 'function') {
    await configResolved.call(plugin, config)
  }
  for (const hook of hooks) {
    const fn = anyPlugin[hook]
    if (typeof fn === 'function') {
      await fn.call(plugin)
    }
  }
}

describe('assetUploaderPlugin', () => {
  beforeEach(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'vpo-plugin-'))
    cwd = process.cwd()
    process.chdir(tmpRoot)
    calls.head.length = 0
    calls.put.length = 0
    calls.ctor.length = 0
    setIsInternal(false)
  })

  afterEach(() => {
    process.chdir(cwd)
    fs.rmSync(tmpRoot, { recursive: true, force: true })
  })

  const baseOpts = {
    region: 'oss-cn-test',
    accessKeyId: 'akid',
    accessKeySecret: 'aksecret',
    bucket: 'bucket',
    from: './dist/assets/**',
    verbose: false,
  }

  it('缺少必填项（accessKeyId/Secret/bucket）时直接抛错', () => {
    expect(() =>
      assetUploaderPlugin({
        // @ts-expect-error 故意缺 accessKeyId
        accessKeyId: undefined,
        accessKeySecret: 'sk',
        bucket: 'b',
        region: 'oss-cn-hangzhou',
      }),
    ).toThrow(/配置校验失败/)
  })

  it('region 与 endpoint 都缺失时报错', () => {
    expect(() =>
      assetUploaderPlugin({
        accessKeyId: 'ak',
        accessKeySecret: 'sk',
        bucket: 'b',
      }),
    ).toThrow(/region\/endpoint/)
  })

  it('仅传 endpoint（无 region）能通过校验并实例化 OSS', () => {
    const plugin = assetUploaderPlugin({
      ...baseOpts,
      // 去掉 region，仅用 endpoint
      region: undefined,
      endpoint: 'oss-cn-hangzhou.aliyuncs.com',
    })
    expect(plugin.name).toBe('vite-plugin-oss-upload')
    // new OSS 收到 endpoint
    expect(calls.ctor.at(-1)?.endpoint).toBe('oss-cn-hangzhou.aliyuncs.com')
    expect(calls.ctor.at(-1)?.region).toBeUndefined()
  })

  it('secure 透传给 OSS 客户端', () => {
    assetUploaderPlugin({
      ...baseOpts,
      endpoint: 'oss-cn-hangzhou.aliyuncs.com',
      secure: false,
    })
    expect(calls.ctor.at(-1)?.secure).toBe(false)
  })

  it('未传 endpoint/secure 时不污染默认配置（按 region 走默认）', () => {
    assetUploaderPlugin(baseOpts)
    const ctor = calls.ctor.at(-1)!
    expect(ctor.endpoint).toBeUndefined()
    expect(ctor.secure).toBeUndefined()
    expect(ctor.region).toBe('oss-cn-test')
  })

  it('test 模式下不真正上传', async () => {
    write('dist/assets/a.png', 'pngdata')
    const plugin = assetUploaderPlugin({ ...baseOpts, test: true })
    await runPlugin(plugin, 'dist')

    expect(calls.put.length).toBe(0)
  })

  it('正常上传并调用 oss.put，返回 URL 已规范化（无双斜杠）', async () => {
    write('dist/assets/a.png', 'pngdata')
    const plugin = assetUploaderPlugin(baseOpts)
    await runPlugin(plugin, 'dist')

    expect(calls.put.length).toBe(1)
    // 文件在 dist/assets/a.png，相对 dist 目录的路径为 assets/a.png
    expect(calls.put[0]!.name).toBe('assets/a.png')
  })

  it('overwrite=false 且 OSS 已存在时跳过上传', async () => {
    write('dist/assets/exist.png', 'pngdata')
    setHeadImpl(async () => ({ res: { status: 200 } }))
    const plugin = assetUploaderPlugin({ ...baseOpts, overwrite: false })
    await runPlugin(plugin, 'dist')

    expect(calls.put.length).toBe(0)
  })

  it('quitWpOnError 开启且上传失败时中断（closeBundle 抛错）', async () => {
    write('dist/assets/bad.png', 'pngdata')
    setPutImpl(async () => {
      const e: Error & { code?: string } = new Error('boom')
      e.code = 'UploadError'
      throw e
    })
    const plugin = assetUploaderPlugin({ ...baseOpts, quitWpOnError: true })

    await expect(runPlugin(plugin, 'dist')).rejects.toThrow(/quitWpOnError/)
  })

  it('writeBundle 会把代码中的 /assets/xxx.png 替换为 CDN 地址', async () => {
    write('dist/assets/logo.png', 'png')
    write('dist/index.html', '<img src="/assets/logo.png">')
    write('dist/index.js', 'var u="/assets/logo.png";')

    const plugin = assetUploaderPlugin({
      ...baseOpts,
      cdnHost: 'https://cdn.example.com',
      dist: '/static',
      from: './dist/assets/**',
    })
    await runPlugin(plugin, 'dist', ['writeBundle'])

    const html = fs.readFileSync(path.join(tmpRoot, 'dist/index.html'), 'utf-8')
    const js = fs.readFileSync(path.join(tmpRoot, 'dist/index.js'), 'utf-8')
    expect(html).toContain('https://cdn.example.com/static/assets/logo.png')
    expect(js).toContain('https://cdn.example.com/static/assets/logo.png')
  })

  it('未配置 rewriteQueryString 时原样保留 querystring', async () => {
    write('dist/assets/logo.png', 'png')
    write('dist/index.js', 'var u="/assets/logo.png?v=1";')

    const plugin = assetUploaderPlugin({
      ...baseOpts,
      cdnHost: 'https://cdn.example.com',
      dist: '/static',
    })
    await runPlugin(plugin, 'dist', ['writeBundle'])

    const js = fs.readFileSync(path.join(tmpRoot, 'dist/index.js'), 'utf-8')
    expect(js).toContain('https://cdn.example.com/static/assets/logo.png?v=1')
  })

  it('rewriteQueryString 可改写 querystring（入参与返回值均带 ?）', async () => {
    write('dist/assets/logo.png', 'png')
    write('dist/index.js', 'var u="/assets/logo.png?v=1";')

    const plugin = assetUploaderPlugin({
      ...baseOpts,
      cdnHost: 'https://cdn.example.com',
      dist: '/static',
      rewriteQueryString: (p, query) => {
        // 入参 path 为 CDN 替换前的原始资源路径
        expect(p).toBe('/assets/logo.png')
        // 入参 query 带前导 `?`
        expect(query).toBe('?v=1')
        // 返回值带前导 `?`
        return '?v=2'
      },
    })
    await runPlugin(plugin, 'dist', ['writeBundle'])

    const js = fs.readFileSync(path.join(tmpRoot, 'dist/index.js'), 'utf-8')
    expect(js).toContain('https://cdn.example.com/static/assets/logo.png?v=2')
    expect(js).not.toContain('?v=1')
  })

  it('rewriteQueryString 无原查询串时入参 query 为空串，返回空串可去掉查询串', async () => {
    write('dist/assets/logo.png', 'png')
    write('dist/index.js', 'var u="/assets/logo.png";')

    const plugin = assetUploaderPlugin({
      ...baseOpts,
      cdnHost: 'https://cdn.example.com',
      dist: '/static',
      rewriteQueryString: (p, query) => {
        expect(p).toBe('/assets/logo.png')
        expect(query).toBe('')
        return ''
      },
    })
    await runPlugin(plugin, 'dist', ['writeBundle'])

    const js = fs.readFileSync(path.join(tmpRoot, 'dist/index.js'), 'utf-8')
    expect(js).toContain('https://cdn.example.com/static/assets/logo.png')
    expect(js).not.toContain('?')
  })

  it('rewriteQueryString 返回值不带 ? 时会被自动补上', async () => {
    write('dist/assets/logo.png', 'png')
    write('dist/index.js', 'var u="/assets/logo.png";')

    const plugin = assetUploaderPlugin({
      ...baseOpts,
      cdnHost: 'https://cdn.example.com',
      dist: '/static',
      rewriteQueryString: () => 'cache=bust',
    })
    await runPlugin(plugin, 'dist', ['writeBundle'])

    const js = fs.readFileSync(path.join(tmpRoot, 'dist/index.js'), 'utf-8')
    expect(js).toContain('https://cdn.example.com/static/assets/logo.png?cache=bust')
  })

  it('configResolved：未指定 endpoint/secure 且探测到内网时，用内网 endpoint + HTTP 重建 OSS', async () => {
    setIsInternal(true)
    const plugin = assetUploaderPlugin({
      ...baseOpts,
      region: 'oss-cn-hangzhou',
    })
    // baseOpts 不含 endpoint/secure，configResolved 前应仅有首次构造（region）
    const firstCtorCount = calls.ctor.length
    await runPlugin(plugin, 'dist', [])

    // 探测命中后会再 new OSS 一次
    expect(calls.ctor.length).toBe(firstCtorCount + 1)
    const rebuilt = calls.ctor.at(-1)!
    expect(rebuilt.endpoint).toBe('oss-cn-hangzhou-internal.aliyuncs.com')
    expect(rebuilt.secure).toBe(false)
  })

  it('configResolved：探测非内网时沿用原配置，不重建 OSS', async () => {
    setIsInternal(false)
    const plugin = assetUploaderPlugin({
      ...baseOpts,
      region: 'oss-cn-hangzhou',
    })
    const ctorCountBeforeConfig = calls.ctor.length
    await runPlugin(plugin, 'dist', [])
    // 没有额外的构造
    expect(calls.ctor.length).toBe(ctorCountBeforeConfig)
  })

  it('configResolved：用户已显式指定 endpoint 时不触发探测', async () => {
    setIsInternal(true) // 即使“看起来”是内网，也不应再探测
    const plugin = assetUploaderPlugin({
      ...baseOpts,
      region: 'oss-cn-hangzhou',
      endpoint: 'my-custom.endpoint.com',
      secure: true,
    })
    const ctorCountBeforeConfig = calls.ctor.length
    await runPlugin(plugin, 'dist', [])
    expect(calls.ctor.length).toBe(ctorCountBeforeConfig)
  })
})
