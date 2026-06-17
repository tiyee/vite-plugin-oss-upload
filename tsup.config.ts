import { defineConfig } from 'tsup'

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm', 'cjs'],
  target: 'es2020',
  outDir: 'dist',
  dts: true,
  splitting: false,
  sourcemap: false,
  clean: true,
  treeshake: true,
  // CJS 产物中同时存在 default 与 named 导出时，提供 __esModule interop，
  // 使 require('vite-plugin-oss-upload').default 与 require('vite-plugin-oss-upload') 都可用
  shims: true,
})
