# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

`vite-plugin-oss-upload` — a Vite plugin (`apply: 'build'`) that uploads built assets to Alibaba Cloud (Aliyun) OSS after bundling and rewrites asset references in the build output to CDN URLs. Node >= 18, ESM-first (`"type": "module"`), shipped as dual ESM/CJS.

## Commands

```bash
pnpm install
pnpm build        # tsup → dist/ (esm + cjs + dts)
pnpm dev          # tsup --watch
pnpm test         # vitest run (one-shot)
pnpm test:watch   # vitest watch
pnpm lint         # eslint .
pnpm typecheck    # tsc --noEmit
```

Run a single test file or pattern:

```bash
pnpm exec vitest run test/utils.test.ts
pnpm exec vitest run -t "region 与 endpoint"   # by test name
```

`vite.config.js` is a dev/demo harness (uses `vite-plugin-inspect` and loads the plugin straight from `src/index.ts`). It is **not** the published package config — real usage is documented in `README.md`.

## Architecture

Three source files, all in `src/`:

- **`index.ts`** — the plugin factory `assetUploaderPlugin(rawOptions): Plugin`. Owns all state and side effects.
- **`type.ts`** — `PluginOptions = OSSOptions & OptionalOptions`, plus `defaultOption` (spread-merged defaults) and `DEFAULT_FILE_SUFFIX`.
- **`utils.ts`** — pure, dependency-light helpers (`normalize`, `slash`, `escapeRegExp`, `cleanEmptyDir`, `resolveInternalHost`, `detectInternalNetwork`). Designed to be unit-testable in isolation.

### The plugin lifecycle (the part that spans files)

The plugin implements three Vite build hooks; understanding their ordering matters:

1. **`configResolved`** — resolves the absolute `outputPath` from `config.build.outDir`, then optionally runs **internal-network auto-detection**: if the user did *not* explicitly set `endpoint` or `secure`, it TCP-probes `<region>-internal.aliyuncs.com:80`. On a hit it **rebuilds the OSS client** with the internal endpoint + HTTP. This is why `createOSS()` is factored out as a closure rather than constructing the client once.
2. **`writeBundle`** — runs the CDN URL rewrite (`rewriteAssetUrls`) over `./<outputDirectory>/**/*.{js,css,html}` before files are uploaded.
3. **`closeBundle`** — globs `from`, filters to real files matching `fileSuffix`, and uploads via `p-limit` concurrency. Honors `quitWpOnError` by throwing to abort the build.

### Cross-cutting design decisions (read before changing)

- **Option merging never mutates `defaultOption`**: it uses `{ ...defaultOption, ...rawOptions }`. The code comments explicitly warn against `Object.assign(defaultOption, options)`. Preserve this — `defaultOption` must stay pristine because it backs the merge for every plugin instance.
- **Validation is synchronous, at construction time**: `validateOptions` throws immediately if `accessKeyId`/`accessKeySecret`/`bucket` are missing or both `region` and `endpoint` are absent. Don't move this into a hook.
- **Internal-network detection must never throw**: `detectInternalNetwork` and its caller swallow all errors and fall back to the user's original config (never aborts the build). This is intentional for CI/offline environments. Keep it fail-safe.
- **Existence check uses HEAD, not GET**: `getFileExists` returns `false` only for `NoSuchKey`/`404`; any other error (auth, network) is re-thrown rather than silently treated as "missing", so `overwrite: false` skips can't be masked by transient failures.
- **OSS path resolution**: the default `setOssPath` strips the `outputDirectory` segment (e.g. `dist`) from the absolute path, so `dist/assets/a.png` → OSS key `assets/a.png`, prefixed by the `dist` option (the OSS target directory, *not* a local path — naming collision is intentional but confusing).

## Build & packaging

`tsup.config.ts` emits ESM + CJS from `src/index.ts`. Two details that matter for downstream consumers:

- **`shims: true`** is required so `require('vite-plugin-oss-upload').default` *and* `require('vite-plugin-oss-upload')` both resolve in CJS. Don't remove it.
- Only `dist/` is published (`files` field). `tsconfig.build.json` excludes tests from the type-check build; `tsconfig.json` excludes `test/` and `*.test.ts`/`*.spec.ts`.

## Testing conventions

- Tests live in `test/` (vitest config also allows `src/**/*.test.ts`). Environment is `node`.
- **`test/plugin.test.ts` mocks `ali-oss` and `../src/utils`** with `vi.mock` factories that record calls (`calls.head`/`put`/`ctor`). Because mocks must register before the module imports the plugin, it uses dynamic `await import('../src/index')` *after* the `vi.mock` calls. Preserve this ordering when adding tests.
- A `runPlugin` helper manually invokes `configResolved`/`writeBundle`/`closeBundle` against a minimal cast `ResolvedConfig` — single place for the type assertion, avoid scattering `as any`/`@ts-expect-error`.
- Tests use real `fs.mkdtempSync` tmp dirs + `process.chdir`. If you add cwd-sensitive behavior, follow the same `beforeEach`/`afterValue` setup/teardown pattern.

## Lint specifics

ESLint flat config (`eslint.config.js`): `@typescript-eslint/no-explicit-any` is **warn** (not error), unused-args prefixed `_` are allowed, and `dist/`/`coverage/`/`pnpm-lock.yaml` are ignored.
