import { useEffect, useRef, useState } from 'react'
import { Link, useParams, useSearchParams } from 'react-router-dom'
import VoiceRoom from '../VoiceRoom'

/** 随机搞笑头像池（12 张，位于 public/avatars），游戏开始后随机分发给各座位 */
// 头像由服务端统一分配 avatarIdx（1..12），前端拼 URL：/avatars/avatar-01.jpg … avatar-12.jpg
import RoleActionPanel from '../components/RoleActionPanel'
import { boards, type Board, type Camp } from '../data/boards'
import {
  EMPTY_VOICE_PERM,
  createRoomSocket,
  getOrCreatePlayerId,
  type ClientMessage,
  type RoomPlayer,
  type RoomSocket,
  type SeatInfo,
  type ServerMessage,
  type VoicePerm,
  type WolfChatItem,
  type WolfVoteSummary,
} from '../game/party'
import {
  NIGHT_STEPS,
  clearSavedGame,
  computeDeaths,
  loadSavedGame,
  saveGame,
  shuffleDeal,
  type NightAction,
  type NightStepConfig,
  type SavedGame,
} from '../game/game'

type WitchChoice = 'heal' | 'poison' | 'none' | null

const CAMP_LABEL: Record<Camp, string> = {
  wolf: '狼人阵营',
  good: '好人阵营',
  third: '第三方阵营',
}

const EMPTY_GAME: SavedGame = {
  deal: [],
  phase: 'waiting',
  nightIndex: 0,
  nightLog: [],
  dayCount: 0,
  deaths: [],
  dayStage: 'deaths',
  exiledSeat: null,
  exileHasLastWords: null,
  dayLog: [],
}

