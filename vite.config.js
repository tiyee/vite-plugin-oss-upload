import { defineConfig } from 'vite'
import Inspect from 'vite-plugin-inspect'
import ViteOSSPluginUpload from './src/index.ts'

// 本文件是插件开发/演示用的配置。
// 生产项目请参考 README.md 中的使用示例，并从环境变量读取凭据，避免硬编码。
const prod = process.env.NODE_ENV === 'production'

export default defineConfig({
  plugins: [
    Inspect(),
    prod &&
      ViteOSSPluginUpload({
        cdnHost: 'https://cdn.xxx.com',
        from: './dist/assets/**', // 上传哪个文件或文件夹
        dist: '/static', // 上传到 OSS 上的目标文件目录
        region: process.env.OSS_REGION || 'oss-xx-xx-1',
        accessKeyId: process.env.OSS_ACCESS_KEY_ID || 'xxxxxxxxxxxx',
        accessKeySecret: process.env.OSS_ACCESS_KEY_SECRET || 'xxxxxxxxxxxx',
        bucket: process.env.OSS_BUCKET || 'xxxxxxxxx',
        overwrite: true,
        deleteOrigin: false,
        quitWpOnError: true,
      }),
  ].filter(Boolean),
})
