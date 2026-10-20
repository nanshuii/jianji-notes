/// <reference types="vite/client" />

// 让 TypeScript 认识 Vite 的 ?raw 导入（操作手册用这个方式载入）
declare module '*.md?raw' {
  const content: string
  export default content
}
