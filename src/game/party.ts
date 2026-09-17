/**
 * 客户端与后端的 WebSocket 连接层。
 * 后端已从 PartyKit 迁移为通用 Node.js WebSocket（ws 库，入口 server.js，监听 PORT||8080），
 * 前端改为原生 WebSocket + 轻量指数退避自动重连；连接路径保持 /party/<name>/<roomId>。
 * 线上部署时可用 VITE_WS_HOST 覆盖后端地址（如 wss.example.com）。
 */

/**
 * 后端地址：已迁移到腾讯云 CloudBase（后端已部署成功）。
 *  - 默认连接：wss://werewolf-backend-315609-12-1489837450.sh.run.tcloudbase.com
 *  - 如需临时连本地后端：设置 VITE_WS_HOST=localhost:8080 且 VITE_WS_PROTO=ws
 */
export const WS_HOST =
  import.meta.env.VITE_WS_HOST ||
  'werewolf-backend-315609-12-1489837450.sh.run.tcloudbase.com'
/** 连接协议：强制 wss（后端 CloudBase 已启用 HTTPS/WSS）；本地联调可用 VITE_WS_PROTO=ws 覆盖 */
export const WS_PROTO = import.meta.env.VITE_WS_PROTO || 'wss'
/** party 名：对应 server.js 挂载的游戏房间 */
export const PARTY_NAME = 'game'

export interface RoomSocket {
  send(data: string): void
  close(): void
  addEventListener(type: string, listener: (event: any) => void): void
  removeEventListener(type: string, listener: (event: any) => void): void
}

/** 带自动重连的 WebSocket 包装：断线后按指数退避重连（1s/2s/4s…上限 10s）。
 *  重连成功后由上层 onOpen 重新发送 join，服务端按 playerId 重新挂接，不掉线。 */
class ReconnectingRoomSocket implements RoomSocket {
  private url: string
  private ws: WebSocket | null = null
  private listeners = new Map<string, Set<(event: any) => void>>()
  private closedByUser = false
  private retryCount = 0
  private reconnectTimer: number | null = null

  constructor(url: string) {
    this.url = url
    this.connect()
  }

  private connect() {
    if (this.closedByUser) return
    const ws = new WebSocket(this.url)
    this.ws = ws
    ws.addEventListener('open', (e) => this.emit('open', e))
    ws.addEventListener('message', (e) => this.emit('message', e))
    ws.addEventListener('error', (e) => this.emit('error', e))
    ws.addEventListener('close', (e) => {
      this.emit('close', e)
      if (!this.closedByUser) {
        const delay = Math.min(1000 * 2 ** this.retryCount, 10_000)
        this.retryCount += 1
        this.reconnectTimer = window.setTimeout(() => this.connect(), delay)
      }
    })
  }

  send(data: string) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(data)
    }
  }

  close() {
    this.closedByUser = true
    if (this.reconnectTimer !== null) window.clearTimeout(this.reconnectTimer)
    this.ws?.close()
  }

  addEventListener(type: string, listener: (event: any) => void) {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set())
    this.listeners.get(type)!.add(listener)
  }

  removeEventListener(type: string, listener: (event: any) => void) {
    this.listeners.get(type)?.delete(listener)
  }

  private emit(type: string, event: any) {
    this.listeners.get(type)?.forEach((fn) => fn(event))
  }
}

/** 创建连接到后端房间（roomId）的 WebSocket */
export function createRoomSocket(roomId: string): RoomSocket {
  const proto = WS_PROTO
  const url = `${proto}://${WS_HOST}/party/${PARTY_NAME}/${roomId}`
  return new ReconnectingRoomSocket(url)
}

export interface RoomPlayer {
  playerId: string
  nickname: string
  ready: boolean
  /** 入座号（join 即分配；未入座/旧服务端为 null） */
  seat: number | null
  /** 玩家头像 URL（可选；有则座位框显示图片，无则显示座位号徽章） */
  avatarUrl?: string
  /** 服务端统一分配的固定头像索引（1..12，房间内不重复；刷新/换座不变，所有玩家视角一致） */
  avatarIdx?: number | null
}

/** 座位公开信息（不含身份） */
export interface SeatInfo {
  seat: number
  playerId: string
  nickname: string
  avatarIdx?: number | null
}

/** 客户端发起开始游戏时携带的板子数据 */
export interface BoardPayload {
  name: string
  playerCount: number
  roles: { key: string; name: string; count: number; camp?: string }[]
}

export interface WolfChatItem {
  playerId: string
  nickname: string
  text: string
  ts: number
}

