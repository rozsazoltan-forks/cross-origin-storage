import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, mkdirSync, globSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { build } from 'vite'
import { cosPlugin } from '../src/vite'

// Build inside the project tree so the fixture resolves `vue` from the project
// node_modules rather than a detached temp dir.
const scratchRoot = fileURLToPath(new URL('./.plugin-scratch', import.meta.url))
const nodeModules = fileURLToPath(new URL('../node_modules', import.meta.url))
const vueEntry = globSync('.pnpm/vue@*/node_modules/vue/dist/vue.runtime.esm-bundler.js', { cwd: nodeModules })[0]!

describe('cosPlugin (standalone vite build)', () => {
  let root: string
  let outDir: string
  let assetsDir: string

  beforeAll(async () => {
    mkdirSync(scratchRoot, { recursive: true })
    root = mkdtempSync(join(scratchRoot, 'app-'))
    outDir = join(root, 'dist')
    assetsDir = join(outDir, 'assets')
    mkdirSync(join(root, 'src'), { recursive: true })
    writeFileSync(
      join(root, 'index.html'),
      '<!doctype html><html><head></head><body><script type="module" src="/src/main.js"></script></body></html>',
    )
    writeFileSync(join(root, 'src/main.js'), 'import { ref } from "vue"\ndocument.body.dataset.count = String(ref(0).value)\n')

    await build({
      root,
      logLevel: 'error',
      // The fixture lives in a scratch dir; point bare `vue` at the project copy.
      resolve: { alias: { vue: join(nodeModules, vueEntry) } },
      plugins: [cosPlugin({ packages: [/^(?:vue$|@vue\/)/] })],
      build: { outDir, emptyOutDir: true, rollupOptions: { input: join(root, 'index.html') } },
    })
  }, 120_000)

  afterAll(() => {
    rmSync(scratchRoot, { recursive: true, force: true })
  })

  function cosChunks(): string[] {
    return readdirSync(assetsDir).filter(f => /^[a-f0-9]{64}\.js$/.test(f))
  }

  it('emits content-addressed chunks whose names match their bytes', () => {
    expect(cosChunks().length).toBeGreaterThanOrEqual(1)
    for (const file of cosChunks()) {
      const hash = createHash('sha256').update(readFileSync(join(assetsDir, file))).digest('hex')
      expect(hash).toBe(file.replace('.js', ''))
    }
  })

  it('rewrites managed imports to content-addressed specifiers', () => {
    for (const file of cosChunks()) {
      const code = readFileSync(join(assetsDir, file), 'utf8')
      const specifiers = [...code.matchAll(/(?:from|import)\s*["']([^"']+)["']/g)].map(m => m[1]!)
      for (const specifier of specifiers) {
        expect(specifier).toMatch(/^cos1:[a-f0-9]{64}$/)
      }
    }
  })

  it('injects the loader into index.html and removes the default entry script', () => {
    const html = readFileSync(join(outDir, 'index.html'), 'utf8')
    expect(html).toContain('<script id="cos-loader">')
    expect(html).toMatch(/cos1:[a-f0-9]{64}/)
    expect(html).not.toMatch(/<script type="module"[^>]*src="[^"]*\.js"/)
  })

  it('derives the base path from the vite config', () => {
    const html = readFileSync(join(outDir, 'index.html'), 'utf8')
    expect(html).toMatch(/"base":"\/assets\/"/)
  })
})
