import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { rolldown } from 'rolldown'
import type { Plugin } from 'vite'
import type { CosManifest } from './runtime/loader'

export type { CosManifest }

const MANIFEST_PLACEHOLDER = '__COS_MANIFEST__'

/**
 * Recipe version embedded in every content-addressed specifier. Bump this
 * whenever the build recipe (bundler version, options, define replacements)
 * changes in a way that alters emitted bytes, so chunks built under different
 * recipes cannot silently collide on the same SHA-256.
 */
const RECIPE = 'cos1'

const DEFAULT_LOADER_ENTRY = fileURLToPath(new URL('./runtime/loader.entry.js', import.meta.url))

export interface CosPluginOptions {
  /**
   * Packages to extract into standalone Cross-Origin Storage chunks. Each entry
   * is matched against the imported module specifier; a plain string is treated
   * as an exact match.
   */
  packages: Array<string | RegExp>
  /**
   * Public base path the managed chunks are served from. Defaults to Vite's
   * resolved `base` joined with `build.assetsDir`.
   */
  base?: string
  /**
   * Path to the runtime loader entry to bundle into the injected `<script>`.
   * Defaults to the bundled loader. Override only to swap the loader runtime.
   */
  loaderEntry?: string
  /**
   * Called once the managed chunks are emitted, with the loader `<script>` body
   * (loader IIFE + inlined manifest). SSR frameworks should inject this into
   * their rendered HTML themselves. When omitted, the plugin injects it into
   * `index.html` via `transformIndexHtml` for plain client builds.
   */
  onGenerated?: (scriptContent: string) => void
}

function contentSpecifier(hash: string): string {
  return `${RECIPE}:${hash}`
}

function toMatchers(packages: Array<string | RegExp>): RegExp[] {
  return packages.map(p => typeof p === 'string' ? new RegExp(`^${p}$`) : p)
}

/**
 * Bundle the runtime loader into a self-contained IIFE with rolldown, leaving
 * `__COS_MANIFEST__` as a literal token for the caller to substitute. Bundling
 * from source keeps the loader correct regardless of how the host build loaded
 * this plugin.
 */
async function bundleLoader(entry: string): Promise<string> {
  const builder = await rolldown({ input: entry, platform: 'browser', treeshake: true })
  const { output } = await builder.generate({ format: 'iife', minify: true })
  await builder.close()
  return output[0].code
}

function rewriteSpecifier(code: string, from: string, to: string): string {
  const escaped = from.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const fromImport = new RegExp(`((?:import|export)\\b[^;'"\\n]*?from\\s*|import\\s*|export\\s*\\*\\s*from\\s*)(["'])${escaped}\\2`, 'g')
  const bareImport = new RegExp(`(\\bimport\\s*)(["'])${escaped}\\2`, 'g')
  const dynamic = new RegExp(`(\\bimport\\s*\\(\\s*)(["'])${escaped}\\2(\\s*\\))`, 'g')
  return code
    .replace(dynamic, `$1$2${to}$2$3`)
    .replace(fromImport, `$1$2${to}$2`)
    .replace(bareImport, `$1$2${to}$2`)
}

function joinBase(base: string, assetsDir: string): string {
  const prefix = base.endsWith('/') ? base : `${base}/`
  const dir = assetsDir.replace(/^\/+|\/+$/g, '')
  return dir ? `${prefix}${dir}/` : prefix
}