export interface WolfVoteSummary {
  seat: number
  count: number
}

/**
 * 单播给单个玩家的语音权限（服务端 voicePerm 帧 / role 帧下发）：
 *  - canSpeak：是否允许本地麦克风发声（false 必须 muteLocalAudio）
 *  - canHearWolves：是否允许接收"活狼语音"（存活的狼人 / 死狼单向收听）
 *  - isDeadChannel：是否在死亡频道（被淘汰玩家；与存活玩家完全隔离）
 *  - hearUserIds：允许收听其语音的远端玩家（其余一律 muteRemoteAudio）
 */
export interface VoicePerm {
  canSpeak: boolean
  canHearWolves: boolean
  isDeadChannel: boolean
  hearUserIds: string[]
}

export const EMPTY_VOICE_PERM: VoicePerm = {
  canSpeak: false,
  canHearWolves: false,
  isDeadChannel: false,
  hearUserIds: [],
}

export type ServerMessage =
  | { type: 'roster'; players: RoomPlayer[]; hostPlayerId: string | null }
  | {
      type: 'gameStarted'
      boardName: string
      playerCount: number
      seats: SeatInfo[]
    }
  | {
      type: 'trtcCredential'
      trtc: { sdkAppId: number; userSig: string }
      voicePerm?: VoicePerm
    }
  | {
      type: 'role'
      seat: number
      roleKey: string
      roleName: string
      camp: string
      trtc?: { sdkAppId: number; userSig: string }
      voicePerm?: VoicePerm
      // 刷新后阶段快照（服务端 getRole 下发，前端据此恢复交互状态）
      phase?: 'lobby' | 'night' | 'day' | 'over'
      dayStage?: string | null
      currentSpeaker?: number | null
      speakerDeadline?: number | null
      sheriffHasSpokenThisDay?: boolean
      deadSeats?: number[]
      deaths?: number[]
      dayIndex?: number
      sheriffSeat?: number | null
      nightPhase?: string | null
      nightDeadline?: number | null
      voteDeadline?: number | null
      mutedSeat?: number | null
      voteHistory?: { dayIndex: number; tally: { seat: number; count: number }[]; exiledSeat: number | null; tie: boolean }[]
      avatarBySeat?: { seat: number; avatarIdx: number | null }[]
    }
  | {
      type: 'voicePerm'
      phase: 'lobby' | 'night' | 'day' | 'over'
      dayStage: string | null
      currentPhase: string | null
      currentSpeaker: number | null
      canSpeak: boolean
      canHearWolves: boolean
      isDeadChannel: boolean
      hearUserIds: string[]
    }
  | { type: 'error'; message: string }
  | { type: 'nightStarted'; nightDeadline: number; nightIndex: number }
  // 全场只收到中性帧（无 roleKey/label）；仅当前行动角色本人额外收到带 roleKey/label 的私发帧
  | { type: 'nightPhase'; stepIndex: number; roleKey?: string; label?: string; disabled?: boolean; stepDeadline?: number | null }
  | { type: 'nightActionAccepted' }
  | {
      type: 'wolfPanel'
      wolfSeats: number[]
      wolfChat: WolfChatItem[]
      wolfVotes: WolfVoteSummary[]
      seats: SeatInfo[]
    }
  | { type: 'wolfChat'; playerId: string; nickname: string; text: string; ts: number }
  | { type: 'wolfVotes'; votes: WolfVoteSummary[] }
  | {
      type: 'wolfWitchResult'
      target: number
      roleKey: string
      roleName: string
    }
  | { type: 'witchInfo'; target: number | null; saveUsed: boolean; poisonUsed: boolean }
  | { type: 'seerResult'; target: number; camp: 'good' | 'wolf'; roleName?: string; isCursedFox?: boolean; rebounded?: boolean }
  | { type: 'cupidConnected'; targets: [number, number] }
  // 仅私发给两位情侣本人：只告知自己的情侣座位号，不告知对方身份
  | { type: 'loverInfo'; partner: number }
  | { type: 'lonelyGirlConverted'; seat: number; newRoleKey: string; newRoleName: string; cause: string; idolSeat: number }
  | {
      type: 'gameOver'
      winner: 'good' | 'wolf' | 'third' | 'cursed_fox'
      winnerLabel: string
      roles: { seat: number; nickname: string; roleKey: string; roleName: string }[]
    }
  | { type: 'nightEnded'; deaths: number[]; wolfTarget?: number | null; dayIndex: number }
  | {
      type: 'dayStarted'
      dayIndex: number
      dayStage: 'talk' | 'vote' | 'result' | 'gun' | 'done'
      deaths: number[]
      deadSeats: number[]
      currentSpeaker: number | null
      speakerOrder: number[]
      speakerDeadline: number | null
      talkDeadline: number | null
      voteDeadline: number | null
      sheriffSeat: number | null
      mutedSeat?: number | null
      skippedSeats?: number[]
      sheriffHasSpokenThisDay?: boolean
    }
  | {
      type: 'speakerChanged'
      currentSpeaker: number
      speakerOrder: number[]
      speakerIndex: number
      speakerDeadline: number
      sheriffHasSpokenThisDay?: boolean
      sheriffInterrupt?: boolean
    }
  | { type: 'speakerSkipped'; skippedSeats: number[]; reason: string; currentSpeaker: number | null }
  | { type: 'voteStarted'; voteDeadline: number; aliveSeats: number[] }
  | {
      type: 'voteResult'
      tally: { seat: number; count: number }[]
      exiledSeat: number | null
      tie: boolean
      history?: { dayIndex: number; tally: { seat: number; count: number }[]; exiledSeat: number | null; tie: boolean }[]
    }
  | {
      type: 'gunPanel'
      seat: number
      canGun: boolean
      roleName: string
      shooterName: string
    }
  | {
      type: 'gunShot'
      shooter: number
      target: number
      shooterName: string
      shooterRole?: string
      targetName: string
    }
  | {
      type: 'sheriffStage'
      stage: 'apply' | 'talk' | 'vote' | 'order' | 'death'
      candidates: number[]
      deadline: number | null
      aliveSeats: number[]
      sheriffSeat: number | null
    }
  | { type: 'sheriffRoster'; candidates: number[] }
  | { type: 'sheriffElected'; seat: number | null; name?: string }
  | { type: 'sheriffChanged'; seat: number | null }
  | { type: 'sheriffOrderPanel'; options: string[] }
  | { type: 'sheriffGiveawayPanel'; aliveSeats: number[] }