function Room() {
  const { roomId } = useParams<{ roomId: string }>()
  const [searchParams] = useSearchParams()
  const nickname = searchParams.get('nickname') || '玩家'

  // 从 URL 中解析创建/加入时传入的板子数据
  const boardParam = searchParams.get('board')
  let currentBoard: Board = boards[0]
  if (boardParam) {
    try {
      currentBoard = JSON.parse(boardParam) as Board
    } catch {
      currentBoard = boards[0]
    }
  }

  const seatCount = currentBoard.playerCount
  const isDemo = roomId === 'demo'
  const roleList = currentBoard.roles.map((role) => role.name).join('、')

  // 游戏状态：优先从本地恢复（刷新后继续主持），旧存档自动补齐白天字段
  const [game, setGame] = useState<SavedGame>(() => {
    const saved = loadSavedGame(roomId ?? '')
    if (saved && saved.deal.length === currentBoard.playerCount) {
      return { ...EMPTY_GAME, ...saved }
    }
    return { ...EMPTY_GAME }
  })
  const [revealSeat, setRevealSeat] = useState<number | null>(null)
  const [nightTargets, setNightTargets] = useState<number[]>([])
  const [witchChoice, setWitchChoice] = useState<WitchChoice>(null)
  const [voteSeat, setVoteSeat] = useState<number | null>(null)
  const [gunArming, setGunArming] = useState(false)
  const [showRecap, setShowRecap] = useState(false)

  // ---- WebSocket 房间连接（第一阶段：玩家列表实时同步） ----
  const [playerId] = useState(getOrCreatePlayerId)
  const [socket, setSocket] = useState<RoomSocket | null>(null)
  const [roster, setRoster] = useState<RoomPlayer[]>([])
  const [connState, setConnState] = useState<
    'connecting' | 'open' | 'closed'
  >('connecting')

  // ---- 第二阶段第一步：服务端发牌与身份私密查看 ----
  const [hostPlayerId, setHostPlayerId] = useState<string | null>(null)
  const [onlineStarted, setOnlineStarted] = useState(false)
  const [onlineSeats, setOnlineSeats] = useState<SeatInfo[]>([])
  /** 房主指定的测试身份：playerId -> 角色 key（空对象 = 全部随机发牌）——仅开发者模式可见 */
  const [testAssignments, setTestAssignments] = useState<Record<string, string>>({})
  /** 开发者模式（房主连续点击房间码 5 次，或长按顶部"房间"标题开启）：
   *  默认玩家界面完全隐藏测试功能，保持随机发牌；非房主触发完全无反应 */
  const [devMode, setDevMode] = useState(false)
  const [copied, setCopied] = useState(false)
  // 连续点击房间码计数（仅房主累计）
  const devTapCount = useRef(0)
  const devTapTimer = useRef<number | null>(null)
  // 长按顶部"房间"标题计时（仅房主生效）
  const titleHoldTimer = useRef<number | null>(null)
  const copiedTimer = useRef<number | null>(null)

  /** 复制房间码（普通玩家一键复制，与开发者手势互不干扰） */
  const copyRoomCode = () => {
    const code = roomId ?? ''
    const showCopied = () => {
      setCopied(true)
      if (copiedTimer.current !== null) window.clearTimeout(copiedTimer.current)
      copiedTimer.current = window.setTimeout(() => setCopied(false), 1600)
    }
    if (navigator.clipboard?.writeText) {
      navigator.clipboard.writeText(code).then(showCopied).catch(() => fallbackCopy(code, showCopied))
    } else {
      fallbackCopy(code, showCopied)
    }
  }
  const fallbackCopy = (text: string, done: () => void) => {
    try {
      const ta = document.createElement('textarea')
      ta.value = text
      ta.style.position = 'fixed'
      ta.style.opacity = '0'
      document.body.appendChild(ta)
      ta.select()
      document.execCommand('copy')
      document.body.removeChild(ta)
      done()
    } catch {
      /* 复制失败静默处理 */
    }
  }

  /** 连续点击房间码：5 次开启开发者模式；最前面做房主权限校验，非房主完全无反应 */
  const handleRoomCodeTap = () => {
    if (!isHost) return
    devTapCount.current += 1
    if (devTapTimer.current !== null) window.clearTimeout(devTapTimer.current)
    if (devTapCount.current >= 5) {
      devTapCount.current = 0
      setDevMode(true)
      return
    }
    devTapTimer.current = window.setTimeout(() => {
      devTapCount.current = 0
    }, 1500)
  }

  /** 长按顶部"房间"标题进入开发者模式（同样仅房主生效） */
  const startTitleHold = () => {
    if (!isHost) return
    if (titleHoldTimer.current !== null) return
    titleHoldTimer.current = window.setTimeout(() => {
      setDevMode(true)
    }, 3000)
  }
  const cancelTitleHold = () => {
    if (titleHoldTimer.current !== null) {
      window.clearTimeout(titleHoldTimer.current)
      titleHoldTimer.current = null
    }
  }
  const [myRole, setMyRole] = useState<{
    seat: number
    roleKey: string
    roleName: string
    camp: string
    trtc?: { sdkAppId: number; userSig: string }
  } | null>(null)
  /** 身份弹窗开关：关闭弹窗只隐藏弹窗，不清空 myRole（夜晚角色面板依赖 myRole） */
  const [showRoleModal, setShowRoleModal] = useState(false)
  /** 板子角色列表折叠开关（默认折叠，点击展开，压缩首屏长度） */
  const [showBoardRoles, setShowBoardRoles] = useState(false)
  /** 已发牌座位表折叠开关（游戏开始后默认收起，把屏幕让给游戏主信息；点击展开查看座位） */
  const [showDealtSeats, setShowDealtSeats] = useState(true)
  const [voicePerm, setVoicePerm] = useState<VoicePerm>(EMPTY_VOICE_PERM)
  /** 大厅语音凭证（服务端 join 后下发；开局后以 role 帧 trtc 为准） */
  const [trtcCred, setTrtcCred] = useState<{ sdkAppId: number; userSig: string } | null>(null)
  // 供 socket 消息闭包读取最新身份，避免依赖引用过期
  const myRoleRef = useRef(myRole)
  useEffect(() => {
    myRoleRef.current = myRole
  }, [myRole])
  const [errorMsg, setErrorMsg] = useState<string | null>(null)

  // ---- 第二阶段第二步：夜间私密行动面板 + 统一倒计时 ----
  const [onlinePhase, setOnlinePhase] = useState<'lobby' | 'night' | 'day'>(
    'lobby',
  )
  const [nightDeadline, setNightDeadline] = useState<number | null>(null)
  const [onlineNightIndex, setOnlineNightIndex] = useState(1)
  const [currentPhase, setCurrentPhase] = useState<{
    stepIndex: number
    roleKey?: string
    label?: string
    /** 服务端下发的"渲染指令"：明确告诉前端该弹出哪个角色的操作面板 */
    requiredAction?: string
    disabled?: boolean
  } | null>(null)
  const [nightSubmitted, setNightSubmitted] = useState(false)
  const [wolfPanel, setWolfPanel] = useState<{
    wolfSeats: number[]
    wolfChat: WolfChatItem[]
    wolfVotes: WolfVoteSummary[]
    seats: SeatInfo[]
  } | null>(null)
  const [witchTarget, setWitchTarget] = useState<number | null>(null)
  /** 整局药水状态：解药/毒药是否已用（服务端 witchInfo 下发，用过永久失效） */
  const [witchSaveUsed, setWitchSaveUsed] = useState(false)
  const [witchPoisonUsed, setWitchPoisonUsed] = useState(false)
  const [nightEnded, setNightEnded] = useState<{
    deaths: number[]
    wolfTarget?: number | null
    dayIndex: number
  } | null>(null)
  /** 丘比特连接：仅两位情侣本人收到自己的情侣座位号（私发，其他人收不到） */
  const [loverSeat, setLoverSeat] = useState<number | null>(null)
  /** 丘比特本人收到的连接确认（仅丘比特可见） */
  const [cupidConnected, setCupidConnected] = useState<[number, number] | null>(null)
  // ---- 白天流程状态 ----
  const [dayStage, setDayStage] = useState<
    'talk' | 'vote' | 'result' | 'gun' | 'done' | null
  >(null)
  const [currentSpeaker, setCurrentSpeaker] = useState<number | null>(null)
  /** 投票历史（放逐投票复盘）：服务端全量下发，刷新可恢复 */
  const [voteHistory, setVoteHistory] = useState<
    { dayIndex: number; tally: { seat: number; count: number }[]; exiledSeat: number | null; tie: boolean }[]
  >([])
  /** 投票记录折叠按钮展开状态 */
  const [showVoteHistory, setShowVoteHistory] = useState(false)
  const [speakerDeadline, setSpeakerDeadline] = useState<number | null>(null)
  const [voteDeadline, setVoteDeadline] = useState<number | null>(null)
  // ---- 警长系统状态 ----
  const [sheriffSeat, setSheriffSeat] = useState<number | null>(null)
  /** 警长是否已在本白天抢先发言过（服务端每天白天开始重置；抢先发言后当天不能再发言） */
  const [sheriffHasSpokenThisDay, setSheriffHasSpokenThisDay] = useState(false)
  const [sheriffStage, setSheriffStage] = useState<
    'apply' | 'talk' | 'vote' | 'order' | 'death' | null
  >(null)
  const [sheriffCandidates, setSheriffCandidates] = useState<number[]>([])
  const [sheriffDeadline, setSheriffDeadline] = useState<number | null>(null)
  const [sheriffAliveSeats, setSheriffAliveSeats] = useState<number[]>([])
  const [mySheriffChoice, setMySheriffChoice] = useState<'apply' | 'not' | null>(null)
  const [mySheriffVote, setMySheriffVote] = useState<number | null>(null)
  const [sheriffElectedInfo, setSheriffElectedInfo] = useState<{
    seat: number | null
    name?: string
  } | null>(null)
  const [aliveSeats, setAliveSeats] = useState<number[]>([])
  const [deadSeats, setDeadSeats] = useState<number[]>([])
  const [voteTally, setVoteTally] = useState<{ seat: number; count: number }[]>([])
  // 乌鸦禁言：昨晚被禁言的座位（白天显示 🚫）+ 跳麦提示横幅
  const [mutedSeat, setMutedSeat] = useState<number | null>(null)
  const [skipNotice, setSkipNotice] = useState<{
    seats: number[]
    at: number
  } | null>(null)
  const [voteExiled, setVoteExiled] = useState<number | null>(null)
  const [voteTie, setVoteTie] = useState(false)
  const [gunPanelInfo, setGunPanelInfo] = useState<{
    seat: number
    canGun: boolean
    roleName: string
    shooterName: string
  } | null>(null)
  const [gunShotInfo, setGunShotInfo] = useState<{
    shooter: number
    target: number
    shooterName: string
    shooterRole?: string
    targetName: string
  } | null>(null)
  const [dayVoteTarget, setDayVoteTarget] = useState<number | null>(null)
  const [myGunTarget, setMyGunTarget] = useState<number | null>(null)
  const [votedSeat, setVotedSeat] = useState<number | null>(null)
  // 本地选择状态（提交后清空）
  const [wolfVoteTarget, setWolfVoteTarget] = useState<number | null>(null)
  const [seerTarget, setSeerTarget] = useState<number | null>(null)
  const [onlineWitchChoice, setOnlineWitchChoice] = useState<
    'save' | 'poison' | 'none' | null
  >(null)
  const [witchPoisonTarget, setWitchPoisonTarget] = useState<number | null>(null)
  const [dreamTarget, setDreamTarget] = useState<number | null>(null)
  const [ravenTarget, setRavenTarget] = useState<number | null>(null)
  const [nightmareTarget, setNightmareTarget] = useState<number | null>(null)
  const [wolfQueenTarget, setWolfQueenTarget] = useState<number | null>(null)
  const [demonHunterTarget, setDemonHunterTarget] = useState<number | null>(null)
  const [wolfWitchTarget, setWolfWitchTarget] = useState<number | null>(null)
  const [avatarMap, setAvatarMap] = useState<Record<number, string>>({})
  const [wolfWitchResult, setWolfWitchResult] = useState<{
    target: number
    roleKey: string
    roleName: string
  } | null>(null)
  // 丘比特首夜选情侣（两个目标）
  const [cupidTargets, setCupidTargets] = useState<number[]>([])
  // 觉醒孤独少女首夜选偶像
  const [lonelyGirlTarget, setLonelyGirlTarget] = useState<number | null>(null)
  // 兜底面板通用目标（防御性：任何行动角色未匹配专属面板时也能正常提交）
  const [genericTarget, setGenericTarget] = useState<number | null>(null)
  // 预言家查验结果（服务端私发本人）
  const [seerResult, setSeerResult] = useState<{
    target: number
    camp: 'good' | 'wolf'
    roleName?: string
    rebounded?: boolean
  } | null>(null)
  // 孤独少女变身/继承提示
  const [convertNotice, setConvertNotice] = useState<{
    seat: number
    newRoleName: string
    cause: string
  } | null>(null)
  // 游戏结束（胜利方 + 全部身份复盘）
  const [gameOverInfo, setGameOverInfo] = useState<{
    winner: string
    winnerLabel: string
    roles: { seat: number; nickname: string; roleKey: string; roleName: string }[]
  } | null>(null)
  // 统一倒计时的本地时钟（仅用于渲染同一个服务端时间戳的剩余秒数）
  const [nowMs, setNowMs] = useState(Date.now())

  // 每次状态变化自动持久化
  useEffect(() => {
    saveGame(roomId ?? '', game)
  }, [game, roomId])

  // 连接 WebSocket 房间（server.js）：连接成功即上报昵称，并监听玩家列表广播；断线自动重连
  useEffect(() => {
    const room = roomId ?? 'demo'
    const s = createRoomSocket(room)
    setSocket(s)
    setConnState('connecting')

    const onOpen = () => {
      setConnState('open')
      const msg: ClientMessage = { type: 'join', playerId, nickname }
      s.send(JSON.stringify(msg))
    }
    const onMessage = (event: MessageEvent) => {
      try {
        const data = JSON.parse(String(event.data)) as ServerMessage
        if (data.type === 'trtcCredential') {
          setTrtcCred(data.trtc)
          setVoicePerm(data.voicePerm ?? EMPTY_VOICE_PERM)
        } else if (data.type === 'roster') {
          setRoster(data.players)
          setHostPlayerId(data.hostPlayerId)
          // 服务端统一分配的固定头像：所有玩家视角一致、刷新不变、同房间不重复
          if (Array.isArray(data.players)) {
            const map: Record<number, string> = {}
            for (const p of data.players) {
              if (p.seat != null && p.avatarIdx != null) {
                map[p.seat] = `${import.meta.env.BASE_URL}avatars/avatar-${String(p.avatarIdx).padStart(2, '0')}.jpg`
              }
            }
            setAvatarMap(map)
          }
        } else if (data.type === 'gameStarted') {
          setOnlineStarted(true)
          setOnlineSeats(data.seats)
          setErrorMsg(null)
          setShowRoleModal(false) // 新一局：隐藏上一局残留的身份弹窗，等新 role 帧再弹出
          // 头像保持进入房间时的随机分配（不随开局重洗）
          // 流程串联：发牌完毕服务端自动进入第一夜（随后到达 nightStarted 帧）
          setOnlinePhase('night')
        } else if (data.type === 'role') {
          setMyRole(data)
          setVoicePerm(data.voicePerm ?? EMPTY_VOICE_PERM)
          if (Array.isArray(data.voteHistory)) setVoteHistory(data.voteHistory)
          // 刷新恢复：服务端下发的座位-头像固定映射
          if (Array.isArray(data.avatarBySeat)) {
            const map: Record<number, string> = {}
            for (const a of data.avatarBySeat) {
              if (a.avatarIdx != null) {
                map[a.seat] = `${import.meta.env.BASE_URL}avatars/avatar-${String(a.avatarIdx).padStart(2, '0')}.jpg`
              }
            }
            setAvatarMap(map)
          }
          setShowRoleModal(true) // 收到身份自动弹出查看
          // 刷新后恢复当前阶段快照（否则"结束发言"等交互按钮丢失）
          if (data.phase === 'day') {
            setOnlinePhase('day')
            if (data.dayStage === 'talk' || data.dayStage === 'vote' || data.dayStage === 'result' || data.dayStage === 'gun' || data.dayStage === 'done') setDayStage(data.dayStage)
            if (typeof data.currentSpeaker === 'number') setCurrentSpeaker(data.currentSpeaker)
            if (typeof data.speakerDeadline === 'number') setSpeakerDeadline(data.speakerDeadline)
            if (typeof data.voteDeadline === 'number') setVoteDeadline(data.voteDeadline)
            if (typeof data.sheriffHasSpokenThisDay === 'boolean') setSheriffHasSpokenThisDay(data.sheriffHasSpokenThisDay)
            if (Array.isArray(data.deadSeats)) setDeadSeats(data.deadSeats)
            if (typeof data.sheriffSeat === 'number') setSheriffSeat(data.sheriffSeat)
            if (typeof data.mutedSeat === 'number') setMutedSeat(data.mutedSeat)
            if (typeof data.dayIndex === 'number') {
              setNightEnded({
                deaths: Array.isArray(data.deaths) ? data.deaths : [],
                wolfTarget: null,
                dayIndex: data.dayIndex,
              })
            }
          } else if (data.phase === 'night') {
            setOnlinePhase('night')
            if (typeof data.dayIndex === 'number') setOnlineNightIndex(data.dayIndex)
            if (Array.isArray(data.deadSeats)) setDeadSeats(data.deadSeats)
          }
        } else if (data.type === 'voicePerm') {
          setVoicePerm({
            canSpeak: data.canSpeak,
            canHearWolves: data.canHearWolves,
            isDeadChannel: data.isDeadChannel,
            hearUserIds: data.hearUserIds,
          })
        } else if (data.type === 'error') {
          setErrorMsg(data.message)
        } else if (data.type === 'nightStarted') {
          setOnlinePhase('night')
          setGameOverInfo(null)
          // 夜晚倒计时只以 nightPhase 帧 stepDeadline 为准（每步 60s），绝不用全局兜底 300s
          setOnlineNightIndex(data.nightIndex)
          setNightEnded(null)
          setNightSubmitted(false)
          setCurrentPhase(null)
          setWolfPanel(null)
          setWitchTarget(null)
          setSeerTarget(null)
          setDreamTarget(null)
          setRavenTarget(null)
          setNightmareTarget(null)
          setWolfQueenTarget(null)
          setDemonHunterTarget(null)
          // 乌鸦禁言只影响上一个白天，新夜晚清除
          setMutedSeat(null)
          setSkipNotice(null)
          setWolfWitchTarget(null)
          setWolfWitchResult(null)
          setCupidTargets([])
          setLonelyGirlTarget(null)
          setGenericTarget(null)
          setSeerResult(null)
          setConvertNotice(null)
          // 清理白天流程状态（跨夜出局名单 deadSeats 保留）
          setDayStage(null)
          setCurrentSpeaker(null)
          setSpeakerDeadline(null)
          setVoteDeadline(null)
          setAliveSeats([])
          setVoteTally([])
          setVoteExiled(null)
          setVoteTie(false)
          setGunPanelInfo(null)
          setGunShotInfo(null)
          setDayVoteTarget(null)
          setMyGunTarget(null)
          setVotedSeat(null)
          // 夜晚需要身份判断面板，主动拉取一次（刷新后也能恢复）
          const msg: ClientMessage = { type: 'getRole', playerId }
          s.send(JSON.stringify(msg))
        } else if (data.type === 'nightPhase') {
          setCurrentPhase(data)
          if (typeof data.stepDeadline === 'number') setNightDeadline(data.stepDeadline)
          // 无条件补拉身份：任何夜晚阶段帧到达都确保 myRole 已就绪（消除"身份未同步导致面板不渲染"的时序缺口）
          if (!myRoleRef.current) {
            const msg: ClientMessage = { type: 'getRole', playerId }
            s.send(JSON.stringify(msg))
          }
        } else if (data.type === 'nightActionAccepted') {
          setNightSubmitted(true)
          setCurrentPhase(null)
          setWolfPanel(null)
        } else if (data.type === 'wolfPanel') {
          setWolfPanel(data)
          if (!myRoleRef.current) {
            const msg: ClientMessage = { type: 'getRole', playerId }
            s.send(JSON.stringify(msg))
          }
        } else if (data.type === 'wolfWitchResult') {
          setWolfWitchResult(data)
        } else if (data.type === 'wolfChat') {
          setWolfPanel((prev) =>
            prev
              ? {
                  ...prev,
                  wolfChat: [
                    ...prev.wolfChat,
                    {
                      playerId: data.playerId,
                      nickname: data.nickname,
                      text: data.text,
                      ts: data.ts,
                    },
                  ],
                }
              : prev,
          )
        } else if (data.type === 'wolfVotes') {
          setWolfPanel((prev) => (prev ? { ...prev, wolfVotes: data.votes } : prev))
        } else if (data.type === 'witchInfo') {
          setWitchTarget(data.target)
          setWitchSaveUsed(data.saveUsed)
          setWitchPoisonUsed(data.poisonUsed)
        } else if (data.type === 'seerResult') {
          setSeerResult(data)
        } else if (data.type === 'loverInfo') {
          // 仅情侣本人收到：记录自己的情侣座位
          setLoverSeat(data.partner)
        } else if (data.type === 'cupidConnected') {
          // 仅丘比特本人收到：连接成功确认（不向其他人展示）
          setCupidConnected(data.targets)
        } else if (data.type === 'lonelyGirlConverted') {
          setConvertNotice({
            seat: data.seat,
            newRoleName: data.newRoleName,
            cause: data.cause,
          })
        } else if (data.type === 'gameOver') {
          setGameOverInfo(data)
          setOnlinePhase('day')
          setNightDeadline(null)
          setCurrentPhase(null)
          setWolfPanel(null)
          setDayStage(null)
        } else if (data.type === 'nightEnded') {
          setOnlinePhase('day')
          setNightSubmitted(false)
          setNightDeadline(null)
          setNightEnded(data)
          setCurrentPhase(null)
          setWolfPanel(null)
          setWitchTarget(null)
        } else if (data.type === 'dayStarted') {
          // 白天开始：播报死讯 + 进入对应子阶段
          setOnlinePhase('day')
          setNightEnded({
            deaths: data.deaths,
            wolfTarget: null,
            dayIndex: data.dayIndex,
          })
          setDayStage(data.dayStage)
          setCurrentSpeaker(data.currentSpeaker)
          setSpeakerDeadline(data.speakerDeadline)
          setVoteDeadline(data.voteDeadline)
          setDeadSeats(data.deadSeats)
          setVoteTally([])
          setVoteExiled(null)
          setVoteTie(false)
          setGunPanelInfo(null)
          setGunShotInfo(null)
          setDayVoteTarget(null)
          setMyGunTarget(null)
          setVotedSeat(null)
          // 乌鸦禁言状态：被禁言座位 + 第一位发言者被跳过时提示
          setMutedSeat(data.mutedSeat ?? null)
          if (data.skippedSeats && data.skippedSeats.length > 0) {
            setSkipNotice({ seats: data.skippedSeats, at: Date.now() })
          }
          // 警长状态：正常发言阶段清理竞选 UI
          setSheriffStage(null)
          setSheriffCandidates([])
          setSheriffDeadline(null)
          setSheriffElectedInfo(null)
          if (typeof data.sheriffSeat === 'number') setSheriffSeat(data.sheriffSeat)
          // 每天白天开始：重置警长"抢先发言"标记
          setSheriffHasSpokenThisDay(data.sheriffHasSpokenThisDay ?? false)
        } else if (data.type === 'speakerChanged') {
          // 当前发言者顺延：更新发言者与个人倒计时
          setCurrentSpeaker(data.currentSpeaker)
          setSpeakerDeadline(data.speakerDeadline)
          if (data.sheriffHasSpokenThisDay !== undefined) {
            setSheriffHasSpokenThisDay(data.sheriffHasSpokenThisDay)
          }
        } else if (data.type === 'speakerSkipped') {
          // 轮到被禁言玩家 -> 自动跳过，屏幕中央提示
          setSkipNotice({ seats: data.skippedSeats, at: Date.now() })
          setCurrentSpeaker(data.currentSpeaker)
        } else if (data.type === 'voteStarted') {
          setDayStage('vote')
          setVoteDeadline(data.voteDeadline)
          setAliveSeats(data.aliveSeats)
          setDayVoteTarget(null)
          setVotedSeat(null)
          setCurrentSpeaker(null)
          setSpeakerDeadline(null)
        } else if (data.type === 'voteResult') {
          setDayStage('result')
          setVoteTally(data.tally)
          setVoteExiled(data.exiledSeat)
          setVoteTie(data.tie)
          if (Array.isArray(data.history)) setVoteHistory(data.history)
        } else if (data.type === 'gunPanel') {
          setDayStage('gun')
          setGunPanelInfo(data)
          setMyGunTarget(null)
        } else if (data.type === 'gunShot') {
          setGunShotInfo(data)
          setDayStage('result')
          setGunPanelInfo(null)
        } else if (data.type === 'sheriffStage') {
          // 警长竞选/警徽各子阶段
          setOnlinePhase('day')
          setSheriffStage(data.stage)
          setSheriffCandidates(data.candidates)
          setSheriffDeadline(data.deadline)
          setSheriffAliveSeats(data.aliveSeats)
          if (typeof data.sheriffSeat === 'number') setSheriffSeat(data.sheriffSeat)
        } else if (data.type === 'sheriffRoster') {
          setSheriffCandidates(data.candidates)
        } else if (data.type === 'sheriffElected') {
          setSheriffElectedInfo({ seat: data.seat, name: data.name })
          if (data.seat === null) setSheriffStage(null)
        } else if (data.type === 'sheriffChanged') {
          setSheriffSeat(data.seat)
        } else if (data.type === 'sheriffOrderPanel') {
          setSheriffStage('order')
        } else if (data.type === 'sheriffGiveawayPanel') {
          setSheriffStage('death')
          setSheriffAliveSeats(data.aliveSeats)
        }
      } catch {
        // 忽略无法解析的消息
      }
    }
    const onClosed = () => setConnState('closed')

    s.addEventListener('open', onOpen)
    s.addEventListener('message', onMessage)
    s.addEventListener('close', onClosed)
    s.addEventListener('error', onClosed)

    return () => {
      s.removeEventListener('open', onOpen)
      s.removeEventListener('message', onMessage)
      s.removeEventListener('close', onClosed)
      s.removeEventListener('error', onClosed)
      s.close()
    }
  }, [roomId, playerId, nickname])

  const nightSteps: NightStepConfig[] = currentBoard.nightOrder.map(
    (key) =>
      NIGHT_STEPS.find((step) => step.key === key) ?? {
        key,
        name: key,
        prompt: `请 ${key} 睁眼`,
        needTarget: false,
        targetCount: 0,
        canSkip: false,
      },
  )
  const currentStep = nightSteps[game.nightIndex]
  const isLastStep = game.nightIndex >= nightSteps.length - 1
  const seats = Array.from({ length: seatCount }, (_, index) => index + 1)
  const exiledRole =
    game.exiledSeat !== null
      ? game.deal.find((role) => role.seat === game.exiledSeat)
      : undefined
  const gunActionLabel = exiledRole?.key === 'demon_hunter' ? '狩猎' : '开枪'

  const startGame = () => {
    setGame({
      ...EMPTY_GAME,
      deal: shuffleDeal(currentBoard),
      phase: 'night',
      dayCount: 1,
    })
    setNightTargets([])
    setWitchChoice(null)
    setVoteSeat(null)
    setGunArming(false)
    setRevealSeat(null)
    setShowRecap(false)
  }

  const resetGame = () => {
    clearSavedGame(roomId ?? '')
    setGame({ ...EMPTY_GAME })
    setNightTargets([])
    setWitchChoice(null)
    setVoteSeat(null)
    setGunArming(false)
    setRevealSeat(null)
    setShowRecap(false)
  }

  // 夜晚面板：点击座位选择目标（再点一次取消）
  const handleSeatSelect = (seat: number) => {
    if (!currentStep) return
    if (currentStep.key === 'witch') {
      if (witchChoice === 'heal' || witchChoice === 'poison') {
        setNightTargets([seat])
      }
      return
    }
    if (currentStep.targetCount === 2) {
      setNightTargets((prev) =>
        prev.includes(seat)
          ? prev.filter((item) => item !== seat)
          : prev.length >= 2
            ? prev
            : [...prev, seat],
      )
    } else {
      setNightTargets((prev) => (prev.includes(seat) ? [] : [seat]))
    }
  }

  const buildAction = (): NightAction => {
    const step = currentStep
    if (step.key === 'witch') {
      const target = nightTargets[0] ?? null
      if (witchChoice === 'none') {
        return {
          stepKey: step.key,
          stepName: step.name,
          note: '女巫没有用药',
          target: null,
          kills: false,
          saves: false,
        }
      }
      if (witchChoice === 'heal') {
        return {
          stepKey: step.key,
          stepName: step.name,
          note: `女巫用解药救了 ${target}号玩家`,
          target,
          kills: false,
          saves: true,
        }
      }
      return {
        stepKey: step.key,
        stepName: step.name,
        note: `女巫用毒药毒了 ${target}号玩家`,
        target,
        kills: true,
        saves: false,
      }
    }
    if (step.needTarget) {
      const targets = nightTargets
      if (step.targetCount === 2) {
        return {
          stepKey: step.key,
          stepName: step.name,
          note: `${step.name}选择了 ${targets[0]}号 和 ${targets[1]}号 玩家成为情侣`,
          target: null,
          kills: false,
          saves: false,
        }
      }
      const target = targets[0] ?? null
      if (step.key === 'werewolf') {
        return {
          stepKey: step.key,
          stepName: step.name,
          note: `狼人刀了 ${target}号玩家`,
          target,
          kills: true,
          saves: false,
        }
      }
      return {
        stepKey: step.key,
        stepName: step.name,
        note: `${step.name}选择了 ${target}号玩家`,
        target,
        kills: false,
        saves: false,
      }
    }
    return {
      stepKey: step.key,
      stepName: step.name,
      note: `${step.name}确认`,
      target: null,
      kills: false,
      saves: false,
    }
  }

  const handleAdvance = (action: NightAction) => {
    setGame((prev) => {
      const nextLog = [...prev.nightLog, action]
      if (isLastStep) {
        // 夜晚流程全部走完 -> 天亮了，记录死讯并进入白天
        return {
          ...prev,
          nightLog: nextLog,
          phase: 'day',
          deaths: computeDeaths(nextLog),
          dayStage: 'deaths',
          exiledSeat: null,
          exileHasLastWords: null,
        }
      }
      return { ...prev, nightLog: nextLog, nightIndex: prev.nightIndex + 1 }
    })
    setNightTargets([])
    setWitchChoice(null)
    setVoteSeat(null)
    setGunArming(false)
  }

  const handleNextStep = () => {
    if (!currentStep) return
    if (currentStep.key === 'witch') {
      if (witchChoice === null) return
      if (witchChoice === 'none') {
        handleAdvance(buildAction())
        return
      }
      if (nightTargets.length < 1) return
      handleAdvance(buildAction())
      return
    }
    if (currentStep.needTarget && nightTargets.length < currentStep.targetCount) {
      return
    }
    handleAdvance(buildAction())
  }

  const handleSkipStep = () => {
    const step = currentStep
    if (!step) return
    handleAdvance({
      stepKey: step.key,
      stepName: step.name,
      note: `${step.name}没有使用技能`,
      target: null,
      kills: false,
      saves: false,
    })
  }

  const canNext = (() => {
    if (!currentStep) return false
    if (currentStep.key === 'witch') {
      if (witchChoice === null) return false
      if (witchChoice === 'none') return true
      return nightTargets.length >= 1
    }
    if (!currentStep.needTarget) return true
    return nightTargets.length >= currentStep.targetCount
  })()

  // ---- 白天流程 ----

  const startVote = () => {
    setGame((prev) => ({ ...prev, dayStage: 'vote' }))
    setVoteSeat(null)
  }

  const cancelVote = () => {
    setGame((prev) => ({ ...prev, dayStage: 'deaths' }))
    setVoteSeat(null)
  }

  const confirmExile = () => {
    if (voteSeat === null) return
    setGame((prev) => ({ ...prev, exiledSeat: voteSeat, dayStage: 'exile' }))
    setVoteSeat(null)
    setGunArming(false)
  }

  const markTie = () => {
    setGame((prev) => ({
      ...prev,
      dayStage: 'summary',
      dayLog: [...prev.dayLog, '投票平票，无人出局'],
    }))
  }

  const handleLastWords = (has: boolean) => {
    if (game.exiledSeat === null) return
    setGame((prev) => {
      const role = prev.deal.find((item) => item.seat === prev.exiledSeat)
      const canGun =
        role !== undefined &&
        (role.key === 'hunter' ||
          role.key === 'wolf_king' ||
          role.key === 'demon_hunter')
      return {
        ...prev,
        exileHasLastWords: has,
        dayLog: [
          ...prev.dayLog,
          `${prev.exiledSeat}号玩家被放逐（${has ? '有遗言' : '无遗言'}）`,
        ],
        dayStage: canGun ? 'gun' : 'summary',
      }
    })
    setGunArming(false)
  }

  const handleGunShoot = (target: number) => {
    if (game.exiledSeat === null) return
    const actionWord = exiledRole?.key === 'demon_hunter' ? '狩猎' : '开枪'
    setGame((prev) => ({
      ...prev,
      dayStage: 'summary',
      dayLog: [
        ...prev.dayLog,
        `${prev.exiledSeat}号玩家（${exiledRole?.name ?? '该角色'}）${actionWord}带走了 ${target}号玩家`,
      ],
    }))
    setGunArming(false)
  }

  const handleGunNoShoot = () => {
    if (game.exiledSeat === null) return
    const actionWord = exiledRole?.key === 'demon_hunter' ? '狩猎' : '开枪'
    setGame((prev) => ({
      ...prev,
      dayStage: 'summary',
      dayLog: [
        ...prev.dayLog,
        `${prev.exiledSeat}号玩家（${exiledRole?.name ?? '该角色'}）没有${actionWord}`,
      ],
    }))
    setGunArming(false)
  }

  // 白天处理完成 -> 进入黑夜（保留发牌/天数/白天记录，夜晚记录清空以便计算新死讯）
  const enterNight = () => {
    setGame((prev) => ({
      ...prev,
      phase: 'night',
      nightIndex: 0,
      nightLog: [],
      deaths: [],
      dayStage: 'deaths',
      exiledSeat: null,
      exileHasLastWords: null,
      dayCount: prev.dayCount + 1,
    }))
    setNightTargets([])
    setWitchChoice(null)
    setVoteSeat(null)
    setGunArming(false)
  }

  const me = roster.find((player) => player.playerId === playerId)

  const toggleReady = () => {
    if (!socket || !me) return
    const msg: ClientMessage = { type: 'ready', playerId, ready: !me.ready }
    socket.send(JSON.stringify(msg))
  }

  // ---- 第二阶段第一步：房主开始游戏（服务端发牌）/ 玩家私密查看身份 ----

  const isHost = hostPlayerId !== null && playerId === hostPlayerId

  const startOnlineGame = () => {
    if (!socket || !isHost) return
    const assignments = Object.entries(testAssignments)
      .filter(([, roleKey]) => roleKey !== '')
      .map(([pid, roleKey]) => ({ playerId: pid, roleKey }))
    const msg: ClientMessage = {
      type: 'start',
      playerId,
      board: currentBoard,
      assignments,
      devMode,
    }
    socket.send(JSON.stringify(msg))
  }

  const requestMyRole = () => {
    if (!socket) return
    const msg: ClientMessage = { type: 'getRole', playerId }
    socket.send(JSON.stringify(msg))
  }

  // ---- 第二阶段第二步：夜晚行动 ----

  // 统一倒计时：所有玩家用同一个服务端时间戳（夜晚/白天发言/白天投票）计算剩余秒数，
  // 本地 setInterval 只负责刷新显示，不参与任何流程推进。
  useEffect(() => {
    if (
      nightDeadline === null &&
      speakerDeadline === null &&
      voteDeadline === null &&
      sheriffDeadline === null
    )
      return
    setNowMs(Date.now())
    const timer = setInterval(() => setNowMs(Date.now()), 200)
    return () => clearInterval(timer)
  }, [nightDeadline, speakerDeadline, voteDeadline, sheriffDeadline])

  const remainSec =
    nightDeadline !== null ? Math.max(0, Math.ceil((nightDeadline - nowMs) / 1000)) : null
  const talkRemainSec =
    speakerDeadline !== null
      ? Math.max(0, Math.ceil((speakerDeadline - nowMs) / 1000))
      : null
  const voteRemainSec =
    voteDeadline !== null ? Math.max(0, Math.ceil((voteDeadline - nowMs) / 1000)) : null
  const sheriffRemainSec =
    sheriffDeadline !== null ? Math.max(0, Math.ceil((sheriffDeadline - nowMs) / 1000)) : null

  const isWolf = myRole?.camp === 'wolf' || myRole?.roleKey === 'lonely_girl'
  const isMyPhase =
    currentPhase !== null &&
    ((currentPhase.roleKey === 'wolf' && isWolf) ||
      (currentPhase.roleKey !== 'wolf' && myRole?.roleKey === currentPhase.roleKey))
  const phaseDisabled = Boolean(currentPhase?.disabled)

  const startOnlineNight = () => {
    if (!socket || !isHost) return
    const msg: ClientMessage = { type: 'startNight', playerId }
    socket.send(JSON.stringify(msg))
  }

  const sendWolfChat = (text: string) => {
    if (!socket) return
    const msg: ClientMessage = { type: 'wolfChat', playerId, text }
    socket.send(JSON.stringify(msg))
  }

  const submitWolfVote = () => {
    if (!socket) return
    const msg: ClientMessage = {
      type: 'wolfVote',
      playerId,
      target: wolfVoteTarget,
    }
    socket.send(JSON.stringify(msg))
    setWolfVoteTarget(null)
  }

  const submitNightTarget = (roleKey: string, target: number | null) => {
    if (!socket || target === null) return
    const msg: ClientMessage = { type: 'nightTarget', playerId, roleKey, target }
    socket.send(JSON.stringify(msg))
  }
  const submitCupidAction = () => {
    if (!socket || cupidTargets.length !== 2) return
    const msg: ClientMessage = {
      type: 'cupidAction',
      playerId,
      targets: [cupidTargets[0], cupidTargets[1]] as [number, number],
    }
    socket.send(JSON.stringify(msg))
  }
  const submitWitchAction = () => {
    if (!socket || onlineWitchChoice === null) return
    if (onlineWitchChoice === 'poison' && witchPoisonTarget === null) return
    const msg: ClientMessage = {
      type: 'witchAction',
      playerId,
      choice: onlineWitchChoice,
      target: onlineWitchChoice === 'poison' ? witchPoisonTarget ?? undefined : undefined,
    }
    socket.send(JSON.stringify(msg))
    setOnlineWitchChoice(null)
    setWitchPoisonTarget(null)
  }

  /** 提交白天投票（服务端计票）；target 为 null 时弃票 */
  const submitDayVote = () => {
    if (!socket || dayVoteTarget === null) return
    const msg: ClientMessage = { type: 'dayVote', playerId, target: dayVoteTarget }
    socket.send(JSON.stringify(msg))
    setVotedSeat(dayVoteTarget)
  }

  /** 被放逐的猎人/狼王/猎魔人提交带走目标 */
  const submitGunTarget = () => {
    if (!socket || myGunTarget === null) return
    const msg: ClientMessage = { type: 'gunTarget', playerId, target: myGunTarget }
    socket.send(JSON.stringify(msg))
  }

  // ---- 警长系统发送 ----

  /** 上警/不上警 */
  const submitSheriffApply = (apply: boolean) => {
    if (!socket) return
    const msg: ClientMessage = { type: 'sheriffApply', playerId, apply }
    socket.send(JSON.stringify(msg))
    setMySheriffChoice(apply ? 'apply' : 'not')
  }

  /** 警上退水 */
  const submitSheriffWithdraw = () => {
    if (!socket) return
    const msg: ClientMessage = { type: 'sheriffWithdraw', playerId }
    socket.send(JSON.stringify(msg))
  }

  /** 警下投票选警长 */
  const submitSheriffVote = (target: number) => {
    if (!socket) return
    const msg: ClientMessage = { type: 'sheriffVote', playerId, target }
    socket.send(JSON.stringify(msg))
    setMySheriffVote(target)
  }

  /** 警长选择发言方向 */
  const submitSheriffOrder = (dir: string) => {
    if (!socket) return
    const msg: ClientMessage = { type: 'sheriffOrder', playerId, dir }
    socket.send(JSON.stringify(msg))
  }

  /** 警长出局后：移交（target=座位）或撕毁（target=null）警徽 */
  const submitSheriffGiveaway = (target: number | null) => {
    if (!socket) return
    const msg: ClientMessage = { type: 'sheriffGiveaway', playerId, target }
    socket.send(JSON.stringify(msg))
  }

  const wolfTeammates =
    wolfPanel !== null ? wolfPanel.wolfSeats.filter((seat) => seat !== myRole?.seat) : []

  /** 狼人刀口按钮数据源：wolfPanel 自带座位 -> 全局座位表 -> 按人数兜底生成，保证按钮一定渲染 */
  const wolfSeatList: SeatInfo[] =
    (wolfPanel?.seats && wolfPanel.seats.length > 0
      ? wolfPanel.seats
      : onlineSeats.length > 0
        ? onlineSeats
        : Array.from({ length: currentBoard.playerCount }, (_, i) => ({
            seat: i + 1,
            playerId: '',
            nickname: '',
          }))).filter((s) => !deadSeats.includes(s.seat))

  const wolfQuickPhrases = (): string[] => {
    const target = wolfVoteTarget !== null ? `${wolfVoteTarget}号` : 'X号'
    return [`我刀 ${target}`, '我同意', '你们刀谁？', '平安夜', '听你们的']
  }

  const revealedRole =
    revealSeat !== null ? game.deal.find((role) => role.seat === revealSeat) : null

  // 开局条件（在线大厅与本地测试共用）：开发者模式 3 人起，正式局必须满员；所有非房主已准备
  const allJoined = devMode
    ? roster.length >= 3 && roster.length <= currentBoard.playerCount
    : roster.length === currentBoard.playerCount
  const allReady =
    roster.length > 0 &&
    roster.filter((p) => p.playerId !== hostPlayerId).every((p) => p.ready)
  const canStart = connState === 'open' && allJoined && allReady
  /** 座位网格：按板子人数铺 1..N 座位，玩家按 seat 填入 */
  /** 座位网格：列优先排列（左列 1..half 从上到下，右列 half+1..N 从上到下） */
  const seatGrid = (() => {
    const n = currentBoard.playerCount
    const half = Math.ceil(n / 2)
    const arr: number[] = []
    for (let i = 0; i < half; i++) {
      arr.push(i + 1)
      if (i + 1 + half <= n) arr.push(i + 1 + half)
    }
    return arr
  })()
  // 头像由服务端统一分配（avatarIdx），roster/role 帧到达时构建 avatarMap，此处不再本地随机
  const seatByNum = new Map<number, RoomPlayer>()
  for (const p of roster) {
    if (p.seat != null) seatByNum.set(p.seat, p)
  }
  /** 存活座位列表（行动面板专用）：过滤已死亡玩家，保证不会出现死人的按钮 */
  const aliveSeatInfo = onlineSeats.filter((s) => !deadSeats.includes(s.seat))

  return (
    <div className={`flex w-full flex-col bg-slate-950 text-slate-100 ${onlineStarted ? 'h-dvh overflow-hidden px-3 py-3' : 'min-h-dvh px-6 py-10'}`}>
      <div className={`mx-auto w-full max-w-[480px] ${onlineStarted ? '' : 'pb-40'}`}>
        {/* 孤独少女变身/继承提示 */}
        {convertNotice && (
          <div className="mb-4 rounded-2xl border border-sky-500/40 bg-sky-500/10 p-4 text-center">
            <p className="text-sm font-bold text-sky-300">
              {convertNotice.seat}号 觉醒孤独少女的偶像出局（{convertNotice.cause === 'exile' ? '被放逐' : '其他原因'}），
              她{convertNotice.cause === 'exile' ? '变身为狼人，加入狼队' : `继承了偶像的身份：「${convertNotice.newRoleName}」`}
            </p>
          </div>
        )}
        {/* 游戏结束：胜利横幅 + 全部身份复盘 */}
        {gameOverInfo && (
          <div className="mb-4 rounded-2xl border-2 border-amber-500/60 bg-slate-900 p-5 text-center">
            <p className="text-2xl font-black text-amber-400">🏁 {gameOverInfo.winnerLabel}胜利！</p>
            <p className="mt-2 text-xs text-slate-400">本局所有玩家身份（复盘）</p>
            <div className="mt-3 grid grid-cols-2 gap-2">
              {gameOverInfo.roles.map((r) => (
                <div
                  key={r.seat}
                  className={`rounded-xl border p-2 text-left ${
                    deadSeats.includes(r.seat)
                      ? 'border-slate-800 bg-slate-950/60 opacity-70'
                      : 'border-slate-700 bg-slate-950'
                  }`}
                >
                  <p className="text-xs text-slate-400">
                    {r.seat}号 {r.nickname}
                    {deadSeats.includes(r.seat) ? '（已出局）' : ''}
                  </p>
                  <p className="text-sm font-bold text-slate-100">
                    {r.roleName}
                    {r.roleKey === 'cursed_fox' && ' 🦊'}
                    {r.roleKey === 'cupid' && ' ❤'}
                    {r.roleKey === 'lonely_girl' && ' ✨'}
                  </p>
                </div>
              ))}
            </div>
          </div>
        )}
        <div className="mb-3 flex items-center justify-between">
          <Link
            to="/"
            className="text-sm text-slate-400 transition hover:text-slate-200"
          >
            ← 退出房间
          </Link>
          {isDemo && (
            <span className="rounded-full bg-slate-800 px-3 py-1 text-xs text-slate-300">
              测试环境
            </span>
          )}
        </div>

        <h1
          className="select-none text-2xl font-bold"
          onPointerDown={startTitleHold}
          onPointerUp={cancelTitleHold}
          onPointerLeave={cancelTitleHold}
          onPointerCancel={cancelTitleHold}
        >
          房间
        </h1>
        {!onlineStarted && (
          <>
        {/* 顶部信息条：房间码/复制/昵称 + 板子名/查看角色 —— 压缩为两行，不占首屏 */}
        <div className="mt-4 flex flex-wrap items-center gap-x-3 gap-y-1.5">
          <span className="text-xs text-slate-400">房间码</span>
          <button type="button" onClick={copyRoomCode} className="flex items-center gap-2">
            <span
              onClick={handleRoomCodeTap}
              className="text-lg font-black tracking-[0.15em] text-amber-400"
            >
              {roomId?.toUpperCase()}
            </span>
            <span
              className={`rounded-md px-2 py-0.5 text-xs font-bold ${
                copied
                  ? 'bg-emerald-500 text-slate-950'
                  : 'bg-amber-500/20 text-amber-300'
              }`}
            >
              {copied ? '已复制 ✓' : '复制'}
            </span>
          </button>
          <span className="ml-auto text-xs text-slate-400">
            我的昵称：<span className="text-slate-100">{nickname}</span>
          </span>
        </div>
        {copied && (
          <p className="mt-1 text-xs font-medium text-emerald-400">房间码已复制到剪贴板</p>
        )}
        {devMode && (
          <div className="mt-2 flex items-center justify-between rounded-lg border border-amber-500/40 bg-amber-500/10 px-3 py-1.5">
            <p className="text-xs font-medium text-amber-300">🛠 开发者模式已开启（仅房主可见）</p>
            <button
              type="button"
              onClick={() => setDevMode(false)}
              className="rounded bg-amber-500 px-2 py-0.5 text-xs font-bold text-slate-950 active:scale-95"
            >
              退出开发者模式
            </button>
          </div>
        )}

        {/* 板子名 + 查看角色 */}
        <div className="mt-3 flex items-center justify-between">
          <p className="text-sm font-bold text-amber-400">
            {currentBoard.name}（{currentBoard.playerCount} 人）
          </p>
          <button
            type="button"
            onClick={() => setShowBoardRoles((v) => !v)}
            className="rounded-lg border border-amber-500/30 bg-amber-500/10 px-2.5 py-1 text-xs font-bold text-amber-300 active:scale-95"
          >
            {showBoardRoles ? '收起角色' : '查看角色'}
          </button>
        </div>
        {showBoardRoles && (
          <p className="mt-2 text-xs leading-relaxed text-slate-300">
            {currentBoard.roles.length > 0
              ? `包含：${roleList}`
              : '包含：暂无配置（自定义板子功能待开发）'}
          </p>
        )}
          </>
        )}

        {errorMsg && (
          <div className="mt-4 flex items-center justify-between gap-3 rounded-xl border border-rose-500/40 bg-rose-500/10 px-4 py-3">
            <p className="text-sm leading-relaxed text-rose-300">{errorMsg}</p>
            <button
              type="button"
              onClick={() => setErrorMsg(null)}
              className="shrink-0 text-lg text-rose-300"
            >
              ✕
            </button>
          </div>
        )}

        {!onlineStarted && (
                <section className="mt-8">
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-medium text-slate-400">
              座位表（{roster.length}/{currentBoard.playerCount} 人已入座）
            </h2>
            <span
              className={`text-xs ${
                connState === 'open'
                  ? 'text-emerald-400'
                  : connState === 'connecting'
                    ? 'text-amber-400'
                    : 'text-rose-400'
              }`}
            >
              {connState === 'open'
                ? '已连接'
                : connState === 'connecting'
                  ? '连接中…'
                  : '连接断开，正在重连…'}
            </span>
          </div>
          <div className="mt-2 grid grid-cols-2 gap-2">
            {seatGrid.map((seat) => {
              const player = seatByNum.get(seat)
              const meSeat = roster.find((p) => p.playerId === playerId)?.seat ?? null
              return (
                <div
                  key={seat}
                  onClick={() => {
                    // 开局前点击空位换座；已入座的座位不可点
                    if (onlineStarted || !socket || !playerId) return
                    if (player || meSeat == null || meSeat === seat) return
                    socket.send(JSON.stringify({ type: 'changeSeat', playerId, seat }))
                  }}
                  className={`flex items-center gap-2 rounded-xl border px-2 py-1.5 ${
                    player
                      ? 'border-slate-700 bg-slate-900'
                      : onlineStarted
                        ? 'border-dashed border-slate-800 bg-slate-950/50'
                        : 'cursor-pointer border-dashed border-slate-600 bg-slate-900/60 transition hover:border-amber-500/60'
                  }`}
                >
                  {/* 头像框：只有已入座玩家显示头像，空位仅显示座位号 */}
                  <div className="flex h-11 w-11 shrink-0 items-center justify-center overflow-hidden rounded-full border border-slate-600 bg-slate-800">
                    {player ? (
                      player.avatarUrl ? (
                        <img
                          src={player.avatarUrl}
                          alt={`${player.nickname} 的头像`}
                          className="h-full w-full object-cover"
                        />
                      ) : avatarMap[seat] ? (
                        <img
                          src={avatarMap[seat]}
                          alt={`${seat}号头像`}
                          className="h-full w-full object-cover"
                        />
                      ) : (
                        <span className="text-base font-black text-slate-300">
                          {seat}
                        </span>
                      )
                    ) : (
                      <span className="text-base font-black text-slate-600">
                        {seat}
                      </span>
                    )}
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-1">
                      <span className="truncate text-sm font-bold text-slate-100">
                        {player ? player.nickname : '空位'}
                      </span>
                      {player?.playerId === hostPlayerId && (
                        <span className="shrink-0 rounded bg-amber-500/20 px-1 text-[10px] font-bold text-amber-400">
                          房主
                        </span>
                      )}
                      {player?.playerId === playerId && (
                        <span className="shrink-0 text-[10px] text-slate-500">
                          （我）
                        </span>
                      )}
                    </div>
                    <p
                      className={`mt-0.5 text-xs ${
                        player
                          ? player.ready
                            ? 'text-emerald-400'
                            : 'text-slate-500'
                          : 'text-slate-600'
                      }`}
                    >
                      {player
                        ? player.ready
                          ? '已准备'
                          : '未准备'
                        : onlineStarted
                          ? '等待加入'
                          : '点击换座'}
                    </p>
                  </div>
                </div>
              )
            })}
          </div>
          {roster.length === 0 && (
            <p className="mt-3 rounded-xl border border-dashed border-slate-700 px-4 py-3 text-center text-sm text-slate-500">
              等待玩家加入…（另一台设备或新窗口输入同一房间码即可看到）
            </p>
          )}

          {/* 底部操作栏：fixed 固定吸底，任何滚动位置都可见可操作 */}
          <div className="fixed inset-x-0 bottom-0 z-40 border-t border-slate-800 bg-slate-950/95 px-4 pb-4 pt-3 backdrop-blur">
            <div className="mx-auto w-full max-w-[480px]">
              <div className="flex gap-2">
                {me && (
                  <button
                    type="button"
                    onClick={toggleReady}
                    disabled={connState !== 'open'}
                    className={`flex-1 rounded-2xl py-3 text-base font-bold transition active:scale-95 disabled:cursor-not-allowed disabled:opacity-40 ${
                      me.ready
                        ? 'bg-slate-700 text-slate-100'
                        : 'bg-emerald-500 text-slate-950'
                    }`}
                  >
                    {me.ready ? '取消准备' : '准备'}
                  </button>
                )}
                {isHost && (
                  <button
                    type="button"
                    onClick={startOnlineGame}
                    disabled={!canStart}
                    className="flex-1 rounded-2xl bg-amber-500 py-3 text-base font-bold text-slate-950 shadow-lg shadow-amber-500/30 transition active:scale-95 disabled:cursor-not-allowed disabled:opacity-40"
                  >
                    开始游戏（服务端发牌）
                  </button>
                )}
              </div>
              <p className="mt-1.5 text-center text-xs text-slate-500">
                {isHost
                  ? !allJoined
                    ? devMode
                      ? `开发者模式：还需 ${Math.max(0, 3 - roster.length)} 人即可开始`
                      : `等待玩家加入…（还需 ${currentBoard.playerCount - roster.length} 人）`
                    : !allReady
                      ? '等待玩家准备…'
                      : '人数已满，全部就绪，可以开始！'
                  : roster.length > 0
                    ? '等待房主开始游戏…'
                    : '等待玩家加入…'}
              </p>
            </div>
          </div>
        </section>
        )}

        {/* 本地测试面板入口（仅演示模式）：在线开局的准备/开始按钮已在上面吸底操作栏 */}
        {isDemo && !onlineStarted && (
          <div className="mt-8 flex flex-col gap-3">
            <button
              type="button"
              onClick={startGame}
              className="w-full rounded-2xl border border-slate-700 py-2 text-sm font-bold text-slate-300 transition active:scale-95"
            >
              进入本地测试面板（单人法官）
            </button>
          </div>
        )}

        {onlineStarted && (
          <section className="mt-8">
            <div className="flex items-center justify-between">
              <button
                type="button"
                onClick={() => setShowDealtSeats((v) => !v)}
                className="flex items-center gap-1.5 text-sm font-medium text-slate-400 active:scale-95"
              >
                {showDealtSeats ? '▾' : '▸'} 已发牌 · 座位表
              </button>
              <span className="text-xs text-emerald-400">
                {onlineSeats.length} 名玩家入座
              </span>
            </div>
            {showDealtSeats && (
              <div className="mt-2 grid max-h-[47dvh] grid-cols-2 gap-1.5 overflow-y-auto pr-0.5">
                {seatGrid.map((seatNum) => {
                  const s = seatByNum.get(seatNum)
                  const isDead = deadSeats.includes(seatNum)
                  return (
                    <div
                      key={seatNum}
                      className={`flex items-center gap-2 rounded-xl border px-2 py-1.5 ${
                        isDead
                          ? 'border-slate-800/50 bg-slate-900/40 opacity-60'
                          : s
                            ? 'border-slate-700 bg-slate-900'
                            : 'border-dashed border-slate-800 bg-slate-950/50'
                      }`}
                    >
                      <div className="flex h-11 w-11 shrink-0 items-center justify-center overflow-hidden rounded-full border border-slate-600 bg-slate-800">
                        {s ? (
                          s.avatarUrl ? (
                            <img
                              src={s.avatarUrl}
                              alt={`${s.nickname} 的头像`}
                              className="h-full w-full object-cover"
                            />
                          ) : avatarMap[seatNum] ? (
                            <img
                              src={avatarMap[seatNum]}
                              alt={`${seatNum}号头像`}
                              className="h-full w-full object-cover"
                            />
                          ) : (
                            <span className="text-base font-black text-slate-300">
                              {seatNum}
                            </span>
                          )
                        ) : (
                          <span className="text-base font-black text-slate-600">
                            {seatNum}
                          </span>
                        )}
                      </div>
                      <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-center gap-1">
                          <span className="truncate text-sm font-bold text-slate-100">
                            {isDead ? '已出局' : s ? s.nickname : '空位'}
                          </span>
                          {s?.playerId === playerId && !isDead && (
                            <span className="text-xs text-slate-500">（我）</span>
                          )}
                        </div>
                        <div className="mt-0.5 flex flex-wrap items-center gap-1 text-[11px]">
                          {s?.seat === sheriffSeat && (
                            <span className="font-bold text-amber-300">👑 警长</span>
                          )}
                          {mutedSeat === seatNum && onlinePhase === 'day' && (
                            <span className="font-bold text-rose-300">
                              🚫{dayStage === 'vote' ? '+1票' : '禁言'}
                            </span>
                          )}
                          {isDead && <span className="text-slate-500">💀 已出局</span>}
                        </div>
                      </div>
                    </div>
                  )
                })}
              </div>
            )}
            {myRole && (
              <button
                type="button"
                onClick={requestMyRole}
                className="mt-2 w-full rounded-xl bg-emerald-500 px-3 py-1 text-xs font-bold text-slate-950 transition active:scale-95"
              >
                查看我的身份
              </button>
            )}
            {isHost && onlinePhase === 'lobby' && devMode && (
              <div className="mt-2 flex flex-col gap-1.5">
                {onlineSeats.map((s) => (
                  <div key={s.playerId} className="flex items-center justify-between gap-2">
                    <span className="text-xs text-slate-500">
                      {s.seat}号 {s.nickname}
                    </span>
                    <select
                      value={testAssignments[s.playerId] ?? ''}
                      onChange={(e) => {
                        const value = e.target.value
                        setTestAssignments((prev) => {
                          const next = { ...prev }
                          if (value) {
                            next[s.playerId] = value
                          } else {
                            delete next[s.playerId]
                          }
                          return next
                        })
                      }}
                      className="w-40 rounded-lg border border-slate-700 bg-slate-800 px-2 py-1 text-xs text-slate-200"
                    >
                      <option value="">随机</option>
                      {currentBoard.roles.map((role) => (
                        <option key={role.key} value={role.key}>
                          {role.name}
                        </option>
                      ))}
                    </select>
                  </div>
                ))}
              </div>
            )}
            {isHost && onlinePhase === 'lobby' && devMode && (
              <p className="mt-2 rounded-xl border border-dashed border-amber-500/40 bg-amber-500/5 px-3 py-2 text-center text-xs text-amber-400/80">
                开发者模式 · 房主可指定测试身份（如 1号=狼人、2号=女巫），未指定的座位随机发牌；指定后点"开始游戏"生效
              </p>
            )}
          </section>
        )}

        {onlineStarted && gameOverInfo && (
          <div className="mt-8 flex flex-col gap-3">
            {isHost ? (
              <button
                type="button"
                onClick={startOnlineNight}
                className="w-full rounded-2xl bg-amber-500 py-5 text-xl font-bold text-slate-950 shadow-lg shadow-amber-500/30 transition active:scale-95"
              >
                重新开始一局
              </button>
            ) : (
              <p className="rounded-xl border border-dashed border-slate-700 px-4 py-5 text-center text-sm text-slate-500">
                等待房主重新开始…
              </p>
            )}
            <p className="text-center text-xs text-slate-500">
              将清空上一局数据并重新发牌，直接进入第一夜
            </p>
          </div>
        )}

        {/* 投票记录折叠按钮：悬浮右下角不占布局，展开弹层复盘历史放逐投票 */}
        {onlineStarted && (
          <>
            <button
              type="button"
              onClick={() => setShowVoteHistory((v) => !v)}
              className="fixed right-2 bottom-24 z-50 flex items-center gap-1 rounded-full border border-amber-500/50 bg-slate-950/95 px-3 py-1.5 text-xs font-bold text-amber-300 shadow-lg backdrop-blur transition active:scale-95"
            >
              📋 投票记录 {showVoteHistory ? '▴' : '▾'}
            </button>
            {showVoteHistory && (
              <div className="fixed inset-x-0 bottom-24 z-50 mx-auto max-h-[38dvh] w-full max-w-[480px] overflow-y-auto rounded-t-2xl border border-amber-500/40 bg-slate-950/95 p-3 shadow-2xl backdrop-blur">
                <div className="flex items-center justify-between">
                  <p className="text-xs font-bold text-amber-300">📋 投票记录（放逐投票）</p>
                  <button
                    type="button"
                    onClick={() => setShowVoteHistory(false)}
                    className="rounded-full border border-slate-700 px-2 py-0.5 text-xs text-slate-300"
                  >
                    收起 ▴
                  </button>
                </div>
                {voteHistory.length === 0 ? (
                  <p className="mt-3 text-center text-xs text-slate-500">暂无投票记录</p>
                ) : (
                  <div className="mt-2 flex flex-col gap-2">
                    {voteHistory.map((rec, i) => (
                      <div key={i} className="rounded-xl border border-slate-800 bg-slate-900/60 px-3 py-2">
                        <p className="text-xs font-bold text-slate-200">
                          第 {rec.dayIndex} 天{rec.tie ? '（平票，无人出局）' : ` → 放逐 ${rec.exiledSeat} 号`}
                        </p>
                        <p className="mt-1 text-[11px] leading-5 text-slate-400">
                          {rec.tally.length > 0
                            ? rec.tally.map((t) => `${t.seat}号 ${t.count}票`).join('、')
                            : '无人投票'}
                        </p>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}
          </>
        )}

        {(trtcCred || (onlineStarted && myRole?.trtc)) && (
          <div
            className={`fixed inset-x-0 z-30 mx-auto flex h-11 max-w-[480px] items-center border-t border-slate-800 bg-slate-900/95 px-3 ${
              onlineStarted ? 'bottom-0' : 'bottom-[78px]'
            }`}
          >
            <VoiceRoom
              userId={playerId}
              nickname={nickname}
              sdkAppId={onlineStarted && myRole?.trtc ? myRole.trtc.sdkAppId : trtcCred!.sdkAppId}
              userSig={onlineStarted && myRole?.trtc ? myRole.trtc.userSig : trtcCred!.userSig}
              gameRoomId={roomId ?? 'demo'}
              perm={voicePerm}
              phase={onlineStarted ? (gameOverInfo ? 'over' : onlinePhase === 'lobby' ? 'waiting' : onlinePhase) : 'lobby'}
              mySeat={myRole?.seat ?? roster.find((p) => p.playerId === playerId)?.seat ?? null}
              currentSpeaker={currentSpeaker}
              sheriffSeat={sheriffSeat}
              isSheriff={(myRole?.seat ?? -1) === sheriffSeat}
              sheriffHasSpokenThisDay={sheriffHasSpokenThisDay}
              isWolf={myRole?.camp === 'wolf' || myRole?.roleKey === 'lonely_girl'}
              isAlive={myRole ? !deadSeats.includes(myRole.seat) : true}
              onTalkDone={() => {
                if (socket) socket.send(JSON.stringify({ type: 'talkDone', playerId }))
              }}
              onSheriffInterrupt={() => {
                if (socket) socket.send(JSON.stringify({ type: 'sheriffInterrupt', playerId }))
              }}
            />
          </div>
        )}

        {onlineStarted && onlinePhase === 'night' && (
          <section className={`fixed inset-x-0 bottom-11 z-40 mx-auto flex max-h-[calc(58dvh-44px)] max-w-[480px] flex-col overflow-y-auto rounded-t-2xl border-t border-indigo-500/40 bg-slate-950/95 p-3 shadow-2xl backdrop-blur ${phaseDisabled && isMyPhase ? 'pointer-events-none [&_button]:opacity-40' : ''}`}>
            <div className="flex items-center justify-between">
              <p className="text-xs text-slate-400">夜晚 · 第 {onlineNightIndex} 夜</p>
              <span
                className={`rounded-full px-2 py-0.5 text-xs font-black ${
                  remainSec !== null && remainSec <= 10
                    ? 'bg-rose-500/20 text-rose-400'
                    : 'bg-indigo-500/20 text-indigo-300'
                }`}
              >
                {remainSec !== null ? `${remainSec} 秒` : '…'}
              </span>
            </div>
            <p className="mt-1 text-sm font-bold text-slate-100">
              天黑了，请闭眼 ·{' '}
              <span className="font-normal text-slate-400">
                {nightSubmitted
                  ? '操作已提交，等待天亮…'
                  : currentPhase?.roleKey
                  ? `当前行动：${currentPhase.label}睁眼`
                  : '当前有其他玩家正在行动，请闭眼等待'}
              </span>
            </p>
            {(seerResult || wolfWitchResult) && (
              <div className="mt-2 rounded-xl border border-emerald-500/40 bg-emerald-500/10 px-3 py-2">
                {seerResult && (
                  <p className="text-sm font-bold text-emerald-300">
                    预言家查验：{seerResult.target} 号是{seerResult.rebounded ? ' ✅ 好人（封锁反弹，视为金水）' : seerResult.camp === 'wolf' ? ' 🐺 狼人' : ' ✅ 好人'}
                  </p>
                )}
                {wolfWitchResult && (
                  <p className="text-sm font-bold text-emerald-300">
                    狼巫查验：{wolfWitchResult.target} 号是「{wolfWitchResult.roleName}」
                  </p>
                )}
              </div>
            )}
            {phaseDisabled && isMyPhase && (
              <p className="mt-3 rounded-xl border border-fuchsia-500/40 bg-fuchsia-500/10 px-3 py-2 text-sm font-bold text-fuchsia-200">
                你被噩梦之影恐惧，本夜无法行动。
              </p>
            )}

            {/* 私密信息：仅本人收到（其他人的数据包里没有这些字段） */}
            {loverSeat !== null && (
              <p className="mt-3 rounded-xl border border-pink-500/40 bg-pink-500/10 px-3 py-2 text-sm font-bold text-pink-300">
                💕 你的情侣是 {loverSeat} 号（仅你可见）
              </p>
            )}
            {myRole?.roleKey === 'cupid' && cupidConnected && (
              <p className="mt-3 rounded-xl border border-fuchsia-500/40 bg-fuchsia-500/10 px-3 py-2 text-sm font-bold text-fuchsia-300">
                你已连接 {cupidConnected[0]} 号与 {cupidConnected[1]} 号成为情侣（仅你可见）
              </p>
            )}

            {/* 狼人私密面板：只对狼人玩家可见 */}
            {isWolf && !deadSeats.includes(myRole?.seat ?? -1) && currentPhase?.roleKey === 'wolf' && currentPhase?.requiredAction === 'wolf_vote' && (
              <div className="mt-2 rounded-2xl border border-rose-500/40 bg-slate-950 p-3">
                <p className="text-sm font-bold text-rose-400">狼人阵营</p>
                <p className="mt-1 text-sm font-medium text-slate-100">
                  你是 {myRole?.seat}号 · 身份：{myRole?.roleName}（狼人） · 狼队友：
                  {wolfTeammates.length > 0
                    ? wolfTeammates.map((seat) => `${seat}号`).join('、')
                    : '无（本局只有你一只狼）'}
                </p>

                <p className="mt-2 text-[10px] text-slate-400">快捷沟通（仅狼队可见）</p>
                <div className="mt-2 flex flex-wrap gap-2">
                  {wolfQuickPhrases().map((phrase) => (
                    <button
                      key={phrase}
                      type="button"
                      onClick={() => sendWolfChat(phrase)}
                      className="rounded-full border border-slate-700 bg-slate-900 px-2 py-0.5 text-[10px] text-slate-200 transition active:scale-95"
                    >
                      {phrase}
                    </button>
                  ))}
                </div>
                <div className="mt-2 flex max-h-12 flex-col gap-1 overflow-y-auto">
                  {wolfPanel?.wolfChat.map((item, index) => (
                    <p key={index} className="text-xs text-slate-400">
                      <span className="text-slate-200">{item.nickname}：</span>
                      {item.text}
                    </p>
                  ))}
                </div>

                <p className="mt-2 text-[10px] text-slate-400">选择今晚刀口</p>
                <div className="mt-2 grid grid-cols-6 gap-1.5">
                  {wolfSeatList.map((s) => {
                    const selected = wolfVoteTarget === s.seat
                    return (
                      <button
                        key={s.seat}
                        type="button"
                        onClick={() => setWolfVoteTarget(selected ? null : s.seat)}
                        className={`rounded-lg py-1.5 text-xs font-bold transition active:scale-95 ${
                          selected
                            ? 'bg-rose-500 text-slate-950'
                            : 'border border-slate-700 bg-slate-950 text-slate-300'
                        }`}
                      >
                        {s.seat}号
                      </button>
                    )
                  })}
                </div>
                <button
                  type="button"
                  onClick={submitWolfVote}
                  disabled={wolfVoteTarget === null}
                  className="mt-3 w-full rounded-xl bg-rose-500 py-2 text-sm font-bold text-slate-950 transition active:scale-95 disabled:cursor-not-allowed disabled:opacity-40"
                >
                  {wolfVoteTarget !== null ? `提交狼刀（${wolfVoteTarget}号）` : '提交狼刀'}
                  {wolfPanel && wolfPanel.wolfVotes.length > 0
                    ? ` · ${wolfPanel.wolfVotes.map((v) => `${v.seat}号${v.count}票`).join('，')}`
                    : ''}
                </button>
              </div>
            )}

            {/* 预言家面板 */}
            {myRole?.roleKey === 'seer' && currentPhase?.roleKey === 'seer' && currentPhase?.requiredAction === 'seer_check' && (
              <div className="mt-2 rounded-2xl border border-emerald-500/40 bg-slate-950 p-2.5">
                <p className="text-sm font-bold text-emerald-400">预言家</p>
                <p className="mt-1 text-sm text-slate-300">请选择查验目标</p>
                {seerResult && (
                  <p
                    className={`mt-2 rounded-xl p-2 text-sm font-bold ${
                      seerResult.camp === 'wolf'
                        ? 'bg-rose-500/10 text-rose-300'
                        : 'bg-emerald-500/10 text-emerald-300'
                    }`}
                  >
                    {seerResult.rebounded
                      ? '查验结果：✅ 好人（金水）'
                      : `查验结果：${seerResult.target} 号是 ${
                          seerResult.camp === 'wolf' ? '🐺 狼人' : '✅ 好人'
                        }`}
                  </p>
                )}
                <div className="mt-2 grid grid-cols-6 gap-1.5">
                  {aliveSeatInfo.map((s) => (
                    <button
                      key={s.seat}
                      type="button"
                      onClick={() => setSeerTarget(seerTarget === s.seat ? null : s.seat)}
                      className={`rounded-lg py-1.5 text-xs font-bold transition active:scale-95 ${
                        seerTarget === s.seat
                          ? 'bg-emerald-500 text-slate-950'
                          : 'border border-slate-700 bg-slate-950 text-slate-300'
                      }`}
                    >
                      {s.seat}号
                    </button>
                  ))}
                </div>
                <button
                  type="button"
                  onClick={() => submitNightTarget('seer', seerTarget)}
                  disabled={seerTarget === null || phaseDisabled}
                  className="mt-4 w-full rounded-xl bg-emerald-500 py-2 text-sm font-bold text-slate-950 transition active:scale-95 disabled:cursor-not-allowed disabled:opacity-40"
                >
                  提交查验
                </button>
              </div>
            )}

            {/* 女巫面板 */}
            {myRole?.roleKey === 'witch' && currentPhase?.roleKey === 'witch' && currentPhase?.requiredAction === 'witch_action' && (
              <div className="mt-2 rounded-2xl border border-purple-500/40 bg-slate-950 p-2.5">
                <p className="text-sm font-bold text-purple-400">女巫</p>
                <p className="mt-2 text-center text-sm font-bold text-purple-200">
                  解药x{witchSaveUsed ? 0 : 1} | 毒药x{witchPoisonUsed ? 0 : 1}
                </p>
                {(() => {
                  const selfKilled = witchTarget !== null && witchTarget === myRole?.seat
                  // 互斥 + 限制：救按钮不可点条件
                  const saveDisabled =
                    selfKilled ||
                    witchSaveUsed ||
                    onlineWitchChoice === 'poison' ||
                    onlineWitchChoice === 'none'
                  const poisonDisabled =
                    witchPoisonUsed ||
                    onlineWitchChoice === 'save' ||
                    onlineWitchChoice === 'none'
                  return (
                    <>
                      {selfKilled ? (
                        <p className="mt-1 rounded-lg border border-rose-500/40 bg-rose-500/10 px-3 py-2 text-sm font-medium text-rose-300">
                          你被刀了，不能自救，只能选择用毒药或不用药
                        </p>
                      ) : witchTarget !== null ? (
                        <p className="mt-1 text-sm text-slate-300">
                          今晚死的是 {witchTarget}号，请选择救/毒/不用药（一晚只能一瓶药）
                        </p>
                      ) : (
                        <p className="mt-1 text-sm text-slate-300">
                          今晚无人被刀（平安夜），请选择用毒或不用药（一晚只能一瓶药）
                        </p>
                      )}
                      <div className="mt-4 flex flex-col gap-2">
                        <button
                          type="button"
                          onClick={() => setOnlineWitchChoice('save')}
                          disabled={saveDisabled || phaseDisabled}
                          className={`w-full rounded-2xl py-2 text-sm font-bold transition active:scale-95 disabled:cursor-not-allowed disabled:opacity-40 ${
                            onlineWitchChoice === 'save'
                              ? 'bg-emerald-500 text-slate-950'
                              : 'border border-slate-700 text-slate-200'
                          }`}
                        >
                          解药救人
                          {selfKilled && '（自救禁用）'}
                          {witchSaveUsed && '（已用）'}
                        </button>
                        <button
                          type="button"
                          onClick={() => setOnlineWitchChoice('poison')}
                          disabled={poisonDisabled || phaseDisabled}
                          className={`w-full rounded-2xl py-2 text-sm font-bold transition active:scale-95 disabled:cursor-not-allowed disabled:opacity-40 ${
                            onlineWitchChoice === 'poison'
                              ? 'bg-rose-500 text-slate-950'
                              : 'border border-slate-700 text-slate-200'
                          }`}
                        >
                          毒药杀人
                          {witchPoisonUsed && '（已用）'}
                        </button>
                        <button
                          type="button"
                          onClick={() => setOnlineWitchChoice('none')}
                          className={`w-full rounded-2xl py-2 text-sm font-bold transition active:scale-95 ${
                            onlineWitchChoice === 'none'
                              ? 'bg-slate-500 text-slate-950'
                              : 'border border-slate-700 text-slate-200'
                          }`}
                        >
                          不用药
                        </button>
                      </div>
                      {onlineWitchChoice === 'poison' && (
                        <>
                          <p className="mt-4 text-xs text-slate-400">选择毒药目标</p>
                          <div className="mt-2 grid grid-cols-6 gap-1.5">
                            {aliveSeatInfo.map((s) => (
                              <button
                                key={s.seat}
                                type="button"
                                onClick={() =>
                                  setWitchPoisonTarget(
                                    witchPoisonTarget === s.seat ? null : s.seat,
                                  )
                                }
                                className={`rounded-lg py-1.5 text-xs font-bold transition active:scale-95 ${
                                  witchPoisonTarget === s.seat
                                    ? 'bg-rose-500 text-slate-950'
                                    : 'border border-slate-700 bg-slate-950 text-slate-300'
                                }`}
                              >
                                {s.seat}号
                              </button>
                            ))}
                          </div>
                        </>
                      )}
                      <button
                        type="button"
                        onClick={submitWitchAction}
                          disabled={onlineWitchChoice === null || phaseDisabled}
                        className="mt-4 w-full rounded-2xl bg-purple-500 py-2 text-sm font-bold text-slate-950 transition active:scale-95 disabled:cursor-not-allowed disabled:opacity-40"
                      >
                        提交女巫操作
                      </button>
                    </>
                  )
                })()}
              </div>
            )}

            {/* 摄梦人面板 */}
            {myRole?.roleKey === 'dream_weaver' &&
              currentPhase?.roleKey === 'dream_weaver' &&
              currentPhase?.requiredAction === 'dream_weaver_visit' && (
                <div className="mt-2 rounded-2xl border border-cyan-500/40 bg-slate-950 p-2.5">
                  <p className="text-sm font-bold text-cyan-400">摄梦人</p>
                  <p className="mt-1 text-sm text-slate-300">
                    请选择一名玩家成为梦游者（必须选择）
                  </p>
                  <div className="mt-2 grid grid-cols-6 gap-1.5">
                    {aliveSeatInfo.map((s) => (
                      <button
                        key={s.seat}
                        type="button"
                        onClick={() => setDreamTarget(dreamTarget === s.seat ? null : s.seat)}
                        className={`rounded-lg py-1.5 text-xs font-bold transition active:scale-95 ${
                          dreamTarget === s.seat
                            ? 'bg-cyan-500 text-slate-950'
                            : 'border border-slate-700 bg-slate-950 text-slate-300'
                        }`}
                      >
                        {s.seat}号
                      </button>
                    ))}
                  </div>
                  <button
                    type="button"
                    onClick={() => submitNightTarget('dream_weaver', dreamTarget)}
                    disabled={dreamTarget === null || phaseDisabled}
                    className="mt-4 w-full rounded-2xl bg-cyan-500 py-2 text-sm font-bold text-slate-950 transition active:scale-95 disabled:cursor-not-allowed disabled:opacity-40"
                  >
                    提交
                  </button>
                  <button type="button" onClick={() => submitNightTarget('dream_weaver', 0)} disabled={phaseDisabled} className="mt-2 w-full rounded-2xl border border-slate-600 bg-slate-900 py-2 text-sm font-bold text-slate-200 disabled:opacity-40">
                    不使用技能
                  </button>
                </div>
              )}

            {/* 乌鸦面板 */}
            {myRole?.roleKey === 'raven' && currentPhase?.roleKey === 'raven' && currentPhase?.requiredAction === 'raven_curse' && (
              <div className="mt-2 rounded-2xl border border-yellow-500/40 bg-slate-950 p-2.5">
                <p className="text-sm font-bold text-yellow-400">乌鸦</p>
                <p className="mt-1 text-sm text-slate-300">请选择今晚诅咒的目标</p>
                <div className="mt-2 grid grid-cols-6 gap-1.5">
                  {aliveSeatInfo.map((s) => (
                    <button
                      key={s.seat}
                      type="button"
                      onClick={() => setRavenTarget(ravenTarget === s.seat ? null : s.seat)}
                      className={`rounded-lg py-1.5 text-xs font-bold transition active:scale-95 ${
                        ravenTarget === s.seat
                          ? 'bg-yellow-500 text-slate-950'
                          : 'border border-slate-700 bg-slate-950 text-slate-300'
                      }`}
                    >
                      {s.seat}号
                    </button>
                  ))}
                </div>
                <button
                  type="button"
                  onClick={() => submitNightTarget('raven', ravenTarget)}
                  disabled={ravenTarget === null || phaseDisabled}
                  className="mt-4 w-full rounded-2xl bg-yellow-500 py-2 text-sm font-bold text-slate-950 transition active:scale-95 disabled:cursor-not-allowed disabled:opacity-40"
                >
                  提交
                </button>
                <button type="button" onClick={() => submitNightTarget('raven', 0)} disabled={phaseDisabled} className="mt-2 w-full rounded-2xl border border-slate-600 bg-slate-900 py-2 text-sm font-bold text-slate-200 disabled:opacity-40">
                  不使用技能
                </button>
              </div>
            )}

            {/* 噩梦之影面板 */}
            {myRole?.roleKey === 'nightmare' &&
              currentPhase?.roleKey === 'nightmare' &&
              currentPhase?.requiredAction === 'nightmare_fear' && (
                <div className="mt-2 rounded-2xl border border-fuchsia-500/40 bg-slate-950 p-2.5">
                  <p className="text-sm font-bold text-fuchsia-400">噩梦之影</p>
                  <p className="mt-1 text-sm text-slate-300">
                    选择一名玩家恐惧：其当夜无法行动；恐惧狼人则狼队空刀（不能连续两晚恐惧同一人）
                  </p>
                  <div className="mt-2 grid grid-cols-6 gap-1.5">
                    {aliveSeatInfo.map((s) => (
                      <button
                        key={s.seat}
                        type="button"
                        onClick={() =>
                          setNightmareTarget(nightmareTarget === s.seat ? null : s.seat)
                        }
                        className={`rounded-lg py-1.5 text-xs font-bold transition active:scale-95 ${
                          nightmareTarget === s.seat
                            ? 'bg-fuchsia-500 text-slate-950'
                            : 'border border-slate-700 bg-slate-950 text-slate-300'
                        }`}
                      >
                        {s.seat}号
                      </button>
                    ))}
                  </div>
                  <button
                    type="button"
                    onClick={() => submitNightTarget('nightmare', nightmareTarget)}
                    disabled={nightmareTarget === null || phaseDisabled}
                    className="mt-4 w-full rounded-2xl bg-fuchsia-500 py-2 text-sm font-bold text-slate-950 transition active:scale-95 disabled:cursor-not-allowed disabled:opacity-40"
                  >
                    提交恐惧
                  </button>
                  <button type="button" onClick={() => submitNightTarget('nightmare', 0)} disabled={phaseDisabled} className="mt-2 w-full rounded-2xl border border-slate-600 bg-slate-900 py-2 text-sm font-bold text-slate-200 disabled:opacity-40">
                    不使用技能
                  </button>
                </div>
              )}

            {/* 蚀时狼妃面板 */}
            {myRole?.roleKey === 'wolf_queen' &&
              currentPhase?.roleKey === 'wolf_queen' &&
              currentPhase?.requiredAction === 'wolf_queen_block' && (
                <div className="mt-2 rounded-2xl border border-rose-400/40 bg-slate-950 p-2.5">
                  <p className="text-sm font-bold text-rose-400">蚀时狼妃</p>
                  <p className="mt-1 text-sm text-slate-300">
                    选择一名玩家封锁：当晚对其的查验/毒药/摄梦反弹给施法者；猎魔人不受影响。可不使用技能
                  </p>
                  <div className="mt-2 grid grid-cols-6 gap-1.5">
                    {aliveSeatInfo.map((s) => (
                      <button
                        key={s.seat}
                        type="button"
                        onClick={() =>
                          setWolfQueenTarget(wolfQueenTarget === s.seat ? null : s.seat)
                        }
                        className={`rounded-lg py-1.5 text-xs font-bold transition active:scale-95 ${
                          wolfQueenTarget === s.seat
                            ? 'bg-rose-400 text-slate-950'
                            : 'border border-slate-700 bg-slate-950 text-slate-300'
                        }`}
                      >
                        {s.seat}号
                      </button>
                    ))}
                  </div>
                  <div className="mt-4 flex flex-col gap-2">
                    <button
                      type="button"
                      onClick={() => submitNightTarget('wolf_queen', wolfQueenTarget)}
                      disabled={wolfQueenTarget === null || phaseDisabled}
                      className="w-full rounded-2xl bg-rose-400 py-2 text-sm font-bold text-slate-950 transition active:scale-95 disabled:cursor-not-allowed disabled:opacity-40"
                    >
                      提交封锁
                    </button>
                    <button
                      type="button"
                      onClick={() => submitNightTarget('wolf_queen', 0)}
                      className="w-full rounded-2xl border border-slate-700 bg-slate-800 py-2 text-sm font-bold text-slate-300 transition active:scale-95"
                    >
                      不使用技能
                    </button>
                  </div>
                </div>
              )}

            {/* 猎魔人面板 */}
            {myRole?.roleKey === 'demon_hunter' &&
              currentPhase?.roleKey === 'demon_hunter' &&
              currentPhase?.requiredAction === 'demon_hunter_hunt' && (
                <div className="mt-2 rounded-2xl border border-orange-500/40 bg-slate-950 p-2.5">
                  <p className="text-sm font-bold text-orange-400">猎魔人</p>
                  <p className="mt-1 text-sm text-slate-300">
                    选择一名玩家狩猎：目标是狼人则次日出局；目标是好人则你出局（不能连续两晚狩猎同一人）
                  </p>
                  <div className="mt-2 grid grid-cols-6 gap-1.5">
                    {aliveSeatInfo.map((s) => (
                      <button
                        key={s.seat}
                        type="button"
                        onClick={() =>
                          setDemonHunterTarget(demonHunterTarget === s.seat ? null : s.seat)
                        }
                        className={`rounded-lg py-1.5 text-xs font-bold transition active:scale-95 ${
                          demonHunterTarget === s.seat
                            ? 'bg-orange-500 text-slate-950'
                            : 'border border-slate-700 bg-slate-950 text-slate-300'
                        }`}
                      >
                        {s.seat}号
                      </button>
                    ))}
                  </div>
                  <button
                    type="button"
                    onClick={() => submitNightTarget('demon_hunter', demonHunterTarget)}
                    disabled={demonHunterTarget === null}
                    className="mt-4 w-full rounded-2xl bg-orange-500 py-2 text-sm font-bold text-slate-950 transition active:scale-95 disabled:cursor-not-allowed disabled:opacity-40"
                  >
                    提交狩猎
                  </button>
                  <button
                    type="button"
                    onClick={() => submitNightTarget('demon_hunter', 0)}
                    className="mt-2 w-full rounded-2xl border border-slate-600 bg-slate-900 py-2 text-sm font-bold text-slate-200 transition active:scale-95"
                  >
                    不使用技能（空过）
                  </button>
                </div>
              )}

            {/* 狼巫面板 */}
            {myRole?.roleKey === 'wolf_witch' &&
              currentPhase?.roleKey === 'wolf_witch' &&
              currentPhase?.requiredAction === 'wolf_witch_check' && (
                <div className="mt-2 rounded-2xl border border-emerald-500/40 bg-slate-950 p-2.5">
                  <p className="text-sm font-bold text-emerald-400">狼巫</p>
                  <p className="mt-1 text-sm text-slate-300">
                    选择一名玩家查验具体身份（查验到咒狐，咒狐不出局）
                  </p>
                  {wolfWitchResult && (
                    <p className="mt-2 rounded-xl bg-emerald-500/10 p-2 text-sm font-bold text-emerald-300">
                      查验结果：{wolfWitchResult.target} 号是「{wolfWitchResult.roleName}」
                    </p>
                  )}
                  <div className="mt-2 grid grid-cols-6 gap-1.5">
                    {aliveSeatInfo.map((s) => (
                      <button
                        key={s.seat}
                        type="button"
                        onClick={() =>
                          setWolfWitchTarget(wolfWitchTarget === s.seat ? null : s.seat)
                        }
                        className={`rounded-lg py-1.5 text-xs font-bold transition active:scale-95 ${
                          wolfWitchTarget === s.seat
                            ? 'bg-emerald-500 text-slate-950'
                            : 'border border-slate-700 bg-slate-950 text-slate-300'
                        }`}
                      >
                        {s.seat}号
                      </button>
                    ))}
                  </div>
                  <button
                    type="button"
                    onClick={() => submitNightTarget('wolf_witch', wolfWitchTarget)}
                    disabled={wolfWitchTarget === null || phaseDisabled}
                    className="mt-4 w-full rounded-xl bg-emerald-500 py-2 text-sm font-bold text-slate-950 transition active:scale-95 disabled:cursor-not-allowed disabled:opacity-40"
                  >
                    提交查验
                  </button>
                  <button type="button" onClick={() => submitNightTarget('wolf_witch', 0)} disabled={phaseDisabled} className="mt-2 w-full rounded-2xl border border-slate-600 bg-slate-900 py-2 text-sm font-bold text-slate-200 disabled:opacity-40">
                    不使用技能
                  </button>
                </div>
              )}

            {/* 丘比特：首夜连接情侣（选两名玩家） */}
            {myRole?.roleKey === 'cupid' &&
              currentPhase?.roleKey === 'cupid' &&
              currentPhase?.requiredAction === 'cupid_link' && (
                <div className="mt-2 rounded-2xl border border-fuchsia-500/40 bg-slate-950 p-2.5">
                  <p className="text-sm font-bold text-fuchsia-400">丘比特 · 首夜</p>
                  <p className="mt-1 text-sm text-slate-300">
                    选择两名玩家成为情侣（已选 {cupidTargets.length}/2；不能选自己）
                  </p>
                  <div className="mt-2 grid grid-cols-6 gap-1.5">
                    {aliveSeatInfo
                      .filter((s) => s.seat !== myRole.seat)
                      .map((s) => {
                        const picked = cupidTargets.includes(s.seat)
                        return (
                          <button
                            key={s.seat}
                            type="button"
                            onClick={() =>
                              setCupidTargets((prev) =>
                                picked
                                  ? prev.filter((x) => x !== s.seat)
                                  : prev.length >= 2
                                    ? prev
                                    : [...prev, s.seat],
                              )
                            }
                            className={`rounded-lg py-1.5 text-xs font-bold transition active:scale-95 ${
                              picked
                                ? 'bg-fuchsia-500 text-slate-950'
                                : 'border border-slate-700 bg-slate-950 text-slate-300'
                            }`}
                          >
                            {s.seat}号{picked ? ' ❤' : ''}
                          </button>
                        )
                      })}
                  </div>
                  <button
                    type="button"
                    onClick={submitCupidAction}
                    disabled={cupidTargets.length !== 2}
                    className="mt-4 w-full rounded-2xl bg-fuchsia-500 py-2 text-sm font-bold text-slate-950 transition active:scale-95 disabled:cursor-not-allowed disabled:opacity-40"
                  >
                    连接情侣
                  </button>
                </div>
              )}

            {/* 觉醒孤独少女：首夜选择偶像 */}
            {myRole?.roleKey === 'lonely_girl' &&
              currentPhase?.roleKey === 'lonely_girl' &&
              currentPhase?.requiredAction === 'lonely_girl_idol' && (
                <div className="mt-2 rounded-2xl border border-sky-500/40 bg-slate-950 p-2.5">
                  <p className="text-sm font-bold text-sky-400">觉醒孤独少女 · 首夜</p>
                  <p className="mt-1 text-sm text-slate-300">
                    请选择你追崇的偶像（不能选自己）
                  </p>
                  <div className="mt-2 grid grid-cols-6 gap-1.5">
                    {aliveSeatInfo
                      .filter((s) => s.seat !== myRole.seat)
                      .map((s) => (
                        <button
                          key={s.seat}
                          type="button"
                          onClick={() =>
                            setLonelyGirlTarget(lonelyGirlTarget === s.seat ? null : s.seat)
                          }
                          className={`rounded-lg py-1.5 text-xs font-bold transition active:scale-95 ${
                            lonelyGirlTarget === s.seat
                              ? 'bg-sky-500 text-slate-950'
                              : 'border border-slate-700 bg-slate-950 text-slate-300'
                          }`}
                        >
                          {s.seat}号
                        </button>
                      ))}
                  </div>
                  <button
                    type="button"
                    onClick={() => submitNightTarget('lonely_girl', lonelyGirlTarget)}
                    disabled={lonelyGirlTarget === null}
                    className="mt-4 w-full rounded-2xl bg-sky-500 py-2 text-sm font-bold text-slate-950 transition active:scale-95 disabled:cursor-not-allowed disabled:opacity-40"
                  >
                    选择偶像
                  </button>
                </div>
              )}

            {/* 兜底面板：若当前行动角色没有任何专属面板（防御性），保证不会"卡在某角色无按钮" */}
            {isMyPhase &&
              myRole?.roleKey &&
              ![
                'wolf',
                'seer',
                'witch',
                'dream_weaver',
                'raven',
                'nightmare',
                'wolf_queen',
                'demon_hunter',
                'wolf_witch',
                'cupid',
                'lonely_girl',
              ].includes(myRole.roleKey) && (
                <div className="mt-2 rounded-2xl border border-indigo-500/40 bg-slate-950 p-3">
                  <p className="text-sm font-bold text-indigo-400">
                    {currentPhase?.label ?? '当前行动'}睁眼
                  </p>
                  <p className="mt-1 text-sm text-slate-300">请选择目标（不能选自己）</p>
                  <div className="mt-2 grid grid-cols-6 gap-1.5">
                    {aliveSeatInfo
                      .filter((s) => s.seat !== myRole.seat)
                      .map((s) => (
                        <button
                          key={s.seat}
                          type="button"
                          onClick={() =>
                            setGenericTarget(genericTarget === s.seat ? null : s.seat)
                          }
                          className={`rounded-lg py-1.5 text-xs font-bold transition active:scale-95 ${
                            genericTarget === s.seat
                              ? 'bg-indigo-500 text-slate-950'
                              : 'border border-slate-700 bg-slate-950 text-slate-300'
                          }`}
                        >
                          {s.seat}号
                        </button>
                      ))}
                  </div>
                  <button
                    type="button"
                    onClick={() =>
                      myRole.roleKey &&
                      submitNightTarget(myRole.roleKey, genericTarget)
                    }
                    disabled={genericTarget === null || phaseDisabled}
                    className="mt-2 w-full rounded-2xl bg-indigo-500 py-2 text-sm font-bold text-slate-950 transition active:scale-95 disabled:cursor-not-allowed disabled:opacity-40"
                  >
                    提交行动
                  </button>
                </div>
              )}

            {!isMyPhase && currentPhase !== null && (
              <p className="mt-2 rounded-xl border border-dashed border-slate-700 px-3 py-3 text-center text-sm text-slate-500">
                你是 {myRole?.seat}号 · 本轮无需操作
                {isWolf
                  ? '（你是狼人，等待你的行动阶段）'
                  : '（非狼人角色，天黑请闭眼）'}
              </p>
            )}

            {/* 统一快捷操作面板：预言家「查验X号」/ 狼人「刀X号」真实交互按钮 */}
            {(currentPhase?.roleKey === 'seer' || currentPhase?.roleKey === 'wolf') &&
              !deadSeats.includes(myRole?.seat ?? -1) &&
              !(myRole?.roleKey === 'seer' && currentPhase?.roleKey === 'seer' && currentPhase?.requiredAction === 'seer_check') &&
              !(isWolf && !deadSeats.includes(myRole?.seat ?? -1) && currentPhase?.roleKey === 'wolf' && currentPhase?.requiredAction === 'wolf_vote') && (
              <RoleActionPanel
                phase="night"
                roleKey={currentPhase.roleKey}
                mySeat={myRole?.seat ?? 0}
                currentSpeaker={null}
                targets={
                  currentPhase.roleKey === 'seer'
                    ? aliveSeatInfo.map((s) => s.seat)
                    : wolfSeatList
                        .filter(
                          (s) =>
                            s.seat !== myRole?.seat &&
                            !wolfTeammates.includes(s.seat) &&
                            !deadSeats.includes(s.seat),
                        )
                        .map((s) => s.seat)
                }
                disabled={phaseDisabled}
                onAction={(target) => {
                  if (currentPhase.roleKey === 'seer') {
                    setSeerTarget(target)
                    submitNightTarget('seer', target)
                  } else {
                    setWolfVoteTarget(target)
                    if (socket) {
                      socket.send(
                        JSON.stringify({ type: 'wolfVote', playerId, target }),
                      )
                    }
                  }
                }}
              />
            )}
          </section>
        )}

        {/* 死讯与白天流程区：警长竞选完成后才显示（竞选期间只显示竞选界面，不提前播报死讯） */}
        {onlineStarted && onlinePhase === 'day' && nightEnded && (
          <section className="fixed inset-x-0 bottom-11 z-40 mx-auto flex max-h-[calc(58dvh-44px)] max-w-[480px] flex-col overflow-y-auto rounded-t-2xl border-t border-emerald-500/40 bg-slate-950/95 p-3 shadow-2xl backdrop-blur">
            <div className="flex items-center justify-between">
              <p className="text-xs text-slate-400">白天 · 第 {nightEnded.dayIndex} 天</p>
              {(dayStage === 'talk' && talkRemainSec !== null) ||
              (dayStage === 'vote' && voteRemainSec !== null) ||
              (sheriffStage !== null && sheriffRemainSec !== null) ? (
                <span
                  className={`rounded-full px-2.5 py-1 text-xs font-bold ${
                    (dayStage === 'talk' && talkRemainSec !== null && talkRemainSec <= 10) ||
                    (dayStage === 'vote' && voteRemainSec !== null && voteRemainSec <= 10) ||
                    (sheriffStage !== null && sheriffRemainSec !== null && sheriffRemainSec <= 10)
                      ? 'bg-rose-500/20 text-rose-300'
                      : 'bg-slate-800 text-slate-300'
                  }`}
                >
                  {sheriffStage === 'apply' && sheriffRemainSec !== null
                    ? `上警 ${sheriffRemainSec} 秒`
                    : sheriffStage === 'vote' && sheriffRemainSec !== null
                      ? `警下投票 ${sheriffRemainSec} 秒`
                      : dayStage === 'talk' && talkRemainSec !== null
                        ? `发言 ${talkRemainSec} 秒`
                        : dayStage === 'vote' && voteRemainSec !== null
                          ? `投票 ${voteRemainSec} 秒`
                          : ''}
                </span>
              ) : null}
            </div>
            {(seerResult || wolfWitchResult) && (
              <p className="mt-1.5 rounded-xl border border-emerald-500/40 bg-emerald-500/10 px-3 py-1.5 text-xs font-bold text-emerald-300">
                {seerResult ? (
                  <>预言家查验：{seerResult.target} 号是
                    {seerResult.rebounded ? ' ✅ 好人（封锁反弹，视为金水）' : seerResult.camp === 'wolf' ? ' 🐺 狼人' : ' ✅ 好人'}
                  </>
                ) : (
                  <>狼巫查验：{wolfWitchResult?.target} 号是「{wolfWitchResult?.roleName}」</>
                )}
              </p>
            )}
            {sheriffStage === null && (
              <p className="mt-2 text-sm text-slate-300">
                <span className="font-bold">昨晚死讯：</span>
                {nightEnded.deaths.length > 0 ? (
                  <span className="text-rose-400">
                    {nightEnded.deaths.map((seat) => `${seat}号`).join('、')} 死亡
                  </span>
                ) : (
                  <span className="text-emerald-400">昨晚是平安夜</span>
                )}
              </p>
            )}

            {/* 乌鸦禁言跳麦提示（屏幕中央横幅） */}
            {skipNotice && nowMs - skipNotice.at < 3500 && (
              <div className="fixed inset-x-0 top-24 z-50 mx-auto w-[92%] max-w-md rounded-2xl border border-rose-500/50 bg-slate-950/95 px-6 py-4 text-center shadow-2xl">
                <p className="text-lg font-bold text-rose-300">
                  {skipNotice.seats
                    .map((s) => `${s}号玩家被禁言，跳过发言`)
                    .join('；')}
                </p>
              </div>
            )}

            {/* 当前警长 👑 */}
            {sheriffSeat !== null && dayStage !== null && (
              <p className="mt-2 rounded-xl border border-amber-500/40 bg-amber-500/10 px-3 py-1 text-center text-xs font-bold text-amber-300">
                👑 警长：{sheriffSeat} 号
              </p>
            )}

            {/* 警长竞选：上警 */}
            {sheriffStage === 'apply' && (
              <div className="mt-4 rounded-xl border border-slate-700 bg-slate-900/60 px-4 py-4">
                <p className="text-center text-base font-bold text-amber-300">
                  警长竞选开始
                </p>
                <p className="mt-1 text-center text-sm text-slate-400">
                  请选择是否上警 {sheriffRemainSec !== null ? `· ${sheriffRemainSec} 秒` : ''}
                </p>
                {deadSeats.includes(myRole?.seat ?? -1) ? (
                  <p className="mt-3 text-center text-sm text-slate-500">
                    你已经出局，无法上警
                  </p>
                ) : mySheriffChoice !== null ? (
                  <p className="mt-3 rounded-xl border border-emerald-500/40 bg-emerald-500/10 px-4 py-3 text-center text-sm text-emerald-300">
                    已选择：{mySheriffChoice === 'apply' ? '上警' : '不上警'}（等待其他玩家…）
                  </p>
                ) : (
                  <div className="mt-3 grid grid-cols-2 gap-3">
                    <button
                      type="button"
                      onClick={() => submitSheriffApply(true)}
                      className="rounded-2xl bg-amber-500 py-2 text-sm font-bold text-slate-950 transition active:scale-95"
                    >
                      上警
                    </button>
                    <button
                      type="button"
                      onClick={() => submitSheriffApply(false)}
                      className="rounded-2xl border border-slate-700 bg-slate-800 py-2 text-sm font-bold text-slate-300 transition active:scale-95"
                    >
                      不上警
                    </button>
                  </div>
                )}
                {sheriffCandidates.length > 0 && (
                  <p className="mt-3 text-center text-sm text-slate-400">
                    已上警：{sheriffCandidates.map((s) => `${s}号`).join('、')}
                  </p>
                )}
              </div>
            )}

            {/* 警长竞选：警上发言（复用轮流发言 + 退水） */}
            {sheriffStage === 'talk' && (
              <div className="mt-4 rounded-xl border border-slate-700 bg-slate-900/60 px-4 py-4">
                <p className="text-center text-base font-bold text-amber-300">
                  警上发言 · 候选：{sheriffCandidates.map((s) => `${s}号`).join('、')}
                </p>
                {currentSpeaker === null ? (
                  <p className="mt-3 text-center text-sm text-slate-400">正在准备发言顺序…</p>
                ) : deadSeats.includes(myRole?.seat ?? -1) ? (
                  <p className="mt-3 text-center text-sm text-slate-500">
                    你已经出局，正在观战。当前：{currentSpeaker}号警上发言中
                  </p>
                ) : (myRole?.seat ?? -1) === currentSpeaker ? (
                  <>
                    <p className="mt-3 text-center text-base font-bold text-amber-300">
                      你是 {currentSpeaker} 号，请警上发言
                    </p>
                    <p className="mt-1 text-center text-sm text-slate-400">
                      剩余 {talkRemainSec} 秒
                    </p>
                    <button
                      type="button"
                      onClick={() => {
                        const msg: ClientMessage = { type: 'talkDone', playerId }
                        socket?.send(JSON.stringify(msg))
                      }}
                      className="sticky bottom-0 mt-4 w-full rounded-2xl bg-amber-500 py-2 text-sm font-bold text-slate-950 transition active:scale-95"
                    >
                      结束发言
                    </button>
                  </>
                ) : (
                  <p className="mt-3 text-center text-base font-bold text-slate-300">
                    等待 {currentSpeaker} 号警上发言 · 剩余 {talkRemainSec} 秒
                  </p>
                )}
                {!deadSeats.includes(myRole?.seat ?? -1) &&
                  sheriffCandidates.includes(myRole?.seat ?? -1) && (
                    <button
                      type="button"
                      onClick={submitSheriffWithdraw}
                      className="mt-4 w-full rounded-2xl border border-rose-500/60 bg-rose-500/10 py-3 text-sm font-bold text-rose-300 transition active:scale-95"
                    >
                      退水（退出竞选）
                    </button>
                  )}
              </div>
            )}

            {/* 警长竞选：警下投票 */}
            {sheriffStage === 'vote' && (
              <div className="mt-4 rounded-xl border border-slate-700 bg-slate-900/60 px-4 py-4">
                <p className="text-center text-base font-bold text-amber-300">
                  警下投票 · 请选择警长
                </p>
                <p className="mt-1 text-center text-sm text-slate-400">
                  {sheriffRemainSec !== null ? `剩余 ${sheriffRemainSec} 秒` : ''}
                  {sheriffCandidates.includes(myRole?.seat ?? -1)
                    ? '（警上玩家不参与投票）'
                    : ''}
                </p>
                {deadSeats.includes(myRole?.seat ?? -1) ||
                sheriffCandidates.includes(myRole?.seat ?? -1) ? (
                  <p className="mt-3 text-center text-sm text-slate-500">
                    {deadSeats.includes(myRole?.seat ?? -1)
                      ? '你已经出局，正在观战'
                      : '你是警上玩家，等待警下投票结果'}
                  </p>
                ) : mySheriffVote !== null ? (
                  <p className="mt-3 rounded-xl border border-emerald-500/40 bg-emerald-500/10 px-4 py-3 text-center text-sm text-emerald-300">
                    已投给 {mySheriffVote} 号（等待计票…）
                  </p>
                ) : (
                  <div className="mt-3 grid grid-cols-3 gap-2">
                    {sheriffCandidates.map((seat) => (
                      <button
                        key={seat}
                        type="button"
                        onClick={() => submitSheriffVote(seat)}
                        className="rounded-xl border border-amber-500/50 bg-slate-950 py-3 text-sm font-bold text-amber-300 transition active:scale-95"
                      >
                        {seat} 号
                      </button>
                    ))}
                  </div>
                )}
              </div>
            )}

            {/* 警长当选结果 */}
            {sheriffElectedInfo !== null && sheriffElectedInfo.seat !== null && (
              <div className="mt-4 rounded-xl border border-amber-500/40 bg-amber-500/10 px-4 py-3 text-center">
                <p className="text-base font-bold text-amber-300">
                  👑 {sheriffElectedInfo.seat} 号（{sheriffElectedInfo.name ?? ''}）当选警长
                </p>
                <p className="mt-0.5 text-xs text-slate-400">正在选择发言顺序…</p>
              </div>
            )}

            {/* 警长决定发言方向（仅警长本人） */}
            {sheriffStage === 'order' && (myRole?.seat ?? -1) === sheriffSeat && (
              <div className="mt-4 rounded-xl border border-amber-500/40 bg-slate-900/80 px-4 py-4">
                <p className="text-center text-base font-bold text-amber-300">
                  你当选警长，请决定发言顺序
                </p>
                <div className="mt-3 grid grid-cols-2 gap-3">
                  {(
                    [
                      ['dead_left', '从死左发言'],
                      ['dead_right', '从死右发言'],
                      ['sheriff_left', '从警左发言'],
                      ['sheriff_right', '从警右发言'],
                    ] as const
                  ).map(([dir, label]) => (
                    <button
                      key={dir}
                      type="button"
                      onClick={() => submitSheriffOrder(dir)}
                      className="rounded-2xl bg-amber-500 py-4 text-sm font-bold text-slate-950 transition active:scale-95"
                    >
                      {label}
                    </button>
                  ))}
                </div>
              </div>
            )}

            {/* 警长出局：移交/撕毁警徽（仅警长本人）；其他人等待 */}
            {sheriffStage === 'death' &&
              (myRole?.seat ?? -1) === sheriffSeat && (
                <div className="mt-4 rounded-xl border border-amber-500/40 bg-slate-900/80 px-4 py-4">
                  <p className="text-center text-base font-bold text-amber-300">
                    你出局了，请处理警徽
                  </p>
                  <p className="mt-1 text-center text-sm text-slate-400">
                    移交给存活玩家，或撕毁警徽
                  </p>
                  <div className="mt-3 grid grid-cols-3 gap-2">
                    {sheriffAliveSeats.map((seat) => (
                      <button
                        key={seat}
                        type="button"
                        onClick={() => submitSheriffGiveaway(seat)}
                        className="rounded-xl border border-amber-500/50 bg-slate-950 py-3 text-sm font-bold text-amber-300 transition active:scale-95"
                      >
                        {seat} 号
                      </button>
                    ))}
                  </div>
                  <button
                    type="button"
                    onClick={() => submitSheriffGiveaway(null)}
                    className="mt-3 w-full rounded-2xl border border-rose-500/60 bg-rose-500/10 py-2 text-sm font-bold text-rose-300 transition active:scale-95"
                  >
                    撕毁警徽
                  </button>
                </div>
              )}
            {sheriffStage === 'death' &&
              (myRole?.seat ?? -1) !== sheriffSeat && (
                <div className="mt-4 rounded-xl border border-dashed border-slate-700 px-4 py-3 text-center text-sm text-slate-400">
                  👑 警长出局，正在处理警徽…
                </div>
              )}

            {/* 发言阶段：按顺序轮流发言，只有当前发言者可过麦 */}
            {dayStage === 'talk' && (
              <div className="mt-4 rounded-xl border border-slate-700 bg-slate-900/60 px-4 py-4">
                {currentSpeaker === null ? (
                  <p className="text-center text-sm text-slate-400">正在准备发言顺序…</p>
                ) : deadSeats.includes(myRole?.seat ?? -1) ? (
                  <p className="text-center text-sm text-slate-500">
                    你已经出局，正在观战。当前：{currentSpeaker}号玩家发言中
                  </p>
                ) : (myRole?.seat ?? -1) === currentSpeaker ? (
                  <>
                    <p className="text-center text-base font-bold text-amber-300">
                      {currentSpeaker === sheriffSeat ? '👑 ' : ''}你是 {currentSpeaker} 号，轮到你了
                    </p>
                    <p className="mt-1 text-center text-sm text-slate-400">
                      发言剩余 {talkRemainSec} 秒
                    </p>
                    <button
                      type="button"
                      onClick={() => {
                        const msg: ClientMessage = { type: 'talkDone', playerId }
                        socket?.send(JSON.stringify(msg))
                      }}
                      className="mt-4 w-full rounded-2xl bg-amber-500 py-2 text-sm font-bold text-slate-950 transition active:scale-95"
                    >
                      结束发言
                    </button>
                  </>
                ) : (
                  <>
                    <p className="text-center text-base font-bold text-slate-300">
                      {currentSpeaker === sheriffSeat ? '👑 ' : ''}等待 {currentSpeaker} 号玩家发言
                    </p>
                    <p className="mt-1 text-center text-sm text-slate-400">
                      {currentSpeaker} 号剩余 {talkRemainSec} 秒
                    </p>
                  </>
                )}
                {/* 警长抢先发言：本白天仅一次；发言完毕后点"结束发言"，当天不能再发言 */}
                {(myRole?.seat ?? -1) === sheriffSeat &&
                  !deadSeats.includes(myRole?.seat ?? -1) &&
                  !sheriffHasSpokenThisDay &&
                  currentSpeaker !== null &&
                  currentSpeaker !== (myRole?.seat ?? -1) && (
                    <button
                      type="button"
                      onClick={() => {
                        const msg: ClientMessage = {
                          type: 'sheriffInterrupt',
                          playerId,
                        }
                        socket?.send(JSON.stringify(msg))
                      }}
                      className="mt-3 w-full rounded-2xl border border-amber-500/60 bg-amber-500/10 py-3 text-base font-bold text-amber-300 transition active:scale-95"
                    >
                      👑 抢先发言
                    </button>
                  )}
              </div>
            )}

            {/* 投票阶段：所有存活玩家弹出投票框 */}
            {dayStage === 'vote' && (
              <div className="mt-2">
                {deadSeats.includes(myRole?.seat ?? -1) ? (
                  <p className="rounded-xl border border-dashed border-slate-700 px-4 py-4 text-center text-sm text-slate-500">
                    你已经出局，正在观战（本局投票与你无关）
                  </p>
                ) : votedSeat !== null ? (
                  <p className="rounded-xl border border-emerald-500/40 bg-emerald-500/10 px-4 py-4 text-center text-sm text-emerald-300">
                    已投票：{votedSeat}号，等待其他玩家…
                  </p>
                ) : (
                  <>
                    <p className="text-sm text-slate-300">
                      {myRole?.seat === sheriffSeat
                        ? '👑 你是警长，你的票 = 1.5 票：'
                        : '请投票放逐一名玩家'}
                    </p>
                    <div className="mt-2 grid grid-cols-6 gap-1.5">
                      {aliveSeats.map((seat) => (
                        <button
                          key={seat}
                          type="button"
                          onClick={() => setDayVoteTarget(dayVoteTarget === seat ? null : seat)}
                          className={`relative rounded-lg py-1.5 text-xs font-bold transition active:scale-95 ${
                            dayVoteTarget === seat
                              ? 'bg-emerald-500 text-slate-950'
                              : 'border border-slate-700 bg-slate-950 text-slate-300'
                          }`}
                        >
                          {seat}号
                          {mutedSeat === seat && (
                            <span className="absolute -top-2 -right-1 rounded-md bg-rose-500/90 px-1 py-0.5 text-[10px] font-bold text-white">
                              🚫+1
                            </span>
                          )}
                        </button>
                      ))}
                    </div>
                    <button
                      type="button"
                      onClick={submitDayVote}
                      disabled={dayVoteTarget === null}
                      className="mt-2 w-full rounded-2xl bg-emerald-500 py-2 text-sm font-bold text-slate-950 transition active:scale-95 disabled:cursor-not-allowed disabled:opacity-40"
                    >
                      提交投票
                    </button>
                  </>
                )}
              </div>
            )}

            {/* 计票结果 */}
            {dayStage === 'result' && (
              <div className="mt-4">
                {voteTally.length > 0 && (
                  <div className="rounded-xl border border-slate-800 bg-slate-950 p-3">
                    <p className="text-xs text-slate-400">票数统计</p>
                    {voteTally.map((t) => (
                      <p key={t.seat} className="mt-1 text-sm text-slate-300">
                        {t.seat}号{t.seat === sheriffSeat ? '（👑警长）' : ''}：{t.count}票
                      </p>
                    ))}
                  </div>
                )}
                {voteTie ? (
                  <p className="mt-3 rounded-xl border border-amber-500/40 bg-amber-500/10 px-4 py-4 text-center text-base font-bold text-amber-300">
                    平票，本轮无人出局
                  </p>
                ) : voteExiled !== null ? (
                  <p className="mt-3 rounded-xl border border-rose-500/40 bg-rose-500/10 px-4 py-4 text-center text-base font-bold text-rose-300">
                    {voteExiled}号被放逐
                  </p>
                ) : null}
                {gunShotInfo && (
                  <p className="mt-3 rounded-xl border border-rose-500/40 bg-rose-500/10 px-4 py-3 text-center text-sm text-rose-200">
                    {gunShotInfo.shooter}号玩家发动技能，带走了 {gunShotInfo.target}号玩家
                  </p>
                )}
                {!gunPanelInfo && !gunShotInfo && (
            <p className="mt-1.5 text-center text-[10px] text-slate-500">
                    正在进入下一夜…
                  </p>
                )}
              </div>
            )}

            {/* 开枪阶段：被放逐的猎人/狼王/猎魔人面板（只弹给被放逐者本人） */}
            {dayStage === 'gun' && (
              <div className="mt-4">
                {gunPanelInfo && gunPanelInfo.seat === myRole?.seat ? (
                  <>
                    <p className="rounded-xl border border-rose-500/40 bg-rose-500/10 px-4 py-3 text-center text-base font-bold text-rose-300">
                      你被放逐了（{gunPanelInfo.roleName}），可以发动技能带走一名玩家
                    </p>
                    <div className="mt-2 grid grid-cols-6 gap-1.5">
                      {aliveSeatInfo.map((s) => (
                        <button
                          key={s.seat}
                          type="button"
                          onClick={() => setMyGunTarget(myGunTarget === s.seat ? null : s.seat)}
                          className={`rounded-lg py-1.5 text-xs font-bold transition active:scale-95 ${
                            myGunTarget === s.seat
                              ? 'bg-rose-500 text-slate-950'
                              : 'border border-slate-700 bg-slate-950 text-slate-300'
                          }`}
                        >
                          {s.seat}号
                        </button>
                      ))}
                    </div>
                    <button
                      type="button"
                      onClick={submitGunTarget}
                      disabled={myGunTarget === null}
                      className="mt-3 w-full rounded-xl bg-rose-500 py-2 text-sm font-bold text-slate-950 transition active:scale-95 disabled:cursor-not-allowed disabled:opacity-40"
                    >
                      确认带走 {myGunTarget !== null ? `${myGunTarget}号` : ''}
                    </button>
                  </>
                ) : (
                  <p className="rounded-xl border border-dashed border-slate-700 px-4 py-4 text-center text-sm text-slate-500">
                    等待被放逐者发动技能…
                  </p>
                )}
              </div>
            )}
          </section>
        )}

        {game.phase !== 'waiting' && (
          <>
            <section className="mt-8">
              <h2 className="text-sm font-medium text-slate-400">
                查看身份（测试用，点按座位查看）
              </h2>
              <div className="mt-3 grid grid-cols-4 gap-3">
                {seats.map((seat) => (
                  <button
                    key={seat}
                    type="button"
                    onClick={() => setRevealSeat(seat)}
                    className="rounded-xl border border-slate-700 bg-slate-900 py-3 text-sm font-medium transition active:scale-95"
                  >
                    {seat}号玩家
                  </button>
                ))}
              </div>
            </section>

            {game.phase === 'night' && currentStep && (
              <section className="mt-8 rounded-2xl border border-amber-500/40 bg-slate-900 p-6">
                <p className="text-xs text-slate-400">
                  系统流程测试面板 · 第 {game.dayCount} 夜 · 第 {game.nightIndex + 1}/
                  {nightSteps.length} 步
                </p>
                <p className="mt-3 text-lg font-bold">{currentStep.name} 行动</p>
                <p className="mt-2 text-sm leading-relaxed text-slate-300">
                  {currentStep.prompt}
                </p>

                {currentStep.key === 'witch' && witchChoice === null && (
                  <div className="mt-5 flex flex-col gap-3">
                    <button
                      type="button"
                      onClick={() => setWitchChoice('heal')}
                      className="w-full rounded-xl bg-emerald-500 py-2 text-sm font-bold text-slate-950 transition active:scale-95"
                    >
                      解药救人
                    </button>
                    <button
                      type="button"
                      onClick={() => setWitchChoice('poison')}
                      className="w-full rounded-xl bg-rose-500 py-2 text-sm font-bold text-slate-950 transition active:scale-95"
                    >
                      毒药杀人
                    </button>
                    <button
                      type="button"
                      onClick={() => setWitchChoice('none')}
                      className="w-full rounded-2xl bg-slate-700 py-2 text-sm font-bold text-slate-100 transition active:scale-95"
                    >
                      不用药
                    </button>
                  </div>
                )}

                {(currentStep.needTarget ||
                  (currentStep.key === 'witch' &&
                    witchChoice !== null &&
                    witchChoice !== 'none')) && (
                  <>
                    <p className="mt-5 text-xs text-slate-400">
                      点击座位选择目标（
                      {currentStep.key === 'witch'
                        ? '选 1 名玩家'
                        : currentStep.targetCount === 2
                          ? '依次选 2 名玩家，可点取消'
                          : '选 1 名玩家，可点取消'}
                      ）
                    </p>
                    <div className="mt-2 grid grid-cols-4 gap-3">
                      {seats
                        .filter((seat) => !game.deaths.includes(seat))
                        .map((seat) => {
                        const selected = nightTargets.includes(seat)
                        return (
                          <button
                            key={seat}
                            type="button"
                            onClick={() => handleSeatSelect(seat)}
                            className={`rounded-lg py-1.5 text-xs font-bold transition active:scale-95 ${
                              selected
                                ? 'bg-amber-500 text-slate-950'
                                : 'border border-slate-700 bg-slate-950 text-slate-300'
                            }`}
                          >
                            {seat}号
                          </button>
                        )
                      })}
                    </div>
                  </>
                )}

                <div className="mt-6 flex flex-col gap-3">
                  {currentStep.canSkip && (
                    <button
                      type="button"
                      onClick={handleSkipStep}
                      className="w-full rounded-2xl bg-slate-700 py-2 text-sm font-bold text-slate-100 transition active:scale-95"
                    >
                      跳过（不使用技能）
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={handleNextStep}
                    disabled={!canNext}
                    className="w-full rounded-2xl bg-amber-500 py-2 text-sm font-bold text-slate-950 shadow-lg shadow-amber-500/30 transition active:scale-95 disabled:cursor-not-allowed disabled:opacity-40 disabled:active:scale-100"
                  >
                    {isLastStep ? '天亮了' : '下一步'}
                  </button>
                </div>
              </section>
            )}

            {game.phase === 'day' && (
              <section className="mt-8 rounded-2xl border border-rose-500/40 bg-slate-900 p-6">
                <p className="text-xs text-slate-400">天亮 · 第 {game.dayCount} 天</p>

                <p className="mt-3 text-2xl font-bold">昨晚死讯</p>
                {game.deaths.length > 0 ? (
                  <>
                    <p className="mt-3 text-lg font-medium text-rose-400">
                      {game.deaths.map((seat) => `${seat}号玩家死亡`).join('、')}
                    </p>
                    <p className="mt-2 text-sm text-slate-400">
                      请按规则处理死亡玩家的身份牌
                    </p>
                  </>
                ) : (
                  <p className="mt-3 text-lg font-medium text-emerald-400">
                    昨晚是平安夜
                  </p>
                )}

                {game.dayStage === 'deaths' && (
                  <button
                    type="button"
                    onClick={startVote}
                    className="mt-6 w-full rounded-2xl bg-amber-500 py-2 text-sm font-bold text-slate-950 shadow-lg shadow-amber-500/30 transition active:scale-95"
                  >
                    发起投票
                  </button>
                )}

                {game.dayStage === 'vote' && (
                  <>
                    <p className="mt-5 text-sm font-bold">投票放逐（点选被放逐玩家）</p>
                    <div className="mt-3 grid grid-cols-4 gap-3">
                      {seats.map((seat) => (
                        <button
                          key={seat}
                          type="button"
                          onClick={() => setVoteSeat(seat)}
                          className={`rounded-lg py-1.5 text-xs font-bold transition active:scale-95 ${
                            voteSeat === seat
                              ? 'bg-amber-500 text-slate-950'
                              : 'border border-slate-700 bg-slate-950 text-slate-300'
                          }`}
                        >
                          {seat}号
                        </button>
                      ))}
                    </div>
                    <div className="mt-4 flex flex-col gap-3">
                      <button
                        type="button"
                        onClick={confirmExile}
                        disabled={voteSeat === null}
                        className="w-full rounded-xl bg-rose-500 py-2 text-sm font-bold text-slate-950 transition active:scale-95 disabled:cursor-not-allowed disabled:opacity-40"
                      >
                        确认放逐{voteSeat !== null ? ` ${voteSeat}号玩家` : ''}
                      </button>
                      <button
                        type="button"
                        onClick={markTie}
                        className="w-full rounded-2xl bg-slate-700 py-2 text-sm font-bold text-slate-100 transition active:scale-95"
                      >
                        标记平票（无人出局）
                      </button>
                      <button
                        type="button"
                        onClick={cancelVote}
                        className="w-full rounded-2xl border border-slate-700 py-2 text-sm font-bold text-slate-300 transition active:scale-95"
                      >
                        取消投票
                      </button>
                    </div>
                  </>
                )}

                {game.dayStage === 'exile' && game.exiledSeat !== null && (
                  <>
                    <p className="mt-5 text-lg font-bold text-rose-400">
                      {game.exiledSeat}号玩家被放逐
                    </p>
                    <p className="mt-0.5 text-xs text-slate-400">该玩家是否有遗言？</p>
                    <div className="mt-4 flex flex-col gap-3">
                      <button
                        type="button"
                        onClick={() => handleLastWords(true)}
                        className="w-full rounded-2xl bg-amber-500 py-2 text-sm font-bold text-slate-950 transition active:scale-95"
                      >
                        有遗言
                      </button>
                      <button
                        type="button"
                        onClick={() => handleLastWords(false)}
                        className="w-full rounded-2xl bg-slate-700 py-2 text-sm font-bold text-slate-100 transition active:scale-95"
                      >
                        无遗言
                      </button>
                    </div>
                  </>
                )}

                {game.dayStage === 'gun' && game.exiledSeat !== null && (
                  <>
                    <p className="mt-5 text-lg font-bold">
                      {`${game.exiledSeat}号玩家是${exiledRole?.name ?? '该角色'}，是否${gunActionLabel}？`}
                    </p>
                    {!gunArming ? (
                      <div className="mt-4 flex flex-col gap-3">
                        <button
                          type="button"
                          onClick={() => setGunArming(true)}
                          className="w-full rounded-xl bg-rose-500 py-2 text-sm font-bold text-slate-950 transition active:scale-95"
                        >
                          {gunActionLabel}
                        </button>
                        <button
                          type="button"
                          onClick={handleGunNoShoot}
                          className="w-full rounded-2xl bg-slate-700 py-2 text-sm font-bold text-slate-100 transition active:scale-95"
                        >
                          不{gunActionLabel}
                        </button>
                      </div>
                    ) : (
                      <>
                        <p className="mt-4 text-sm text-slate-400">
                          点击座位选择{gunActionLabel}带走的玩家
                        </p>
                        <div className="mt-2 grid grid-cols-4 gap-3">
                          {seats.map((seat) => (
                            <button
                              key={seat}
                              type="button"
                              onClick={() => handleGunShoot(seat)}
                              className="rounded-xl border border-slate-700 bg-slate-950 py-3 text-sm font-bold text-slate-300 transition active:scale-95"
                            >
                              {seat}号
                            </button>
                          ))}
                        </div>
                        <button
                          type="button"
                          onClick={() => setGunArming(false)}
                          className="mt-4 w-full rounded-2xl border border-slate-700 py-2 text-sm font-bold text-slate-300 transition active:scale-95"
                        >
                          取消{gunActionLabel}
                        </button>
                      </>
                    )}
                  </>
                )}

                {game.dayStage === 'summary' && (
                  <>
                    <p className="mt-5 text-lg font-bold text-emerald-400">
                      白天流程完成
                    </p>
                    <ul className="mt-3 flex flex-col gap-2">
                      {game.dayLog.map((note, index) => (
                        <li
                          key={index}
                          className="rounded-xl border border-slate-800 bg-slate-950 px-4 py-3 text-sm text-slate-300"
                        >
                          {note}
                        </li>
                      ))}
                    </ul>
                    <button
                      type="button"
                      onClick={enterNight}
                      className="mt-5 w-full rounded-2xl bg-amber-500 py-2 text-sm font-bold text-slate-950 shadow-lg shadow-amber-500/30 transition active:scale-95"
                    >
                      进入黑夜
                    </button>
                  </>
                )}
              </section>
            )}

            {game.nightLog.length > 0 && (
              <section className="mt-8">
                <h2 className="text-sm font-medium text-slate-400">
                  夜晚操作记录
                </h2>
                <ul className="mt-3 flex flex-col gap-2">
                  {game.nightLog.map((action, index) => (
                    <li
                      key={index}
                      className="rounded-xl border border-slate-800 bg-slate-900 px-3 py-2 text-sm text-slate-300"
                    >
                      <span className="text-slate-500">{action.stepName}：</span>
                      {action.note}
                    </li>
                  ))}
                </ul>
              </section>
            )}

            {game.phase === 'day' && game.dayLog.length > 0 && (
              <section className="mt-8">
                <h2 className="text-sm font-medium text-slate-400">白天记录</h2>
                <ul className="mt-3 flex flex-col gap-2">
                  {game.dayLog.map((note, index) => (
                    <li
                      key={index}
                      className="rounded-xl border border-slate-800 bg-slate-900 px-3 py-2 text-sm text-slate-300"
                    >
                      {note}
                    </li>
                  ))}
                </ul>
              </section>
            )}

            <button
              type="button"
              onClick={() => setShowRecap(true)}
              className="mt-10 w-full rounded-2xl bg-rose-500 py-2 text-sm font-bold text-slate-950 shadow-lg shadow-rose-500/30 transition active:scale-95"
            >
              结束游戏（复盘）
            </button>
            <button
              type="button"
              onClick={resetGame}
              className="mt-4 w-full rounded-2xl border border-slate-700 py-2 text-sm font-bold text-slate-300 transition active:scale-95"
            >
              重置游戏
            </button>
          </>
        )}
      </div>

      {myRole && showRoleModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 px-8">
          <div className="w-full max-w-sm rounded-3xl border border-slate-700 bg-slate-900 p-8 text-center">
            <p className="text-sm text-slate-400">{myRole.seat}号玩家</p>
            <p className="mt-4 text-xl font-bold">你的身份是</p>
            <p className="mt-2 text-4xl font-black text-amber-400">
              {myRole.roleName}
            </p>
            <button
              type="button"
              onClick={() => setShowRoleModal(false)}
              className="mt-8 w-full rounded-2xl bg-amber-500 py-2 text-sm font-bold text-slate-950 shadow-lg shadow-amber-500/30 transition active:scale-95"
            >
              关闭
            </button>
          </div>
        </div>
      )}

      {revealSeat !== null && revealedRole && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 px-8">
          <div className="w-full max-w-sm rounded-3xl border border-slate-700 bg-slate-900 p-8 text-center">
            <p className="text-sm text-slate-400">{revealSeat}号玩家</p>
            <p className="mt-4 text-xl font-bold">你的身份是</p>
            <p className="mt-2 text-4xl font-black text-amber-400">
              {revealedRole.name}
            </p>
            <p className="mt-3 text-sm text-slate-400">
              阵营：{CAMP_LABEL[revealedRole.camp]}
            </p>
            <button
              type="button"
              onClick={() => setRevealSeat(null)}
              className="mt-8 w-full rounded-2xl bg-amber-500 py-2 text-sm font-bold text-slate-950 shadow-lg shadow-amber-500/30 transition active:scale-95"
            >
              关闭
            </button>
          </div>
        </div>
      )}

      {showRecap && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 px-6 py-10">
          <div className="max-h-[85dvh] w-full max-w-sm overflow-y-auto rounded-3xl border border-slate-700 bg-slate-900 p-6">
            <p className="text-center text-xl font-bold">游戏复盘</p>
            <p className="mt-1 text-center text-xs text-slate-400">
              所有玩家的真实身份
            </p>
            <ul className="mt-4 flex flex-col gap-2">
              {game.deal.map((role) => (
                <li
                  key={role.seat}
                  className="flex items-center justify-between rounded-xl border border-slate-800 bg-slate-950 px-4 py-3"
                >
                  <span className="text-sm text-slate-300">{role.seat}号玩家</span>
                  <span className="text-sm font-bold text-amber-400">
                    {role.name}（{CAMP_LABEL[role.camp]}）
                  </span>
                </li>
              ))}
            </ul>
            {game.nightLog.length > 0 && (
              <>
                <p className="mt-5 text-sm font-medium text-slate-400">
                  夜晚操作记录
                </p>
                <ul className="mt-2 flex flex-col gap-2">
                  {game.nightLog.map((action, index) => (
                    <li
                      key={index}
                      className="rounded-xl border border-slate-800 bg-slate-950 px-4 py-3 text-sm text-slate-300"
                    >
                      <span className="text-slate-500">{action.stepName}：</span>
                      {action.note}
                    </li>
                  ))}
                </ul>
              </>
            )}
            {game.dayLog.length > 0 && (
              <>
                <p className="mt-5 text-sm font-medium text-slate-400">白天记录</p>
                <ul className="mt-2 flex flex-col gap-2">
                  {game.dayLog.map((note, index) => (
                    <li
                      key={index}
                      className="rounded-xl border border-slate-800 bg-slate-950 px-4 py-3 text-sm text-slate-300"
                    >
                      {note}
                    </li>
                  ))}
                </ul>
              </>
            )}
            <button
              type="button"
              onClick={() => setShowRecap(false)}
              className="mt-6 w-full rounded-2xl bg-amber-500 py-2 text-sm font-bold text-slate-950 shadow-lg shadow-amber-500/30 transition active:scale-95"
            >
              关闭
            </button>
          </div>
        </div>
      )}
    </div>
  )
}

export default Room
