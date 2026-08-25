#!/usr/bin/env node
/* ============================================================
 * 一键回归入口：node widget/tests/run-all.mjs
 *
 * 两层套件：
 *   mock 层（默认执行）——无头 Chrome + mock __TAURI_INTERNALS__，验证纯前端
 *     行为（筛选/流转/toast/键盘/对比度/徽标/XSS 转义/指示点）。
 *     前置：widget/dist/mini.html 已构建（脚本会自动先跑 build）。
 *   真实层（可选）——连运行中的挂件（真实 Rust command + SQLite）。
 *     前置：挂件以 WEBVIEW2_CDP_PORT 启动，然后设同名环境变量再跑：
 *       WIDGET_CDP_PORT=8490 node widget/tests/run-all.mjs
 *
 * 环境变量：
 *   CHROME_PATH     无头 Chrome 路径（默认 C:/Program Files/Google/Chrome/Application/chrome.exe）
 *   WIDGET_CDP_PORT 挂件 CDP 端口（设置后追加真实层套件）
 * ============================================================ */
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..', '..');

const MOCK_SUITE = [
  { file: 'p1-verify.mjs',          name: 'P1 筛选复位 + 冲突 toast' },
  { file: 'p2-detail-verify.mjs',   name: 'P2-2 详情流转 + 冲突重试' },
  { file: 'p2-1-verify.mjs',        name: 'P2-1 图标语义 + 防误触' },
  { file: 'p2-3-verify.mjs',        name: 'P2-3 对比度 + 键盘可达' },
  { file: 'sharp-verify.mjs',       name: 'agent 徽标 + 胶囊展开 + XSS 转义' },
  { file: 'p3-verify.mjs',          name: 'P3 指示点 scaleX + 字号' },
  { file: 'fb-board-verify.mjs',    name: 'FB 看板核心（七列/拖拽落点/冲突重试）' },
  { file: 'fb-detail-verify.mjs',   name: 'FB 详情面板（编辑/Markdown/评论/活动流）' },
  { file: 'fb-filters-verify.mjs',  name: 'FB 筛选+URL 同步+undo 栈' },
  { file: 'fb-archive-verify.mjs',  name: 'FB 归档面板+右键菜单+标签编辑' },
];

const REAL_SUITE = [
  { file: 'e2e-real-verify.mjs',    name: '真机端到端（数据/新建/流转/筛选/详情）' },
  { file: 'agent-real-verify.mjs',  name: 'agent 徽标真实链路（taskctl → 挂件）' },
  { file: 'fb-real-verify.mjs',     name: 'FB 双窗口真实链路（第二窗口/同步/SQLite 往返）' },
];

function runOne(t) {
  console.log(`\n========== ${t.name} (${t.file}) ==========`);
  const r = spawnSync('node', [path.join(HERE, t.file)], {
    stdio: 'inherit',
    cwd: HERE,                       // 输出/截图落在 widget/tests/.out/
    env: process.env,
  });
  return { name: t.name, ok: r.status === 0, status: r.status };
}

function main() {
  // 1. 构建产物（mock 层依赖 dist/mini.html；Vite 迁移后走 npm run build）
  console.log('构建 widget/dist/mini.html ...');
  const build = spawnSync('npm', ['run', 'build'], {
    stdio: 'inherit',
    cwd: path.join(REPO, 'widget'),
    shell: process.platform === 'win32',
  });
  if (build.status !== 0) { console.error('构建失败，中止'); process.exit(1); }

  const suite = [...MOCK_SUITE];
  if (process.env.WIDGET_CDP_PORT) suite.push(...REAL_SUITE);
  else console.log('（未设 WIDGET_CDP_PORT，跳过真实层套件）');

  // 2. 顺序执行（各脚本端口互异，但顺序跑避免资源争用）
  const results = suite.map(runOne);

  // 3. 汇总
  console.log('\n================ 回归汇总 ================');
  for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}`);
  const failed = results.filter(r => !r.ok).length;
  console.log(`==========================================`);
  console.log(`${results.length - failed}/${results.length} 套件通过`);
  process.exit(failed ? 1 : 0);
}

main();