export type ClientMessage =
  | { type: 'join'; playerId: string; nickname: string }
  | { type: 'changeSeat'; playerId: string; seat: number }
  | { type: 'ready'; playerId: string; ready: boolean }
  | {
      type: 'start'
      playerId: string
      board: BoardPayload
      assignments?: { playerId: string; roleKey: string }[]
      /** 开发者模式：允许 3~牌池上限 人开局，从完整角色池纯随机抽牌，不补普通村民 */
      devMode?: boolean
    }
  | { type: 'getRole'; playerId: string }
  | { type: 'startNight'; playerId: string }
  | { type: 'wolfChat'; playerId: string; text: string }
  | { type: 'wolfVote'; playerId: string; target: number | null }
  | { type: 'nightTarget'; playerId: string; roleKey: string; target: number }
  | { type: 'cupidAction'; playerId: string; targets: [number, number] }
  | {
      type: 'witchAction'
      playerId: string
      choice: 'save' | 'poison' | 'none'
      target?: number
    }
  | { type: 'dayVote'; playerId: string; target: number | null }
  | { type: 'talkDone'; playerId: string }
  | { type: 'sheriffApply'; playerId: string; apply: boolean }
  | { type: 'sheriffWithdraw'; playerId: string }
  | { type: 'sheriffVote'; playerId: string; target: number }
  | { type: 'sheriffOrder'; playerId: string; dir: string }
  | { type: 'sheriffGiveaway'; playerId: string; target: number | null }
  | { type: 'gunTarget'; playerId: string; target: number }
  | { type: 'skipTalk'; playerId: string }
  /** 警长抢先发言：立刻成为当前发言者并开麦（剥夺原定发言者麦克风）；每天仅一次 */
  | { type: 'sheriffInterrupt'; playerId: string }

/**
 * 生成并持久化玩家身份：
 * - localStorage 存浏览器级 id（稳定）
 * - sessionStorage 存标签页级后缀（同一浏览器开两个窗口 = 两个不同玩家）
 * 刷新页面后 playerId 不变，服务端按 playerId 重新加入，不掉线。
 */
export function getOrCreatePlayerId(): string {
  let base = localStorage.getItem('werewolf-player-id')
  if (!base) {
    base = `p-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
    localStorage.setItem('werewolf-player-id', base)
  }
  let tab = sessionStorage.getItem('werewolf-tab-id')
  if (!tab) {
    tab = Math.random().toString(36).slice(2, 10)
    sessionStorage.setItem('werewolf-tab-id', tab)
  }
  return `${base}-${tab}`
}
