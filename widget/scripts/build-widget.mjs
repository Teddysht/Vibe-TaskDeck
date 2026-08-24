#!/usr/bin/env node
/**
 * 无依赖构建脚本：把 widget/web/src 的多文件源码合并成单文件 dist/mini.html。
 *
 * 不依赖任何 npm 包，只使用 Node 内置 fs/path。
 * 用法：node widget/scripts/build-widget.mjs
 *
 * 合并契约：
 *   - index.html 里的 <!--__STYLES__--> 替换为 <style> + 各 CSS 源码
 *   - index.html 里的 <!--__SCRIPTS__--> 替换为 <script> + 各 JS 源码（按序）
 *   - JS 全部拼进同一个 <script> 块，顶层 const/function 天然共享作用域，
 *     因此模块之间无需 import，按依赖顺序排列即可。
 *
 * 注意：源码内不得出现字面量 "</script>" 或 "</style>"（会提前闭合）。
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..'); // widget/
const SRC = join(ROOT, 'web', 'src');
const DIST = join(ROOT, 'dist');

// 依赖顺序：config → state → api → render-mini → render-large → render-board → detail → bridge → main
const STYLES = [
  'styles/tokens.css',
  'styles/widget.css',
];

const SCRIPTS = [
  'js/config.js',
  'js/state.js',
  'js/api.js',
  'js/render-mini.js',
  'js/render-large.js',
  'js/render-board.js',
  'js/detail.js',
  'js/bridge.js',
  'js/main.js',
];

function read(rel) {
  return readFileSync(join(SRC, rel), 'utf8');
}

let html = read('index.html');

const css = STYLES.map(read).join('\n\n');
const js = SCRIPTS.map((rel) => `// ===== ${rel} =====\n${read(rel)}`).join('\n\n');

if (!html.includes('<!--__STYLES__-->') || !html.includes('<!--__SCRIPTS__-->')) {
  console.error('index.html 缺少占位符 <!--__STYLES__--> 或 <!--__SCRIPTS__-->');
  process.exit(1);
}

html = html.replace('<!--__STYLES__-->', `<style>\n${css}\n</style>`);
html = html.replace('<!--__SCRIPTS__-->', `<script>\n${js}\n</script>`);

mkdirSync(DIST, { recursive: true });
const out = join(DIST, 'mini.html');
writeFileSync(out, html, 'utf8');
console.log(`✓ built ${out}`);
