import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  // 这两个模块是运行时才动态 import 的（浏览器里用不到 Tauri 的 webview API），
  // 先列进来预打包，免得开发时跑到一半才触发重新优化、把服务搞挂
  optimizeDeps: {
    include: ['@tauri-apps/api/core', '@tauri-apps/api/webview'],
  },
  server: {
    port: 1420,
    strictPort: true,
  },
  build: {
    target: 'safari15',
    outDir: 'dist',
    // 避免清空 outDir 时触发系统级删除拦截；构建产物用带哈希的文件名，不清理也不会串
    emptyOutDir: false,
  },
})
