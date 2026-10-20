import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  clearScreen: false,
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
