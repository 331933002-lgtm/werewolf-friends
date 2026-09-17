/**
 * 狼人杀「12人丘比特奇缘」WebSocket 服务器入口（Node.js + ws）。
 * 已从 PartyKit 迁移，面向腾讯云 CloudBase：
 *  - 监听 process.env.PORT || 8080（CloudBase 运行时会注入 PORT）
 *  - 前端连接路径保持 /party/<partyName>/<roomId>，由 party/game.js 的 GameServer 处理
 *
 * 启动：node server.js
 */
import http from 'node:http'
import path from 'node:path'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { WebSocketServer } from 'ws'
import GameServer, { TRTC_SDK_APP_ID, TRTC_SDK_SECRET_KEY } from './party/game.js'

const port = Number(process.env.PORT) || 8080
const gameServer = new GameServer()

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const DIST_DIR = path.join(__dirname, 'dist')
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.json': 'application/json; charset=utf-8',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.map': 'application/json',
}

// 普通 HTTP 请求：
//  - dist/ 存在时托管前端（SPA 路由 fallback 到 index.html），实现云托管单容器同源部署（前端 + WS）
//  - dist/ 不存在时（本地开发）仅返回健康检查文本（CloudBase / 负载均衡探活）
const httpServer = http.createServer(async (req, res) => {
  const urlPath = decodeURIComponent((req.url ?? '/').split('?')[0])
  try {
    const full = path.join(DIST_DIR, urlPath === '/' ? 'index.html' : urlPath)
    if (!full.startsWith(DIST_DIR)) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' })
      res.end('Not Found')
      return
    }
    const data = await readFile(full)
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(full).toLowerCase()] ?? 'application/octet-stream',
    })
    res.end(data)
  } catch {
    // SPA fallback：前端路由路径回退 index.html
    try {
      const index = await readFile(path.join(DIST_DIR, 'index.html'))
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
      res.end(index)
    } catch {
      res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' })
      res.end('werewolf-friends ws server is running')
    }
  }
})

const wss = new WebSocketServer({ noServer: true })

wss.on('connection', (ws, req) => {
  gameServer.handleConnection(ws, req)
  ws.on('message', (data) => {
    gameServer.handleMessage(ws, data)
  })
  ws.on('close', () => {
    gameServer.handleClose(ws)
  })
  ws.on('error', (err) => {
    console.error('[ws] connection error:', err?.message ?? err)
  })
})

httpServer.on('upgrade', (req, socket, head) => {
  const pathname = (req.url ?? '/').split('?')[0]
  // 只接受 /party/... 的 WebSocket 升级请求，其余直接拒绝
  if (!pathname.startsWith('/party/')) {
    socket.write('HTTP/1.1 404 Not Found\r\n\r\n')
    socket.destroy()
    return
  }
  wss.handleUpgrade(req, socket, head, (ws) => {
    wss.emit('connection', ws, req)
  })
})

httpServer.listen(port, () => {
  console.log(`[werewolf-friends] WebSocket server listening on http://localhost:${port}`)
  // TRTC 启动指纹：核对当前运行进程实际使用的密钥（若与腾讯云控制台不一致请改 party/game.js 顶部）
  console.log(
    `[trtc] SDKAppID=${TRTC_SDK_APP_ID} · SecretKey末6位=${String(TRTC_SDK_SECRET_KEY).slice(-6)} —— 请与腾讯云控制台该应用密钥核对；UserSig 每次 getRole 实时生成`,
  )
})
