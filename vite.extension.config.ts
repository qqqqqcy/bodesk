import {fileURLToPath} from 'node:url';
import type {InlineConfig} from 'vite';

const root = fileURLToPath(new URL('./extension/src', import.meta.url));
const outDir = fileURLToPath(new URL('./extension/dist', import.meta.url));

export function extensionConfig(target: 'pages' | 'content' | 'main'): InlineConfig {
  const common: InlineConfig = {
    configFile: false,
    root,
    base: './',
    publicDir: false,
    oxc: {jsx: {runtime: 'automatic', development: false}},
    define: {'process.env.NODE_ENV': JSON.stringify('production')},
    build: {outDir, emptyOutDir: false, target: 'chrome120', minify: false},
  };
  if (target === 'pages') {
    return {...common, build: {...common.build, rolldownOptions: {
      input: {dashboard: root + '/dashboard.html', background: root + '/background.ts', core: root + '/core.ts'},
      preserveEntrySignatures: 'strict',
      output: {entryFileNames: '[name].js', chunkFileNames: 'assets/[name]-[hash].js'},
    }}};
  }
  return {...common, build: {...common.build, lib: {
    entry: root + '/' + target + (target === 'content' ? '.tsx' : '.ts'),
    name: target === 'content' ? 'BossHelperContent' : 'BossHelperPage',
    formats: ['iife'],
    fileName: () => target + '.js',
  }}};
}
