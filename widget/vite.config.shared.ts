import { fileURLToPath, URL } from 'node:url';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { defineConfig } from 'vite';
import { viteSingleFile } from 'vite-plugin-singlefile';

/**
 * 挂件前端构建 config 工厂——双构建通道（singlefile 不支持多入口，须分两趟构建）：
 *   mini 通道（vite.config.ts）        → dist/mini.html（emptyOutDir=true 先清空）
 *   fullboard 通道（vite.fullboard.config.ts）→ dist/fullboard.html（emptyOutDir=false 第二趟）
 *
 * 两通道共享 root=web、@别名、dev server（5174，任意 html 天然可路由）。
 */
export function widgetConfig(entry: 'mini' | 'fullboard', emptyOutDir: boolean) {
  return defineConfig({
    root: fileURLToPath(new URL('./web', import.meta.url)),
    base: './',
    plugins: [react(), tailwindcss(), viteSingleFile()],
    resolve: {
      alias: { '@': fileURLToPath(new URL('./web/src', import.meta.url)) },
    },
    server: {
      host: '127.0.0.1',
      port: 5174, // 避开 upstream 的 5173
      strictPort: true,
    },
    build: {
      outDir: fileURLToPath(new URL('./dist', import.meta.url)),
      emptyOutDir,
      target: 'chrome120', // WebView2 Evergreen
      rollupOptions: {
        input: {
          [entry]: fileURLToPath(new URL(`./web/${entry}.html`, import.meta.url)),
        },
      },
    },
  });
}