export function cosPlugin(options: CosPluginOptions): Plugin {
  const packages = toMatchers(options.packages)
  const loaderEntry = options.loaderEntry ?? DEFAULT_LOADER_ENTRY

  const collected = new Set<string>()
  let assetsDir = 'assets'
  let resolvedBase = '/'
  let loaderTemplate: Promise<string> | undefined
  let scriptContent = ''

  return {
    name: 'vite-plugin-cos',
    enforce: 'pre',
    apply: 'build',
    configResolved(config) {
      assetsDir = config.build.assetsDir
      resolvedBase = config.base
    },
    resolveId: {
      order: 'pre',
      async handler(id, importer, resolveOptions) {
        if (!packages.some(p => p.test(id))) {
          return
        }

        const resolved = await this.resolve(id, importer, { ...resolveOptions, skipSelf: true })
        if (!resolved) {
          return
        }

        collected.add(resolved.id)

        // Externalise under a synthetic specifier so it never clashes with the
        // real module id elsewhere in the app graph. It is rewritten to a
        // content-addressed specifier in `generateBundle`, once every managed
        // chunk has been hashed bottom-up.
        return { id: `cos-ext:${resolved.id}`, external: true }
      },
    },
    async generateBundle(_outputOptions, bundle) {
      if (!collected.size) {
        return
      }
      const base = options.base ?? joinBase(resolvedBase, assetsDir)
      const assetPrefix = assetsDir ? `${assetsDir.replace(/^\/+|\/+$/g, '')}/` : ''

      // Build each managed package standalone, externalising every dependency
      // by its resolved absolute id. Transitive dependencies are discovered and
      // queued here, so managing a package implicitly manages its whole import
      // subgraph (e.g. `vue` pulls in `@vue/*`) without the app having to list
      // them. The externalised ids double as the edges between managed chunks.
      const raw = new Map<string, { code: string, deps: string[] }>()
      const queue = [...collected]
      while (queue.length) {
        const input = queue.shift()!
        if (raw.has(input)) {
          continue
        }

        const deps = new Set<string>()
        let code: string
        try {
          const builder = await rolldown({
            input,
            platform: 'browser',
            treeshake: false,
            plugins: [{
              name: 'cos-externalise-deps',
              async resolveId(id, importer) {
                if (!importer) {
                  return null
                }
                const dep = await this.resolve(id, importer, { skipSelf: true })
                if (!dep) {
                  return null
                }
                deps.add(dep.id)
                // Externalise under a synthetic specifier keyed by the resolved
                // id, so the emitted import is a literal token we rewrite later.
                // Source specifiers may be relative (`./shared/x.mjs`); the
                // token makes the rewrite independent of how they were written.
                return { id: `cos-dep:${dep.id}`, external: true }
              },
            }],
          })
          // `minify` is part of the pinned recipe (see RECIPE): it both shrinks
          // the chunk and strips rolldown's `//#region <path>` debug comments,
          // which embed cwd-relative paths and would otherwise make the hash
          // depend on the build location.
          const { output } = await builder.generate({ file: 'chunk.js', codeSplitting: false, minify: true })
          await builder.close()
          code = output[0].code
        }
        catch (error) {
          throw new Error(
            `[cos] cannot bundle managed package as a standalone chunk:\n  ${input}\n`
            + `It likely imports build-time virtuals (e.g. \`#build/*\`, \`#imports\`) that only `
            + `resolve inside the host build, so it is not a self-contained, shareable artifact. `
            + `Only depend on packages whose source resolves from disk on its own.\n\n`
            + `Underlying error: ${(error as Error).message}`,
            { cause: error },
          )
        }

        raw.set(input, { code, deps: [...deps] })
        queue.push(...deps)
      }

      // Hash bottom-up: a chunk's specifier for a dependency is that
      // dependency's content hash, so a chunk can only be hashed once all of
      // its dependencies have been. The npm graph for these packages is a DAG.
      const hashes = new Map<string, string>()
      const managed: CosManifest['chunks'] = {}

      const visit = (id: string, stack: string[]): string => {
        const existing = hashes.get(id)
        if (existing) {
          return existing
        }
        if (stack.includes(id)) {
          throw new Error(`[cos] dependency cycle between managed packages: ${[...stack, id].join(' -> ')}`)
        }

        const { code, deps } = raw.get(id)!
        let resolved = code
        for (const dep of deps) {
          resolved = rewriteSpecifier(resolved, `cos-dep:${dep}`, contentSpecifier(visit(dep, [...stack, id])))
        }

        const hash = createHash('sha256').update(resolved).digest('hex')
        const fileName = `${assetPrefix}${hash}.js`
        hashes.set(id, hash)
        managed[contentSpecifier(hash)] = { file: `${hash}.js`, hash }
        bundle[fileName] = {
          type: 'asset',
          fileName,
          name: hash,
          names: [hash],
          originalFileName: null,
          originalFileNames: [],
          needsCodeReference: false,
          source: resolved,
        }
        return hash
      }

      for (const id of raw.keys()) {
        visit(id, [])
      }

      let entry: CosManifest['entry'] | undefined
      for (const file of Object.values(bundle)) {
        if (file.type !== 'chunk') {
          continue
        }
        // App chunks only reference the packages the app imported directly,
        // externalised as `cos-ext:<id>` by this plugin's `resolveId`.
        for (const id of collected) {
          file.code = rewriteSpecifier(file.code, `cos-ext:${id}`, contentSpecifier(hashes.get(id)!))
        }
        if (file.isEntry) {
          // The entry is app-specific and is re-rendered by Vite after this
          // hook, so it cannot be content-addressed here; it loads from the
          // network under a stable specifier instead.
          entry = { specifier: `${RECIPE}:entry`, file: file.fileName.replace(new RegExp(`^${assetPrefix}`), '') }
        }
      }

      if (!entry) {
        return
      }

      const manifest: CosManifest = { base, entry, chunks: managed }
      loaderTemplate ??= bundleLoader(loaderEntry)
      scriptContent = (await loaderTemplate).replace(MANIFEST_PLACEHOLDER, JSON.stringify(manifest))
      options.onGenerated?.(scriptContent)
    },
    transformIndexHtml: {
      order: 'post',
      handler(html) {
        if (options.onGenerated || !scriptContent) {
          return html
        }
        return html
          .replace(/<script type="module"[^>]*src="[^"]*"[^>]*><\/script>/g, '')
          .replace('</head>', `<script id="cos-loader">${scriptContent}</script></head>`)
      },
    },
  }
}

export default cosPlugin
