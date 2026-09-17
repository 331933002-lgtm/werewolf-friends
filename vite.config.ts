import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    // 本地开发代理：前端同源路径 /party/* 转发到本地后端（server.js:8080），
    // 与云托管部署后同源直连保持一致，前端无需关心后端地址。
    proxy: {
      '/party': {
        target: 'http://localhost:8080',
        ws: true,
      },
    },
  },
})
