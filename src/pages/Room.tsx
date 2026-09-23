import { useEffect, useRef, useState } from 'react'
import { Link, useParams, useSearchParams, useNavigate } from 'react-router-dom'
import VoiceRoom from '../VoiceRoom'

/** 随机搞笑头像池（12 张，位于 public/avatars），游戏开始后随机分发给各座位 */
// 头像由服务端统一分配 avatarIdx（1..12），前端拼 URL：/avatars/avatar-01.jpg … avatar-12.jpg
import RoleActionPanel from '../components/RoleActionPanel'
import { boards, type Board, type Camp } from '../data/boards'
import { ROLES } from '../data/roles'
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
  type SeatRole,
} from '../game/game'

type WitchChoice = 'heal' | 'poison' | 'none' | null

const CAMP_LABEL: Record<Camp, string> = {
  wolf: '狼人阵营',
  good: '好人阵营',
  third: '第三方阵营',
}

/** 线下法官助手：每个夜间步骤的一句话操作提示（完整技能说明见"查看角色"，面板不展示长文） */
const JUDGE_STEP_HINTS: Record<string, string> = {
  lonely_girl: '喊：觉醒孤独少女睁眼，选 1 名玩家作为偶像（不能选自己）。点座位号记录。',
  cupid: '喊：丘比特睁眼，选 2 名玩家成为情侣。依次点两个座位号。',
  lovers: '喊：情侣睁眼，互相确认对方号码即可，不用操作，点下一步。',
  nightmare: '喊：噩梦之影睁眼，选 1 名玩家恐惧（被恐惧者今晚不能行动）。',
  dream_weaver: '喊：摄梦人睁眼，选 1 名玩家梦游（不能选自己）。',
  wolf_queen: '喊：蚀时狼妃睁眼，选 1 名玩家封锁（也可不使用技能）。',
  werewolf: '喊：狼人睁眼，统一选今晚要刀的 1 名玩家。',
  witch: '喊：女巫睁眼，顶部显示刀口，可选解药救人/毒药杀人/不用药。',
  seer: '喊：预言家睁眼，选 1 名玩家查验（金水/查杀）。',
  raven: '喊：乌鸦睁眼，选 1 名玩家诅咒（白天禁言+被放逐多1票），可跳过。',
  hunter: '猎人夜间确认（夜间不用操作，被刀/被放逐时才可开枪）。',
  demon_hunter: '喊：猎魔人睁眼（第二晚起），选 1 名玩家狩猎，可跳过。',
  wolf_king: '狼王夜间确认（夜间不用操作，被刀/被放逐时才可开枪）。',
  cursed_fox: '咒狐无夜间行动，直接下一步。',
  wolf_witch: '喊：狼巫睁眼，选 1 名玩家查验具体身份。',
}

/** 夜晚步骤目标需求兜底（NIGHT_STEPS 未覆盖的通用板子角色 -> 需要选号码的数量） */
const STEP_TARGET_FALLBACK: Record<string, { needTarget: boolean; targetCount: number }> = {
  lonely_girl: { needTarget: true, targetCount: 1 },
  cupid: { needTarget: true, targetCount: 2 },
  nightmare: { needTarget: true, targetCount: 1 },
  seer: { needTarget: true, targetCount: 1 },
  raven: { needTarget: true, targetCount: 1 },
  demon_hunter: { needTarget: true, targetCount: 1 },
  wolf_witch: { needTarget: true, targetCount: 1 },
}

/** 夜晚步骤名兜底（NIGHT_STEPS 未覆盖的通用板子步骤 -> 中文名） */
const STEP_NAME_FALLBACK: Record<string, string> = {
  lonely_girl: '觉醒孤独少女',
  cupid: '丘比特',
  lovers: '情侣',
  nightmare: '噩梦之影',
  seer: '预言家',
  raven: '乌鸦',
  hunter: '猎人',
  demon_hunter: '猎魔人',
  wolf_king: '狼王',
  wolf_witch: '狼巫',
  wolf_queen: '蚀时狼妃',
  werewolf: '狼人',
  witch: '女巫',
  dream_weaver: '摄梦人',
  awake_seer: '觉醒预言家',
  mirror_girl: '魔镜少女',
  demon_hunter_1: '猎魔人1',
  demon_hunter_2: '猎魔人2',
  cursed_fox: '咒狐',
  sun_maid_devour: '蚀日侍女·吞噬',
  sun_maid_use: '蚀日侍女·使用技能',
  miracle_merchant: '奇迹商人',
  lucky_guy_receive: '幸运儿',
  lucky_guy_use: '幸运儿·使用技能',
  awake_wolf_beauty: '觉醒狼美人',
}

/** 蚀日侍女：吞噬角色 -> 获得的技能类型 */
const SUN_MAID_SKILL_MAP: Record<string, string> = {
  witch: 'poison',
  dream_weaver: 'guard',
  raven: 'curse',
  nightmare: 'fear',
  wolf_queen: 'block',
  seer: 'check',
  awake_seer: 'check2',
  mirror_girl: 'identity',
  demon_hunter: 'hunt',
}
/** 蚀日侍女：技能类型 -> 显示名 */
const SUN_MAID_SKILL_NAMES: Record<string, string> = {
  poison: '毒药',
  guard: '守护',
  curse: '诅咒',
  fear: '恐惧',
  block: '封锁',
  check: '查验',
  check2: '查验二人',
  identity: '查验具体身份',
  hunt: '狩猎',
}

/** 蚀日侍女本晚吞噬技能：优先状态字段，兜底从 nightLog 吞噬记录反推 */
const getSunMaidSkill = (g: SavedGame): string | null => {
  if (g.sunMaidSkill) return g.sunMaidSkill
  const dev = g.nightLog.find((a) => a.stepKey === 'sun_maid_devour')
  if (!dev?.target) return null
  const role = g.deal.find((r) => r.seat === dev.target)
  return role ? (SUN_MAID_SKILL_MAP[role.key] ?? null) : null
}

/** 当前步骤所属角色阵营（特殊步骤映射到实际角色；未分配时按角色规则兜底） */
const getStepCamp = (g: SavedGame, stepKey: string): string => {
  if (stepKey === 'lucky_guy_use' && g.luckySeat != null) {
    const lr = g.deal.find((x) => x.seat === g.luckySeat)
    if (lr) return lr.camp
  }
  const special: Record<string, string> = {
    sun_maid_devour: 'sun_maid',
    sun_maid_use: 'sun_maid',
    lucky_guy_receive: 'miracle_merchant',
    demon_hunter_1: 'demon_hunter',
    demon_hunter_2: 'demon_hunter',
    awake_wolf_beauty: 'awake_wolf_beauty',
    lovers: 'cupid',
  }
  const roleKey = special[stepKey] ?? stepKey
  const r = g.deal.find((x) => x.key === roleKey)
  if (r) return r.camp
  if (['sun_maid', 'werewolf', 'wolf_queen', 'wolf_witch', 'wolf_king', 'nightmare', 'awake_wolf_beauty'].includes(stepKey)) return 'wolf'
  if (['cupid', 'lonely_girl'].includes(stepKey)) return 'third'
  if (stepKey === 'cursed_fox') return 'fox'
  return 'good'
}

/** 号码按钮整体配色：按当前角色阵营统一（狼=红 好=蓝 第三=粉 咒狐=橙），低饱和柔和 */
const getCampCls = (g: SavedGame, stepKey: string): { sel: string; un: string } => {
  const camp = getStepCamp(g, stepKey)
  if (camp === 'wolf') return { sel: 'border border-rose-400/70 bg-rose-500/25 text-rose-100 ring-1 ring-rose-400/50', un: 'border border-rose-500/35 bg-rose-500/5 text-rose-300' }
  if (camp === 'fox') return { sel: 'border border-orange-400/70 bg-orange-500/25 text-orange-100 ring-1 ring-orange-400/50', un: 'border border-orange-500/35 bg-orange-500/5 text-orange-300' }
  if (camp === 'third') return { sel: 'border border-pink-400/70 bg-pink-500/25 text-pink-100 ring-1 ring-pink-400/50', un: 'border border-pink-500/35 bg-pink-500/5 text-pink-300' }
  return { sel: 'border border-sky-400/70 bg-sky-500/25 text-sky-100 ring-1 ring-sky-400/50', un: 'border border-sky-500/35 bg-sky-500/5 text-sky-300' }
}

/** 狼人环节需要分配的狼队成员：板子所有狼人阵营角色（含觉醒狼美人/蚀日侍女等特殊狼） */
const getWolfPackReqs = (board: Board): { roleKey: string; count: number }[] =>
  board.roles.filter((r) => r.camp === 'wolf').map((r) => ({ roleKey: r.key, count: r.count ?? 1 }))

/** 夜晚阶段 -> 需要分配的角色座位要求列表（null=该阶段不是独立角色，无需分配座位）
 *  狼人环节 = 普通狼人 + 觉醒狼美人 两个角色一并分配与行动（板子没有的角色自动跳过） */
const getStepRoleReqs = (stepKey: string): { roleKey: string; count: number }[] | null => {
  switch (stepKey) {
    case 'lovers':
    case 'lucky_guy_receive':
    case 'lucky_guy_use':
    case 'sun_maid_use':
      return null
    case 'sun_maid_devour':
      return [{ roleKey: 'sun_maid', count: 1 }]
    case 'demon_hunter_1':
      return [{ roleKey: 'demon_hunter', count: 1 }]
    case 'demon_hunter_2':
      return [{ roleKey: 'demon_hunter', count: 2 }]
    case 'werewolf':
      return [
        { roleKey: 'awake_wolf_beauty', count: 1 },
        { roleKey: 'werewolf', count: 1 },
      ]
    default:
      return [{ roleKey: stepKey, count: 1 }]
  }
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
  witchAntidoteCount: 1,
  witchPoisonCount: 1,
  wolfQueenUsed: false,
  prevRavenTarget: null,
  lonelyConverted: false,
  lonelyIdol: null,
  lonelyInherited: null,
}

function Room() {
  const { roomId } = useParams<{ roomId: string }>()
  const [searchParams] = useSearchParams()
  const nickname = searchParams.get('nickname') || ''
  const spectatorMode = searchParams.get('spectator') === '1'
  const navigate = useNavigate()

  // demo 模式：法官选择板子（含咒狐 / 含猎魔人）
  const [demoBoardIndex, setDemoBoardIndex] = useState(0)
  // 从 URL 中解析创建/加入时传入的板子数据
  const boardParam = searchParams.get('board')
  let currentBoard: Board = boards[0]
  if (boardParam) {
    try {
      currentBoard = JSON.parse(boardParam) as Board
    } catch {
      currentBoard = boards[0]
    }
  } else if (roomId === 'demo') {
    currentBoard = boards[demoBoardIndex] ?? boards[0]
  }

  const seatCount = currentBoard.playerCount
  const isDemo = roomId === 'demo'
  // 强制昵称：无昵称直接回首页（线下法官助手 demo 不强制）
  useEffect(() => {
    if (!isDemo && !nickname.trim()) navigate('', { replace: true })
  }, [nickname, isDemo, navigate])
  const roleList = currentBoard.roles.map((role) => role.name).join('、')

  // 游戏状态：优先从本地恢复（刷新后继续主持），旧存档自动补齐白天字段
  const [game, setGame] = useState<SavedGame>(() => {
    // 线下法官助手：不恢复上次牌局，每次进入都从手动配牌开始
    if (roomId === 'demo') return { ...EMPTY_GAME }
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
  /** 线下法官助手：撤回历史栈，每一步改变游戏状态前快照旧状态，可连续撤回直至开局 */
  const [gameHistory, setGameHistory] = useState<SavedGame[]>([])
  const [showRecap, setShowRecap] = useState(false)

  // ---- WebSocket 房间连接（第一阶段：玩家列表实时同步） ----
  const [playerId] = useState(getOrCreatePlayerId)
  const [socket, setSocket] = useState<RoomSocket | null>(null)
  const [roster, setRoster] = useState<RoomPlayer[]>([])
  const [connState, setConnState] = useState<
    'connecting' | 'open' | 'closed'
  >('connecting')
  /** 断线自动重连计数：变化时重新建立 WebSocket 并重新 join（服务端按 playerId 沿用原座位） */
  const [reconnectTick, setReconnectTick] = useState(0)

  // ---- 第二阶段第一步：服务端发牌与身份私密查看 ----
  const [hostPlayerId, setHostPlayerId] = useState<string | null>(null)
  const [onlineStarted, setOnlineStarted] = useState(false)
  const [onlineSeats, setOnlineSeats] = useState<SeatInfo[]>([])
  /** 房主指定的测试身份：playerId -> 角色 key（空对象 = 全部随机发牌）——仅开发者模式可见 */
  const [testAssignments, setTestAssignments] = useState<Record<string, string>>({})
  /** 开发者模式（房主连续点击房间码 5 次，或长按顶部"房间"标题开启）：
   *  默认玩家界面完全隐藏测试功能，保持随机发牌；非房主触发完全无反应 */
  const [devMode, setDevMode] = useState(false)
  /** 线下法官助手：法官手动配牌（seat -> roleKey）与当前正在选角色的号码 */
  const [judgeAssign, setJudgeAssign] = useState<Record<number, string>>({})
  const [judgePickSeat, setJudgePickSeat] = useState<number | null>(null)
  /** 法官流程：行动记录弹层 */
  const [showJudgeLog, setShowJudgeLog] = useState(false)
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
  const [showDealtSeats, setShowDealtSeats] = useState(false)
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
  // ---- 幸运儿系统状态 ----
  /** 幸运儿座位号（奇迹商人发放技能后设置） */
  const [luckySeat, setLuckySeat] = useState<number | null>(null)
  /** 幸运儿获得的技能类型：查验/毒药/守护 */
  const [luckySkill, setLuckySkill] = useState<'check' | 'poison' | 'guard' | null>(null)
  /** 幸运儿技能是否已使用 */
  const [luckySkillUsed, setLuckySkillUsed] = useState(false)
  /** 幸运儿使用技能时选择的目标 */
  const [luckyTarget, setLuckyTarget] = useState<number | null>(null)
  /** 幸运儿使用阶段的决定：use/skip/null */
  const [luckyUseChoice, setLuckyUseChoice] = useState<'use' | 'skip' | null>(null)
  /** 奇迹商人选择幸运儿时的临时状态 */
  const [miracleStep, setMiracleStep] = useState<'select_target' | 'select_skill' | null>(null)
  // ---- 狼美人系统状态 ----
  /** 狼美人魅惑的目标座位号 */
  const [wolfBeautyTarget, setWolfBeautyTarget] = useState<number | null>(null)
  /** 狼美人替死是否已使用 */
  const [wolfBeautyUsed, setWolfBeautyUsed] = useState(false)  // ---- 白天流程状态 ----
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
    // 线下法官助手为临时配牌面板，不持久化
    if (roomId === 'demo') return
    saveGame(roomId ?? '', game)
  }, [game, roomId])

  // 连接 WebSocket 房间（server.js）：连接成功即上报昵称，并监听玩家列表广播；断线自动重连
  useEffect(() => {
    // 线下法官助手：纯本地面板，不连接服务器、不接入语音
    if (roomId === 'demo') {
      setConnState('closed')
      return
    }
    const room = roomId ?? 'demo'
    let reconnectTimer: ReturnType<typeof setTimeout>
    const s = createRoomSocket(room)
    setSocket(s)
    setConnState('connecting')

    const onOpen = () => {
      setConnState('open')
      const msg: ClientMessage = { type: 'join', playerId, nickname, spectator: spectatorMode }
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
    const onClosed = () => {
      setConnState('closed')
      // 断线（切后台/锁屏/刷新/网络抖动）后 2 秒自动重连；重连成功由 onOpen 重新 join，服务端按 playerId 恢复座位与游戏状态
      reconnectTimer = setTimeout(() => setReconnectTick((t) => t + 1), 2000)
    }

    s.addEventListener('open', onOpen)
    s.addEventListener('message', onMessage)
    s.addEventListener('close', onClosed)
    s.addEventListener('error', onClosed)

    return () => {
      clearTimeout(reconnectTimer)
      s.removeEventListener('open', onOpen)
      s.removeEventListener('message', onMessage)
      s.removeEventListener('close', onClosed)
      s.removeEventListener('error', onClosed)
      s.close()
    }
  }, [roomId, playerId, nickname, reconnectTick])

  // 线下法官助手：边走边分配，动态过滤夜晚步骤
  // 丘比特/情侣/咒狐仅第一晚出现；孤独少女每晚都睁眼（第一晚选崇拜，后续确认）
  const nightSteps: NightStepConfig[] = currentBoard.nightOrder
    .filter((key) => {
      // 丘比特和情侣仅第一晚
      if ((key === 'cupid' || key === 'lovers') && game.dayCount > 1) return false
      // 咒狐仅第一晚（知道座位即可）
      if (key === 'cursed_fox' && game.dayCount > 1) return false
      // 奇迹商人仅第一晚（每局限一次，用完不再睁眼）
      if (key === 'miracle_merchant' && game.dayCount > 1) return false
      // 幸运儿接收告知仅第一晚
      if (key === 'lucky_guy_receive' && game.dayCount > 1) return false
      // 蚀日侍女·使用技能：第一晚没有吞噬，排除
      if (key === 'sun_maid_use' && game.dayCount === 1) return false
      return true
    })
    .map((key) => {
      const base = NIGHT_STEPS.find((step) => step.key === key) ?? {
        key,
        name: STEP_NAME_FALLBACK[key] ?? key,
        prompt: `请 ${STEP_NAME_FALLBACK[key] ?? key} 睁眼（没有此角色可跳过）`,
        ...(STEP_TARGET_FALLBACK[key] ?? { needTarget: false, targetCount: 0 }),
        canSkip: true,
      }
      // 孤独少女：第一晚选崇拜，后续晚上提醒开刀状态（变狼/继承技能/未触发）
      if (key === 'lonely_girl' && (game.dayCount > 1 || game.lonelyIdol != null)) {
        const lonelyState = game.lonelyConverted
          ? '已变狼人（加入狼队）'
          : game.lonelyInherited
            ? `已继承偶像技能：${STEP_NAME_FALLBACK[game.lonelyInherited] ?? game.lonelyInherited}`
            : '偶像仍在，尚未触发'
        return { ...base, needTarget: false, prompt: `喊：孤独少女睁眼确认（${lonelyState}）。` }
      }
      // 蚀日侍女：第一晚仅认清狼同伴，不吞噬（第二晚起才行动）
      if (key === 'sun_maid_devour' && game.dayCount === 1) {
        return { ...base, needTarget: false, prompt: '喊：蚀日侍女睁眼，认清狼同伴（第一晚不吞噬，第二晚起才行动）。' }
      }
      // 猎魔人：第一晚睁眼但不能使用技能，第二晚起才可狩猎
      if ((key === 'demon_hunter' || key === 'demon_hunter_1' || key === 'demon_hunter_2') && game.dayCount === 1) {
        return { ...base, needTarget: false, prompt: '喊：' + base.name + '睁眼确认（第一晚不能使用技能，第二晚起才可狩猎）。' }
      }
      return base
    })
  const currentStep = nightSteps[game.nightIndex]
  // 安全保护：步骤越界时也视为最后一步，直接进白天
  const isLastStep = currentStep == null || game.nightIndex >= nightSteps.length - 1
  const seats = Array.from({ length: seatCount }, (_, index) => index + 1)
  /** 线下法官助手：累计出局座位（死亡/放逐/开枪） */
  const judgeGraveyard = game.graveyard ?? []
  const safeNightLog = game.nightLog ?? []
  const safeDeal = game.deal ?? []
  const exiledRole =
    game.exiledSeat !== null
      ? game.deal.find((role) => role.seat === game.exiledSeat)
      : undefined
  const gunActionLabel = exiledRole?.key === 'demon_hunter' ? '狩猎' : '开枪'

  /** 线下法官助手：改变游戏状态前把当前状态压入撤回栈 */
  const pushHistory = () => setGameHistory((h) => [...h, game])
  /** 线下法官助手：撤回上一步，连续可撤直至开局 */
  const undo = () => {
    if (gameHistory.length === 0) return
    const prev = gameHistory[gameHistory.length - 1]
    setGameHistory(gameHistory.slice(0, -1))
    setGame(prev)
    setNightTargets([])
    setWitchChoice(null)
    setVoteSeat(null)
    setGunArming(false)
    setRevealSeat(null)
  }

  /** 线下法官助手：点座位卡片切换淘汰/复活（只改存活，不改身份） */
  const toggleGraveyard = (seat: number) => {
    pushHistory()
    setGame((prev) => {
      const gy = prev.graveyard ?? []
      // 情侣殉情：淘汰情侣一方，另一方也跟着淘汰
      const lovers = prev.lovers ?? []
      const loverOther = lovers.find((l) => l !== seat && (lovers[0] === seat || lovers[1] === seat))
      if (gy.includes(seat)) {
        // 复活：同时复活情侣
        const next = gy.filter((s) => s !== seat && s !== loverOther)
        return { ...prev, graveyard: [...new Set(next)].sort((a, b) => a - b) }
      }
      let next = [...gy, seat]
      if (loverOther != null && !gy.includes(loverOther)) next = [...next, loverOther]
      return { ...prev, graveyard: [...new Set(next)].sort((a, b) => a - b) }
    })
  }

  const startGame = () => {
    setGameHistory([])
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

  /** 线下法官助手：边走边分配，法官喊到哪个角色就在手机上选座位 */
  const startJudgeGame = () => {
    setGameHistory([])
    setOnlineStarted(true)
    setGame({ ...EMPTY_GAME, deal: [], phase: 'night', dayCount: 1 })
    setNightTargets([])
    setWitchChoice(null)
    setVoteSeat(null)
    setGunArming(false)
    setRevealSeat(null)
    setShowRecap(false)
    setJudgePickSeat(null)
    setLuckySeat(null)
    setLuckySkill(null)
    setLuckySkillUsed(false)
    setLuckyTarget(null)
    setLuckyUseChoice(null)
    setMiracleStep(null)
    setWolfBeautyTarget(null)
    setWolfBeautyUsed(false)
  }

  const resetGame = () => {
    setGameHistory([])
    clearSavedGame(roomId ?? '')
    setOnlineStarted(false)
    setGame({ ...EMPTY_GAME })
    setNightTargets([])
    setWitchChoice(null)
    setVoteSeat(null)
    setGunArming(false)
    setRevealSeat(null)
    setShowRecap(false)
    setJudgeAssign({})
    setJudgePickSeat(null)
    setLuckySeat(null)
    setLuckySkill(null)
    setLuckySkillUsed(false)
    setLuckyTarget(null)
    setLuckyUseChoice(null)
    setMiracleStep(null)
    setWolfBeautyTarget(null)
    setWolfBeautyUsed(false)
  }

  // 夜晚面板：点击座位选择目标（再点一次取消）
  const handleSeatSelect = (seat: number) => {
    if (!currentStep) return
    if (currentStep.key === 'witch') {
      // 解药直接救，不选号；只有毒药才选
      if (witchChoice === 'poison') {
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
      // BUG1 修复：解药直接救今晚狼刀目标，不需要法官选号
      const wolfTarget = game.nightLog.find((a) => a.stepKey === 'werewolf')?.target ?? null
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
          note: `女巫用解药救了 ${wolfTarget}号玩家`,
          target: wolfTarget,
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
          targets: [targets[0], targets[1]],
          kills: false,
          saves: false,
        }
      }
      const target = targets[0] ?? null
      if (step.key === 'sun_maid_use') {
        const skill = getSunMaidSkill(game)
        return {
          stepKey: step.key,
          stepName: step.name,
          note: `蚀日侍女使用【${SUN_MAID_SKILL_NAMES[skill ?? ''] ?? skill ?? ''}】${target != null ? `作用于 ${target}号` : ''}`,
          target,
          kills: skill === 'poison' || skill === 'hunt',
          saves: false,
        }
      }
      if (step.key === 'werewolf') {
        const wbSeat = game.deal.find((r) => r.key === 'awake_wolf_beauty')?.seat ?? null
        const wbAlive = wbSeat != null && !judgeGraveyard.includes(wbSeat)
        const wbTarget = wbAlive ? wolfBeautyTarget : null
        return {
          stepKey: step.key,
          stepName: step.name,
          note: `狼人刀了 ${target}号玩家${wbTarget != null ? `；觉醒狼美人魅惑 ${wbTarget}号` : ''}`,
          target,
          wolfBeautyTarget: wbTarget,
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
      // 蚀日侍女吞噬：记录本晚获得的技能（当晚使用）
      let sunMaidSkill = prev.sunMaidSkill ?? null
      if (action.stepKey === 'sun_maid_devour' && action.target != null) {
        const devouredRole = prev.deal.find((r) => r.seat === action.target)?.key ?? null
        sunMaidSkill = SUN_MAID_SKILL_MAP[devouredRole] ?? null
      }
      // 奇迹商人：记录幸运儿座位和赋予的技能
      let luckySeat = prev.luckySeat ?? null
      let luckySkill = prev.luckySkill ?? null
      if (action.stepKey === 'miracle_merchant' && action.target != null) {
        const targetRoleForLucky = prev.deal.find((r) => r.seat === action.target)
        // 幸运儿是狼人：不获得技能（商人次日出局由 computeDeaths 判定）
        if (targetRoleForLucky?.camp !== 'wolf') {
          luckySeat = action.target
          luckySkill = action.skillType ?? null
        }
      }
      let witchPoisonCount = prev.witchPoisonCount ?? 1
      // 幸运儿：真正使用技能（target有值）后标记消耗；选择不使用则技能保留
      let luckySkillUsed = prev.luckySkillUsed ?? false
      if (action.stepKey === 'lucky_guy_use' && action.target != null) {
        luckySkillUsed = true
      }
      // 觉醒狼美人：本晚魅惑目标更新（狼人环节一并选择 / 独立步骤两种入口）
      let wolfBeautyTarget = prev.wolfBeautyTarget ?? null
      if (action.stepKey === 'awake_wolf_beauty' && action.target != null) {
        wolfBeautyTarget = action.target
      }
      if (action.stepKey === 'werewolf' && action.wolfBeautyTarget != null) {
        wolfBeautyTarget = action.wolfBeautyTarget
      }
      if (isLastStep) {
        // 夜晚流程全部走完 -> 天亮了，记录死讯并进入白天
        const loversAction = nextLog.find((a) => a.stepKey === 'cupid')
        const lovers = loversAction?.targets ?? prev.lovers ?? []
        const dreamAction = nextLog.find((a) => a.stepKey === 'dream_weaver')
        // 连续两晚判定：结算时用上一晚目标（prev.prevDreamTarget），不能误用本晚目标
        const prevDreamTargetForCheck = prev.prevDreamTarget ?? null
        const witchAction = nextLog.find((a) => a.stepKey === 'witch')
        const witchAntidoteUsed = prev.witchAntidoteUsed || (witchAction?.saves ?? false)
        const witchPoisonUsed = prev.witchPoisonUsed || (witchAction?.kills ?? false)
        const witchAntidoteCount = witchAction?.saves ? 0 : (prev.witchAntidoteCount ?? (prev.witchAntidoteUsed ? 0 : 1))
        const sunUsePoison = nextLog.find((a) => a.stepKey === 'sun_maid_use' && a.kills && a.target != null)
        const witchPoisonCountAfter = (witchAction?.kills ? witchPoisonCount - 1 : witchPoisonCount) - (sunUsePoison != null && getSunMaidSkill(prev) === 'poison' ? 1 : 0)
        const nightmareAction = nextLog.find((a) => a.stepKey === 'nightmare')
        const prevNightmareTarget = nightmareAction?.target ?? null
        const ravenAction = nextLog.find((a) => a.stepKey === 'raven')
        const prevRavenTarget = ravenAction?.target ?? null
        const lonelyAction = nextLog.find((a) => a.stepKey === 'lonely_girl')
        const wolfQueenAction = nextLog.find((a) => a.stepKey === 'wolf_queen')
        const prevWolfQueenTarget = wolfQueenAction?.target ?? null
        const cdState = {
          deal: prev.deal,
          graveyard: prev.graveyard ?? [],
          lovers,
          prevDreamTarget: prevDreamTargetForCheck,
          luckySeat,
          luckySkill,
          wolfBeautyTarget,
          wolfBeautyUsed: prev.wolfBeautyUsed ?? false,
          wolfQueenUsed: prev.wolfQueenUsed ?? false,
          sunMaidSkill,
        }
        const deathList = computeDeaths(nextLog, cdState)
        // computeDeaths 内部会在"替死触发/狼妃反弹触发"时置位，读回并持久化（否则跨夜丢失，技能失效不生效）
        const wolfBeautyUsedAfter = cdState.wolfBeautyUsed ?? false
        const wolfQueenUsedAfter = cdState.wolfQueenUsed ?? false
        // 觉醒孤独少女：偶像非放逐出局 -> 继承偶像技能（真实获得）；放逐变狼在白天 confirmExile 处理
        const idolSeatS = prev.lonelyIdol ?? lonelyAction?.target ?? null
        let lonelyInheritedNow = prev.lonelyInherited ?? null
        if (idolSeatS != null && deathList.includes(idolSeatS) && !(prev.lonelyConverted ?? false)) {
          const idolR = prev.deal.find((r) => r.seat === idolSeatS)
          if (idolR) lonelyInheritedNow = idolR.key
        }
        // BUG3：夜间死亡的猎人/狼王，天亮宣布死讯后可开枪（不翻牌）
        const nightGunShooter = deathList.find((seat) => {
          const r = prev.deal.find((item) => item.seat === seat)
          return r && (r.key === 'hunter' || r.key === 'wolf_king')
        }) ?? null
        const isFirstNight = prev.dayCount === 1
        return {
          ...prev,
          nightLog: nextLog,
          phase: 'day',
          deaths: deathList,
          lovers,
          prevDreamTarget: dreamAction?.target ?? null,
          witchAntidoteUsed,
          witchPoisonUsed,
          witchAntidoteCount,
          witchPoisonCount: witchPoisonCountAfter,
          prevNightmareTarget,
          prevRavenTarget,
          prevWolfQueenTarget,
          lonelyIdol: lonelyAction?.target ?? prev.lonelyIdol,
          lonelyInherited: lonelyInheritedNow,
          nightGunShooter,
          sunMaidSkill,
          luckySeat,
          luckySkill,
          luckySkillUsed,
          wolfBeautyTarget,
          wolfBeautyUsed: wolfBeautyUsedAfter,
          wolfQueenUsed: wolfQueenUsedAfter,
          dayStage: isFirstNight ? 'sheriff' : (nightGunShooter !== null ? 'nightGun' : 'deaths'),
          exiledSeat: null,
          exileHasLastWords: null,
          // 第一晚先上警，暂不把死亡玩家加入 graveyard；等 sheriff 结束进入 deaths 时再加入
          graveyard: isFirstNight ? (prev.graveyard ?? []) : [...new Set([...(prev.graveyard ?? []), ...deathList])],
        }
      }
      return {
        ...prev,
        nightLog: nextLog,
        nightIndex: prev.nightIndex + 1,
        luckySeat,
        luckySkill,
        luckySkillUsed,
        wolfBeautyTarget,
        witchPoisonCount,
        sunMaidSkill,
      }
    })
    setNightTargets([])
    setWitchChoice(null)
    setVoteSeat(null)
    setGunArming(false)
    setLuckyUseChoice(null)
    setLuckyTarget(null)
  }

  const handleNextStep = () => {
    pushHistory()
    if (!currentStep) return
    // 被恐惧角色：直接空过，不检查选目标
    if (isFearedStep) {
      handleAdvance({
        stepKey: currentStep.key,
        stepName: currentStep.name,
        note: `${currentStep.name}被噩梦之影恐惧，无法行动（空过）`,
        target: null,
        kills: false,
        saves: false,
      })
      return
    }
    // 蚀日侍女首夜：只睁眼确认，不吞噬
    if (currentStep.key === 'sun_maid_devour' && game.dayCount === 1) {
      handleAdvance({
        stepKey: 'sun_maid_devour',
        stepName: '蚀日侍女',
        note: '蚀日侍女首夜只睁眼确认座位，不吞噬',
        target: null,
        kills: false,
        saves: false,
      })
      return
    }
    // 觉醒狼美人：魅惑已随狼人环节一并选择，本步骤直接确认
    if (currentStep.key === 'awake_wolf_beauty') {
      const wbSeat = game.deal.find((r) => r.key === 'awake_wolf_beauty')?.seat ?? null
      const wbAlive = wbSeat != null && !judgeGraveyard.includes(wbSeat)
      if (!wbAlive) {
        handleAdvance({
          stepKey: 'awake_wolf_beauty',
          stepName: '觉醒狼美人',
          note: '觉醒狼美人已出局（保留流程）',
          target: null,
          kills: false,
          saves: false,
        })
        return
      }
      const merged = game.wolfBeautyTarget != null
      if (merged) {
        handleAdvance({
          stepKey: 'awake_wolf_beauty',
          stepName: '觉醒狼美人',
          note: `觉醒狼美人魅惑 ${game.wolfBeautyTarget}号（已在狼人环节一并选择）`,
          target: game.wolfBeautyTarget,
          kills: false,
          saves: false,
        })
        return
      }
      // 兜底：未走狼人合并（其他板子），走通用选目标
    }
    // 狼人：刀人 + 觉醒狼美人魅惑（若存活）一并提交
    if (currentStep.key === 'werewolf') {
      if (nightTargets.length < 1) return
      const wbSeat = game.deal.find((r) => r.key === 'awake_wolf_beauty')?.seat ?? null
      const wbAlive = wbSeat != null && !judgeGraveyard.includes(wbSeat)
      const wbTarget = wbAlive ? wolfBeautyTarget : null
      if (wbAlive && wbTarget == null) return
      handleAdvance({
        stepKey: 'werewolf',
        stepName: '狼人',
        note: `狼人刀了 ${nightTargets[0]}号玩家${wbTarget != null ? `；觉醒狼美人魅惑 ${wbTarget}号` : ''}`,
        target: nightTargets[0] ?? null,
        wolfBeautyTarget: wbTarget,
        kills: true,
        saves: false,
      })
      return
    }
    // 猎魔人出局：保留流程空过
    if (currentStep.key === 'demon_hunter_1' || currentStep.key === 'demon_hunter_2' || currentStep.key === 'demon_hunter') {
      const dhSeatsH = game.deal.filter((r) => r.key === 'demon_hunter').map((r) => r.seat).sort((a, b) => a - b)
      const dhSeatH = currentStep.key === 'demon_hunter_1' ? dhSeatsH[0] : currentStep.key === 'demon_hunter_2' ? dhSeatsH[1] : dhSeatsH[0] ?? null
      if (dhSeatH != null && (judgeGraveyard.includes(dhSeatH) || safeNightLog.some((a) => a.kills && a.target === dhSeatH))) {
        handleAdvance({
          stepKey: currentStep.key,
          stepName: currentStep.name,
          note: `猎魔人（${dhSeatH}号）已出局（保留流程）`,
          target: null,
          kills: false,
          saves: false,
        })
        return
      }
    }
    // 奇迹商人：两步选择完成，记录幸运儿和技能
    if (currentStep.key === 'miracle_merchant') {
      if (luckySeat == null || luckySkill == null) return
      const skillName = luckySkill === 'check' ? '查验' : luckySkill === 'poison' ? '毒药' : '守护'
      handleAdvance({
        stepKey: 'miracle_merchant',
        stepName: '奇迹商人',
        note: `奇迹商人赋予 ${luckySeat}号【${skillName}】一次性技能`,
        target: luckySeat,
        skillType: luckySkill,
        kills: false,
        saves: false,
      })
      return
    }
    // 蚀日侍女使用吞噬技能：提交目标（未吞噬到技能则空过）
    if (currentStep.key === 'sun_maid_use') {
      const skill = getSunMaidSkill(game)
      if (skill == null) {
        handleAdvance({
          stepKey: 'sun_maid_use',
          stepName: '蚀日侍女',
          note: '蚀日侍女本晚未吞噬到技能（空过）',
          target: null,
          kills: false,
          saves: false,
        })
        return
      }
      if (skill === 'poison' && (game.witchPoisonCount ?? 1) <= 0) {
        handleAdvance({
          stepKey: 'sun_maid_use',
          stepName: '蚀日侍女',
          note: '蚀日侍女获得毒药，但女巫毒药已用完（空过）',
          target: null,
          kills: false,
          saves: false,
        })
        return
      }
      if (nightTargets.length < (skill === 'check2' ? 2 : 1)) return
      handleAdvance(buildAction())
      return
    }
    // 幸运儿使用技能阶段
    if (currentStep.key === 'lucky_guy_use') {
      const hasLucky = game.luckySeat != null && game.luckySkill != null && !game.luckySkillUsed
      if (!hasLucky) {
        handleAdvance({
          stepKey: 'lucky_guy_use',
          stepName: '幸运儿',
          note: '幸运儿无技能/技能已使用',
          target: null,
          kills: false,
          saves: false,
        })
        return
      }
      if (luckyUseChoice === null) return
      if (luckyUseChoice === 'skip') {
        handleAdvance({
          stepKey: 'lucky_guy_use',
          stepName: '幸运儿',
          note: `幸运儿（${game.luckySeat}号）暂不使用技能（技能保留）`,
          target: null,
          skillType: game.luckySkill,
          kills: false,
          saves: false,
        })
        return
      }
      if (luckyTarget == null) return
      const skillName = game.luckySkill === 'check' ? '查验' : game.luckySkill === 'poison' ? '毒药' : '守护'
      handleAdvance({
        stepKey: 'lucky_guy_use',
        stepName: '幸运儿',
        note: `幸运儿（${game.luckySeat}号）使用【${skillName}】，目标 ${luckyTarget}号`,
        target: luckyTarget,
        skillType: game.luckySkill,
        kills: game.luckySkill === 'poison',
        saves: false,
      })
      return
    }
    if (currentStep.key === 'witch') {
      if (witchChoice === null) return
      if (witchChoice === 'none' || witchChoice === 'heal') {
        handleAdvance(buildAction())
        return
      }
      // poison 需要选目标
      if (nightTargets.length < 1) return
      handleAdvance(buildAction())
      return
    }
    if (currentStep.needTarget && nightTargets.length < currentStep.targetCount) {
      // 被蚀日侍女吞噬 / 狼妃技能已失效：按空过处理
      const devourT = game.nightLog.find((a) => a.stepKey === 'sun_maid_devour')?.target ?? null
      const blockedSeat = (() => {
        if (currentStep.key === 'demon_hunter_1') return game.deal.filter((r) => r.key === 'demon_hunter').map((r) => r.seat).sort((a, b) => a - b)[0] ?? null
        if (currentStep.key === 'demon_hunter_2') return game.deal.filter((r) => r.key === 'demon_hunter').map((r) => r.seat).sort((a, b) => a - b)[1] ?? null
        return game.deal.find((r) => r.key === currentStep.key)?.seat ?? null
      })()
      if ((currentStep.key === 'wolf_queen' && game.wolfQueenUsed) || (game.dayCount > 1 && devourT != null && devourT === blockedSeat)) {
        handleSkipStep()
        return
      }
      return
    }
    handleAdvance(buildAction())
  }

  const handleSkipStep = () => {
    pushHistory()
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

  // 女巫自救判断：今晚刀口是否是女巫自己
  const witchSeatNow = game.deal.find((r) => r.key === 'witch')?.seat ?? null
  const wolfTargetNow = game.nightLog.find((a) => a.stepKey === 'werewolf')?.target ?? null
  const isSelfKill = witchSeatNow != null && wolfTargetNow === witchSeatNow
  // 噩梦之影恐惧：被恐惧角色/狼队当晚无法行动，直接空过
  const nightmareTargetNow = game.nightLog.find((a) => a.stepKey === 'nightmare')?.target ?? null
  // 恐惧座位映射：特殊步骤 -> 实际角色座位
  let fearedStepSeat = game.deal.find((r) => r.key === currentStep?.key)?.seat ?? null
  if (currentStep?.key === 'sun_maid_devour' || currentStep?.key === 'sun_maid_use') {
    fearedStepSeat = game.deal.find((r) => r.key === 'sun_maid')?.seat ?? null
  } else if (currentStep?.key === 'lucky_guy_use' && game.luckySeat != null) {
    fearedStepSeat = game.luckySeat
  } else if (currentStep?.key === 'demon_hunter_1' || currentStep?.key === 'demon_hunter_2') {
    const dhS = game.deal.filter((r) => r.key === 'demon_hunter').map((r) => r.seat).sort((a, b) => a - b)
    fearedStepSeat = currentStep.key === 'demon_hunter_1' ? (dhS[0] ?? null) : (dhS[1] ?? null)
  }
  const wolfFeared = currentStep?.key === 'werewolf' &&
    nightmareTargetNow != null && game.deal.find((r) => r.seat === nightmareTargetNow)?.camp === 'wolf'
  const isFearedStep = currentStep != null && nightmareTargetNow != null &&
    (wolfFeared || fearedStepSeat === nightmareTargetNow)
  // 觉醒孤独少女继承技能：该角色已出局且孤独少女存活 -> 由孤独少女代替操作（真实生效）
  const lonelyInheritedNow = game.lonelyInherited ?? null
  const lonelySeatNow = game.deal.find((r) => r.key === 'lonely_girl')?.seat ?? null
  const lonelyAliveNow = lonelySeatNow != null && !judgeGraveyard.includes(lonelySeatNow)
  const inheritedRoleSeatNow = currentStep != null && currentStep.key !== 'lovers' && currentStep.key !== 'lucky_guy_receive' && currentStep.key !== 'lucky_guy_use' && currentStep.key !== 'sun_maid_use' && currentStep.key !== 'sun_maid_devour'
    ? (game.deal.find((r) => r.key === currentStep.key)?.seat ?? null)
    : null
  const isInheritedStep = currentStep != null && lonelyInheritedNow != null &&
    lonelyInheritedNow === currentStep.key && lonelyAliveNow &&
    (inheritedRoleSeatNow == null || judgeGraveyard.includes(inheritedRoleSeatNow))
  const canNext = (() => {
    if (!currentStep) return false

    // 孤独少女继承步骤：该角色已出局，由孤独少女代替操作（不再要求原角色分配）
    if (isInheritedStep) {
      if (!currentStep.needTarget) return true
      return nightTargets.length >= currentStep.targetCount
    }

    // 边走边分配：当前阶段需要的角色座位不足时不能下一步（狼人环节需同时配齐狼队全部成员）
    const reqs = currentStep.key === 'werewolf' ? getWolfPackReqs(currentBoard) : getStepRoleReqs(currentStep.key)
    if (reqs !== null) {
      for (const req of reqs) {
        if (!currentBoard.roles.some((r) => r.key === req.roleKey)) continue
        const assignedCount = game.deal.filter((r) => r.key === req.roleKey).length
        if (assignedCount < req.count) return false
      }
    }
    if (isFearedStep) return true
    // 蚀日侍女首夜：无需目标即可下一步
    if (currentStep.key === 'sun_maid_devour' && game.dayCount === 1) {
      return true
    }
    // 觉醒狼美人：魅惑已随狼人环节选择 -> 直接下一步；否则按通用选目标
    if (currentStep.key === 'awake_wolf_beauty') {
      const wbSeat = game.deal.find((r) => r.key === 'awake_wolf_beauty')?.seat ?? null
      const wbAlive = wbSeat != null && !judgeGraveyard.includes(wbSeat)
      if (!wbAlive) return true
      if (game.wolfBeautyUsed) return true // 技能已触发失效：仅睁眼空过
      if (game.wolfBeautyTarget != null) return true
      return nightTargets.length >= 1
    }
    // 狼人：刀人目标 + 觉醒狼美人魅惑目标（若存活）都选好
    if (currentStep.key === 'werewolf') {
      const wbSeat = game.deal.find((r) => r.key === 'awake_wolf_beauty')?.seat ?? null
      const wbAlive = wbSeat != null && !judgeGraveyard.includes(wbSeat)
      if (nightTargets.length < 1) return false
      if (wbAlive && !game.wolfBeautyUsed && wolfBeautyTarget == null) return false
      return true
    }
    // 奇迹商人：技能与幸运儿号码都选定后可下一步
    if (currentStep.key === 'miracle_merchant') {
      return luckySkill != null && luckySeat != null
    }
    // 女巫
    if (currentStep.key === 'witch') {
      if (witchChoice === null) return false
      if (witchChoice === 'none' || witchChoice === 'heal') return true
      return nightTargets.length >= 1
    }
    // 蚀时狼妃技能已失效：仅睁眼，无需选目标
    if (currentStep.key === 'wolf_queen' && game.wolfQueenUsed) return true
    // 蚀日侍女吞噬：被吞噬者当晚无法使用技能，直接空过
    if (game.dayCount > 1) {
      const devourT = game.nightLog.find((a) => a.stepKey === 'sun_maid_devour')?.target ?? null
      if (devourT != null) {
        const dhS = game.deal.filter((r) => r.key === 'demon_hunter').map((r) => r.seat).sort((a, b) => a - b)
        let seat = game.deal.find((r) => r.key === currentStep.key)?.seat ?? null
        if (currentStep.key === 'demon_hunter_1') seat = dhS[0] ?? null
        if (currentStep.key === 'demon_hunter_2') seat = dhS[1] ?? null
        if (devourT === seat) return true
      }
    }
    // 蚀日侍女使用吞噬技能
    if (currentStep.key === 'sun_maid_use') {
      const skill = getSunMaidSkill(game)
      if (skill == null) return true // 未吞噬到技能 -> 空过
      if (skill === 'poison' && (game.witchPoisonCount ?? 1) <= 0) return true // 女巫毒药已用完 -> 空过
      if (skill === 'check2') return nightTargets.length >= 2
      return nightTargets.length >= 1
    }
    // 幸运儿使用技能阶段
    if (currentStep.key === 'lucky_guy_use') {
      const hasLucky = game.luckySeat != null && game.luckySkill != null && !game.luckySkillUsed
      if (!hasLucky) return true // 无技能/已使用，空过
      if (luckyUseChoice === null) return false
      if (luckyUseChoice === 'skip') return true
      return luckyTarget != null
    }
    // 猎魔人出局：保留流程空过
    if (currentStep.key === 'demon_hunter_1' || currentStep.key === 'demon_hunter_2' || currentStep.key === 'demon_hunter') {
      const dhSeatsC = game.deal.filter((r) => r.key === 'demon_hunter').map((r) => r.seat).sort((a, b) => a - b)
      const dhSeatC = currentStep.key === 'demon_hunter_1' ? dhSeatsC[0] : currentStep.key === 'demon_hunter_2' ? dhSeatsC[1] : dhSeatsC[0] ?? null
      if (dhSeatC != null && (judgeGraveyard.includes(dhSeatC) || safeNightLog.some((a) => a.kills && a.target === dhSeatC))) return true
    }
    if (!currentStep.needTarget) return true
    return nightTargets.length >= currentStep.targetCount
  })()

  // ---- 白天流程 ----

  const startVote = () => {
    pushHistory()
    setGame((prev) => ({ ...prev, dayStage: 'vote' }))
    setVoteSeat(null)
  }

  const cancelVote = () => {
    setGame((prev) => ({ ...prev, dayStage: 'deaths' }))
    setVoteSeat(null)
  }

  const confirmExile = () => {
    pushHistory()
    if (voteSeat === null) return
    setGame((prev) => {
      const votedRole = prev.deal.find((r) => r.seat === voteSeat)
      const dreamTargetSeat = prev.nightLog.find((a) => a.stepKey === 'dream_weaver')?.target ?? null
      const lovers = prev.lovers ?? []

      // 第一步：确定真正出局者（觉醒狼美人首次出局 -> 被魅惑者替代）
      let actualOut = voteSeat
      let replaced = false
      let wolfBeautyUsed = prev.wolfBeautyUsed ?? false
      const logs: string[] = []
      if (
        votedRole?.key === 'awake_wolf_beauty' &&
        prev.wolfBeautyTarget != null &&
        !wolfBeautyUsed
      ) {
        wolfBeautyUsed = true
        if (prev.wolfBeautyTarget !== dreamTargetSeat) {
          actualOut = prev.wolfBeautyTarget
          replaced = true
          logs.push(`💫 觉醒狼美人首次面临出局，${actualOut}号（被魅惑者）替代其出局，且不能发动技能`)
        } else {
          logs.push(`💫 觉醒狼美人的魅惑目标正在梦游，替死被摄梦保护，狼美人自己出局`)
        }
      }

      // 第二步：情侣殉情（出局者在链中，另一方殉情；白天殉情生效，不能发动技能）
      const outs = [actualOut]
      const loverOther = lovers.find(
        (l) => l !== actualOut && (lovers[0] === actualOut || lovers[1] === actualOut),
      )
      if (loverOther != null) {
        outs.push(loverOther)
        logs.push(`💑 ${loverOther}号因情侣殉情出局（不能发动技能）`)
      }

      const gy = [...new Set([...(prev.graveyard ?? []), ...outs])]
      // 觉醒孤独少女：仅偶像被投票放逐出局时变狼，其他方式不生效（偶像座位跨夜持久化）
      const idolTarget = prev.lonelyIdol ?? prev.nightLog.find((a) => a.stepKey === 'lonely_girl')?.target
      const lonelyConverted = (prev.lonelyConverted ?? false) || (idolTarget != null && actualOut === idolTarget)
      if (lonelyConverted) logs.push('🌟 觉醒孤独少女的偶像被放逐出局，孤独少女加入狼人阵营')
      return {
        ...prev,
        exiledSeat: actualOut,
        dayStage: 'exile',
        graveyard: gy,
        wolfBeautyUsed,
        exileReplaced: replaced,
        lonelyConverted,
        // 变狼后真实修改孤独少女阵营（胜负判定/后续夜晚生效）
        deal: lonelyConverted ? prev.deal.map((r) => (r.key === 'lonely_girl' ? { ...r, camp: 'wolf' } : r)) : prev.deal,
        dayLog: [...prev.dayLog, ...logs],
      }
    })
    setVoteSeat(null)
    setGunArming(false)
  }

  const markTie = () => {
    pushHistory()
    setGame((prev) => ({
      ...prev,
      dayStage: 'summary',
      dayLog: [...prev.dayLog, '投票平票，无人出局'],
    }))
  }

  const handleLastWords = (has: boolean) => {
    pushHistory()
    if (game.exiledSeat === null) return
    setGame((prev) => {
      const role = prev.deal.find((item) => item.seat === prev.exiledSeat)
      const canGun =
        prev.exileReplaced !== true &&
        role !== undefined &&
        (role.key === 'hunter' ||
          role.key === 'wolf_king')
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
    pushHistory()
    if (game.exiledSeat === null) return
    const actionWord = exiledRole?.key === 'demon_hunter' ? '狩猎' : '开枪'
    // 情侣殉情：开枪带走情侣一方，另一方也殉情
    const lovers = game.lovers ?? []
    const loverOther = lovers.find((l) => l !== target && (lovers[0] === target || lovers[1] === target))
    // 狼王被开枪带走：狼王可以二次开枪（除非殉情）
    const targetRole = game.deal.find((r) => r.seat === target)
    const targetIsWolfKing = targetRole?.key === 'wolf_king'
    setGame((prev) => {
      let gy = [...(prev.graveyard ?? []), target]
      let log = [...prev.dayLog, `${prev.exiledSeat}号玩家（${exiledRole?.name ?? '该角色'}）${actionWord}带走了 ${target}号玩家`]
      // 殉情
      if (loverOther != null && !gy.includes(loverOther)) {
        gy = [...gy, loverOther]
        log = [...log, `${loverOther}号玩家殉情出局`]
      }
      // 狼王被带走且不是殉情 -> 狼王二次开枪
      const wolfKingCanShoot = targetIsWolfKing && loverOther == null
      return {
        ...prev,
        dayStage: wolfKingCanShoot ? 'gun' : 'summary',
        exiledSeat: wolfKingCanShoot ? target : prev.exiledSeat,
        graveyard: [...new Set(gy)].sort((a, b) => a - b),
        dayLog: log,
      }
    })
    setGunArming(false)
  }

  // BUG3：夜间死亡的猎人/狼王开枪（不翻牌），开完进遗言
  const nightGunRole = game.nightGunShooter !== null
    ? game.deal.find((r) => r.seat === game.nightGunShooter)
    : undefined
  const handleNightGunShoot = (target: number) => {
    pushHistory()
    if (game.nightGunShooter === null) return
    // 情侣殉情
    const lovers = game.lovers ?? []
    const loverOther = lovers.find((l) => l !== target && (lovers[0] === target || lovers[1] === target))
    // 狼王被带走且不是殉情 -> 狼王二次开枪
    const targetRole = game.deal.find((r) => r.seat === target)
    const targetIsWolfKing = targetRole?.key === 'wolf_king'
    const wolfKingCanShoot = targetIsWolfKing && loverOther == null
    setGame((prev) => {
      let gy = [...(prev.graveyard ?? []), target]
      let log = [...prev.dayLog, `${prev.nightGunShooter}号夜间死亡（${nightGunRole?.name ?? '猎人'}）开枪带走了 ${target}号玩家`]
      if (loverOther != null && !gy.includes(loverOther)) {
        gy = [...gy, loverOther]
        log = [...log, `${loverOther}号玩家殉情出局`]
      }
      return {
        ...prev,
        dayStage: wolfKingCanShoot ? 'gun' : 'lastWords',
        exiledSeat: wolfKingCanShoot ? target : prev.exiledSeat,
        graveyard: [...new Set(gy)].sort((a, b) => a - b),
        dayLog: log,
      }
    })
    setGunArming(false)
  }
  const handleNightGunNoShoot = () => {
    pushHistory()
    if (game.nightGunShooter === null) return
    setGame((prev) => ({
      ...prev,
      dayStage: 'lastWords',
      dayLog: [...prev.dayLog, `${prev.nightGunShooter}号夜间死亡，没有开枪`],
    }))
    setGunArming(false)
  }
  const skipLastWords = () => {
    pushHistory()
    setGame((prev) => ({ ...prev, dayStage: 'deaths', nightGunShooter: null }))
  }
  const handleGunNoShoot = () => {
    pushHistory()
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
    pushHistory()
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
  const submitWitchAction = (choiceOverride?: 'save' | 'poison' | 'none') => {
    if (!socket) return
    const choice = choiceOverride ?? onlineWitchChoice
    if (choice === null) return
    if (choice === 'poison' && witchPoisonTarget === null) return
    const msg: ClientMessage = {
      type: 'witchAction',
      playerId,
      choice,
      target: choice === 'poison' ? witchPoisonTarget ?? undefined : undefined,
    }
    socket.send(JSON.stringify(msg))
    setOnlineWitchChoice(null)
    setWitchPoisonTarget(null)
  }
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
    <div className={`flex w-full flex-col bg-slate-950 text-slate-100 ${onlineStarted && !isDemo ? 'h-dvh overflow-hidden px-3 py-3' : 'min-h-dvh px-6 py-10'}`}>
      <div className={`mx-auto w-full max-w-[480px] ${onlineStarted && !isDemo ? '' : 'pb-40'}`}>
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
              线下法官助手
            </span>
          )}
        </div>

        <div className="flex items-center justify-between gap-3">
          <h1
            className="select-none text-2xl font-bold"
            onPointerDown={startTitleHold}
            onPointerUp={cancelTitleHold}
            onPointerLeave={cancelTitleHold}
            onPointerCancel={cancelTitleHold}
          >
            {isDemo ? '线下法官助手' : '房间'}
          </h1>
          {!isDemo && (
            <button type="button" onClick={copyRoomCode} className="flex items-center gap-1.5">
              <span onClick={handleRoomCodeTap} className="text-base font-black tracking-[0.15em] text-amber-400">{roomId?.toUpperCase()}</span>
              <span className={`rounded px-1.5 py-0.5 text-[11px] font-bold ${copied ? 'bg-emerald-500 text-slate-950' : 'bg-amber-500/20 text-amber-300'}`}>{copied ? '已复制 ✓' : '复制'}</span>
            </button>
          )}
        </div>
        {!onlineStarted && (
          <>
        {/* 顶部信息条：房间码/复制/昵称（线下法官助手为纯本地模式，不显示房间码/开发者模式） */}
        {!isDemo && (
        <>
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
        </>
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

        {!onlineStarted && !isDemo && (
                <section className="mt-3 pb-44">
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
                      className={`flex items-center gap-1.5 rounded-lg border px-1.5 py-1 ${seat > currentBoard.playerCount / 2 ? 'flex-row-reverse' : ''} ${
                    player
                      ? 'border-slate-700 bg-slate-900'
                      : onlineStarted
                        ? 'border-dashed border-slate-800 bg-slate-950/50'
                        : 'cursor-pointer border-dashed border-slate-600 bg-slate-900/60 transition hover:border-amber-500/60'
                  }`}
                >
                  {/* 头像框：只有已入座玩家显示头像，空位仅显示座位号 */}
                  <div className="flex h-12 w-12 shrink-0 items-center justify-center overflow-hidden rounded-full border border-slate-600 bg-slate-800">
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
                  <div className={`min-w-0 flex-1 ${seat > currentBoard.playerCount / 2 ? 'text-right' : ''}`}>
                    <div className={`flex flex-wrap items-center gap-1 ${seat > currentBoard.playerCount / 2 ? 'justify-end' : ''}`}>
                      {seat > currentBoard.playerCount / 2 ? (
                        <span className="truncate text-xs font-bold text-slate-100">
                          {player ? player.nickname : '空位'}<span className="ml-1 font-black text-amber-400">{seat}号</span>
                        </span>
                      ) : (
                        <span className="truncate text-xs font-bold text-slate-100">
                          <span className="mr-1 font-black text-amber-400">{seat}号</span>{player ? player.nickname : '空位'}
                        </span>
                      )}
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
                      className={`mt-0.5 text-xs ${seat > currentBoard.playerCount / 2 ? 'text-right ' : ''} ${
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
          {roster.some((p) => p.seat == null) && (
            <p className="mt-2 text-xs text-slate-500">
              👁 观战：{roster.filter((p) => p.seat == null).map((p) => p.nickname).join('、')}
            </p>
          )}
          {roster.length === 0 && (
            <p className="mt-3 rounded-xl border border-dashed border-slate-700 px-4 py-3 text-center text-sm text-slate-500">
              等待玩家加入…（另一台设备或新窗口输入同一房间码即可看到）
            </p>
          )}

          {/* 底部操作栏：fixed 固定吸底，任何滚动位置都可见可操作 */}
          <div className="fixed inset-x-0 bottom-0 z-40 border-t border-slate-800 bg-slate-950/95 px-4 pt-3 pb-[max(16px,env(safe-area-inset-bottom))] backdrop-blur">
            <div className="mx-auto w-full max-w-[480px]">
              <div className="flex gap-2">
                {me && !spectatorMode && (
                  <button
                    type="button"
                    onClick={toggleReady}
                    disabled={connState !== 'open'}
                    className={`flex-1 rounded-xl py-2 text-sm font-bold transition active:scale-95 disabled:cursor-not-allowed disabled:opacity-40 ${
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
                    className="flex-1 rounded-xl bg-amber-500 py-2.5 text-sm font-bold text-slate-950 shadow-lg shadow-amber-500/30 transition active:scale-95 disabled:cursor-not-allowed disabled:opacity-40"
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

        {/* 线下法官助手：手动配牌——点击号码给 1..N 号分配角色，可随时修改/重置，不连服不接语音 */}
        {isDemo && !onlineStarted && game.phase === 'waiting' && (
          <section className="flex min-h-[calc(100dvh-120px)] flex-col items-center justify-center px-6 pb-32">
            <div className="w-full max-w-sm rounded-2xl border border-slate-800 bg-slate-900/90 p-8 backdrop-blur">
              <h2 className="text-center text-2xl font-black text-amber-300">线下法官助手</h2>
              <p className="mt-2 text-center text-sm text-slate-400">边走边分配 · 法官主持</p>
              {/* 板子选择 */}
              <p className="mt-8 text-sm font-bold text-slate-300">选择板子</p>
              <div className="mt-3 flex flex-col gap-3">
                {boards.map((b, i) => (
                  <button
                    key={b.name}
                    type="button"
                    onClick={() => setDemoBoardIndex(i)}
                    className={`rounded-xl border px-4 py-4 text-base font-bold active:scale-95 transition ${
                      demoBoardIndex === i
                        ? 'border-amber-500 bg-amber-500/20 text-amber-200'
                        : 'border-slate-700 bg-slate-950 text-slate-300'
                    }`}
                  >
                    {b.name}
                  </button>
                ))}
              </div>
              <button
                type="button"
                onClick={startJudgeGame}
                className="mt-8 w-full rounded-xl bg-amber-500 py-4 text-lg font-black text-slate-950 shadow-lg shadow-amber-500/30 active:scale-95 transition"
              >
                开始游戏
              </button>
            </div>
            {/* 开始游戏前不显示座位卡片（边走边分配模式下，开始后才分配） */}

            {/* 角色选择弹层：给当前号码指定/清除角色 */}
            {judgePickSeat !== null && (
              <div
                className="fixed inset-0 z-50 flex items-end justify-center bg-black/60"
                onClick={() => setJudgePickSeat(null)}
              >
                <div
                  className="w-full max-w-[480px] rounded-t-2xl border-t border-amber-500/40 bg-slate-900 p-4 pb-[max(1rem,env(safe-area-inset-bottom))]"
                  onClick={(e) => e.stopPropagation()}
                >
                  <div className="flex items-center justify-between">
                    <p className="text-base font-black text-slate-100">给 {judgePickSeat} 号分配角色</p>
                    <button type="button" onClick={() => setJudgePickSeat(null)} className="text-slate-400">
                      ✕
                    </button>
                  </div>
                  <div className="mt-3 grid max-h-[52dvh] grid-cols-3 gap-2 overflow-y-auto">
                    {[...currentBoard.roles]
                      .sort((a, b) => {
                        const rank = (k) => (k === 'cursed_fox' ? 2 : k === 'demon_hunter' ? 1 : 0)
                        return rank(a.key) - rank(b.key)
                      })
                      .map((role) => (
                      <button
                        key={role.key}
                        type="button"
                        onClick={() => {
                          setJudgeAssign((prev) => ({ ...prev, [judgePickSeat]: role.key }))
                          setJudgePickSeat(null)
                        }}
                        className={`rounded-xl border px-1 py-2 text-xs font-bold transition active:scale-95 ${
                          judgeAssign[judgePickSeat] === role.key
                            ? 'border-amber-500 bg-amber-500/20 text-amber-200'
                            : 'border-slate-700 bg-slate-950 text-slate-200'
                        }`}
                      >
                        {role.name}
                      </button>
                    ))}
                  </div>
                  <div className="mt-3 flex gap-2">
                    <button
                      type="button"
                      onClick={() => {
                        setJudgeAssign((prev) => {
                          const next = { ...prev }
                          delete next[judgePickSeat]
                          return next
                        })
                        setJudgePickSeat(null)
                      }}
                      className="flex-1 rounded-xl border border-slate-700 py-2.5 text-sm font-bold text-slate-300 active:scale-95"
                    >
                      清除该号码
                    </button>
                    <button
                      type="button"
                      onClick={() => setJudgePickSeat(null)}
                      className="flex-1 rounded-xl bg-slate-700 py-2.5 text-sm font-bold text-slate-100 active:scale-95"
                    >
                      取消
                    </button>
                  </div>
                </div>
              </div>
            )}

            {/* 重置按钮 */}
            <button
              type="button"
              onClick={() => setJudgeAssign({})}
              className="mt-3 text-xs text-slate-500 underline"
            >
              重置分配
            </button>
          </section>
        )}

        {onlineStarted && !isDemo && (
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
                      className={`flex items-center gap-1.5 rounded-lg border px-1.5 py-1 ${seatNum > currentBoard.playerCount / 2 ? 'flex-row-reverse' : ''} ${
                        isDead
                          ? 'border-slate-800/50 bg-slate-900/40 opacity-60'
                          : s
                            ? 'border-slate-700 bg-slate-900'
                            : 'border-dashed border-slate-800 bg-slate-950/50'
                      }`}
                    >
                      <div className="flex h-12 w-12 shrink-0 items-center justify-center overflow-hidden rounded-full border border-slate-600 bg-slate-800">
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
                      <div className={`min-w-0 flex-1 ${seatNum > currentBoard.playerCount / 2 ? 'text-right' : ''}`}>
                        <div className={`flex flex-wrap items-center gap-1 ${seatNum > currentBoard.playerCount / 2 ? 'justify-end' : ''}`}>
                          {seatNum > currentBoard.playerCount / 2 ? (
                            <span className="truncate text-xs font-bold text-slate-100">
                              {isDead ? '已出局' : s ? s.nickname : '空位'}<span className="ml-1 font-black text-amber-400">{seatNum}号</span>
                            </span>
                          ) : (
                            <span className="truncate text-xs font-bold text-slate-100">
                              <span className="mr-1 font-black text-amber-400">{seatNum}号</span>{isDead ? '已出局' : s ? s.nickname : '空位'}
                            </span>
                          )}
                          {s?.playerId === playerId && !isDead && (
                            <span className="text-xs text-slate-500">（我）</span>
                          )}
                        </div>
                        <div className={`mt-0.5 flex flex-wrap items-center gap-1 text-[11px] ${seatNum > currentBoard.playerCount / 2 ? 'justify-end' : ''}`}>
                          {s?.seat === sheriffSeat && (
                            <span className="font-bold text-amber-300">⭐ 警长</span>
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
                      {[...currentBoard.roles]
                      .sort((a, b) => {
                        const rank = (k) => (k === 'cursed_fox' ? 2 : k === 'demon_hunter' ? 1 : 0)
                        return rank(a.key) - rank(b.key)
                      })
                      .map((role) => (
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

        {onlineStarted && !isDemo && gameOverInfo && (
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
        {onlineStarted && !isDemo && (
          <>
            <button
              type="button"
              onClick={() => setShowVoteHistory((v) => !v)}
              className="fixed right-2 bottom-[calc(6rem+env(safe-area-inset-bottom))] z-50 flex items-center gap-1 rounded-full border border-amber-500/50 bg-slate-950/95 px-3 py-1.5 text-xs font-bold text-amber-300 shadow-lg backdrop-blur transition active:scale-95"
            >
              📋 投票记录 {showVoteHistory ? '▴' : '▾'}
            </button>
            {showVoteHistory && (
              <div className="fixed inset-x-0 bottom-[calc(6rem+env(safe-area-inset-bottom))] z-50 mx-auto max-h-[38dvh] w-full max-w-[480px] overflow-y-auto rounded-t-2xl border border-amber-500/40 bg-slate-950/95 p-3 shadow-2xl backdrop-blur">
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

        {!isDemo && (trtcCred || (onlineStarted && myRole?.trtc)) && (
          <div
            className={`fixed inset-x-0 z-30 mx-auto max-w-[480px] ${
              onlineStarted ? 'bottom-0' : 'bottom-[calc(82px+max(16px,env(safe-area-inset-bottom)))]'
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

        {onlineStarted && !isDemo && onlinePhase === 'night' && (
          <section className={`fixed inset-x-0 bottom-[calc(44px+max(8px,env(safe-area-inset-bottom)))] z-40 mx-auto flex max-h-[calc(58dvh-52px)] max-w-[480px] flex-col overflow-y-auto rounded-t-2xl border-t border-indigo-500/40 bg-slate-950/95 p-3 shadow-2xl backdrop-blur ${phaseDisabled && isMyPhase ? 'pointer-events-none [&_button]:opacity-40' : ''}`}>
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
                          onClick={() => submitWitchAction('save')}
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
                          onClick={() => submitWitchAction('none')}
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
                    {aliveSeatInfo.map((s) => {
                      const isSelf = s.seat === myRole?.seat
                      return (
                      <button
                        key={s.seat}
                        type="button"
                        disabled={isSelf}
                        title={isSelf ? '不能对自己使用技能' : undefined}
                        onClick={() => setDreamTarget(dreamTarget === s.seat ? null : s.seat)}
                        className={`rounded-lg py-1.5 text-xs font-bold transition active:scale-95 disabled:cursor-not-allowed disabled:opacity-30 ${
                          isSelf
                            ? 'border border-slate-800 bg-slate-900 text-slate-600'
                            : dreamTarget === s.seat
                              ? 'bg-cyan-500 text-slate-950'
                              : 'border border-slate-700 bg-slate-950 text-slate-300'
                        }`}
                      >
                        {s.seat}号
                      </button>
                    )})}
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
                  {game.wolfQueenUsed ? (
                    <>
                      <p className="mt-1 rounded-lg bg-slate-800 px-2 py-1.5 text-xs font-bold text-slate-400">
                        ⚠️ 技能已失效（反弹已触发过），本轮仅睁眼，无需行动
                      </p>
                      <button
                        type="button"
                        onClick={() => submitNightTarget('wolf_queen', 0)}
                        disabled={phaseDisabled}
                        className="mt-2 w-full rounded-2xl border border-slate-700 bg-slate-800 py-2 text-sm font-bold text-slate-300 transition active:scale-95"
                      >
                        本轮空过（继续）
                      </button>
                    </>
                  ) : (
                    <>
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
                    </>
                  )}
                </div>
              )}

            {/* 猎魔人面板 */}
            {myRole?.roleKey === 'demon_hunter' &&
              currentPhase?.roleKey === 'demon_hunter' &&
              currentPhase?.requiredAction === 'demon_hunter_hunt' && (
                <div className="mt-2 rounded-2xl border border-orange-500/40 bg-slate-950 p-2.5">
                  <p className="text-sm font-bold text-orange-400">猎魔人</p>
                  {onlineNightIndex < 2 ? (
                    <p className="mt-1 text-sm text-slate-300">
                      第一晚不能使用技能（第二晚起才可狩猎），请直接空过。
                    </p>
                  ) : (
                    <>
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
                    </>
                  )}
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
        {onlineStarted && !isDemo && onlinePhase === 'day' && nightEnded && (
          <section className="fixed inset-x-0 bottom-[calc(44px+max(8px,env(safe-area-inset-bottom)))] z-40 mx-auto flex max-h-[calc(58dvh-52px)] max-w-[480px] flex-col overflow-y-auto rounded-t-2xl border-t border-emerald-500/40 bg-slate-950/95 p-3 shadow-2xl backdrop-blur">
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

            {/* 当前警长 ⭐ */}
            {sheriffSeat !== null && dayStage !== null && (
              <p className="mt-2 rounded-xl border border-amber-500/40 bg-amber-500/10 px-3 py-1 text-center text-xs font-bold text-amber-300">
                ⭐ 警长：{sheriffSeat} 号
              </p>
            )}

            {/* 警长竞选：上警 */}
            {sheriffStage === 'apply' && (
              <div className="mt-4 rounded-xl border border-slate-700 bg-slate-900/60 px-3 py-2.5">
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
                  <div className="mt-2 grid grid-cols-2 gap-2">
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
              <div className="mt-4 rounded-xl border border-slate-700 bg-slate-900/60 px-3 py-2.5">
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
              <div className="mt-4 rounded-xl border border-slate-700 bg-slate-900/60 px-3 py-2.5">
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
                        className="rounded-xl border border-amber-500/50 bg-slate-950 py-2 text-sm font-bold text-amber-300 transition active:scale-95"
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
                  ⭐ {sheriffElectedInfo.seat} 号（{sheriffElectedInfo.name ?? ''}）当选警长
                </p>
                <p className="mt-0.5 text-xs text-slate-400">正在选择发言顺序…</p>
              </div>
            )}

            {/* 警长决定发言方向（仅警长本人） */}
            {sheriffStage === 'order' && (myRole?.seat ?? -1) === sheriffSeat && (
              <div className="mt-4 rounded-xl border border-amber-500/40 bg-slate-900/80 px-3 py-2.5">
                <p className="text-center text-base font-bold text-amber-300">
                  你当选警长，请决定发言顺序
                </p>
                <div className="mt-2 grid grid-cols-2 gap-2">
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
                      className="rounded-2xl bg-amber-500 py-2 text-sm font-bold text-slate-950 transition active:scale-95"
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
                <div className="mt-4 rounded-xl border border-amber-500/40 bg-slate-900/80 px-3 py-2.5">
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
                        className="rounded-xl border border-amber-500/50 bg-slate-950 py-2 text-sm font-bold text-amber-300 transition active:scale-95"
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
                  ⭐ 警长出局，正在处理警徽…
                </div>
              )}

            {/* 发言阶段：按顺序轮流发言，只有当前发言者可过麦 */}
            {dayStage === 'talk' && (
              <div className="mt-4 rounded-xl border border-slate-700 bg-slate-900/60 px-3 py-2.5">
                {currentSpeaker === null ? (
                  <p className="text-center text-sm text-slate-400">正在准备发言顺序…</p>
                ) : deadSeats.includes(myRole?.seat ?? -1) ? (
                  <p className="text-center text-sm text-slate-500">
                    你已经出局，正在观战。当前：{currentSpeaker}号玩家发言中
                  </p>
                ) : (myRole?.seat ?? -1) === currentSpeaker ? (
                  <>
                    <p className="text-center text-base font-bold text-amber-300">
                      {currentSpeaker === sheriffSeat ? '⭐ ' : ''}你是 {currentSpeaker} 号，轮到你了
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
                      {currentSpeaker === sheriffSeat ? '⭐ ' : ''}等待 {currentSpeaker} 号玩家发言
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
                      ⭐ 抢先发言
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
                        ? '⭐ 你是警长，你的票 = 1.5 票：'
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
                        {t.seat}号{t.seat === sheriffSeat ? '（⭐警长）' : ''}：{t.count}票
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

        {isDemo && game.phase !== 'waiting' && (
          <>
            {/* 顶部状态条 + 座位身份格（点按查看身份，出局置灰划线） */}
            <section className="mt-4">
              <div className="flex items-center justify-between gap-2">
                <p className="text-sm font-black text-amber-300">
                  {game.phase === 'night'
                    ? `🌙 第${game.dayCount}夜 ${game.nightIndex + 1}/${nightSteps.length} · ${currentStep?.name ?? ''}`
                    : `☀️ 第${game.dayCount}天`}
                </p>
                <div className="flex shrink-0 gap-1.5">
                  <button
                    type="button"
                    onClick={undo}
                    disabled={gameHistory.length === 0}
                    className="rounded-lg border border-amber-500/50 px-2.5 py-1 text-xs font-bold text-amber-300 active:scale-95 disabled:cursor-not-allowed disabled:opacity-40"
                  >
                    ↩ 撤回
                  </button>
                  <button
                    type="button"
                    onClick={() => setShowJudgeLog(true)}
                    className="rounded-lg border border-slate-700 px-2.5 py-1 text-xs font-bold text-slate-300 active:scale-95"
                  >
                    📋 记录
                  </button>
                  <button
                    type="button"
                    onClick={resetGame}
                    className="rounded-lg border border-rose-500/50 px-2.5 py-1 text-xs font-bold text-rose-300 active:scale-95"
                  >
                    结束
                  </button>
                </div>
              </div>
              <div className="mt-2 grid grid-cols-3 gap-2">
                {seats.map((seat) => {
                  const dead = judgeGraveyard.includes(seat)
                  const role = game.deal.find((d) => d.seat === seat)
                  // 阵营动态：咒狐未连=独立；情侣/丘比特随链显示（双好/双狼/人狼/含第三方）
                  let campLabel: string
                  // 情侣链跨夜持久化（game.lovers），兜底读当晚记录
                  const lovers = game.lovers ?? game.nightLog.find((a) => a.stepKey === 'cupid')?.targets ?? []
                  const isLover = lovers.includes(seat)
                  const isCupid = role?.key === 'cupid'
                  if (role?.key === 'lonely_girl') {
                    // 觉醒孤独少女：偶像被放逐变狼；其他方式出局继承偶像技能；未触发为好人
                    campLabel = game.lonelyConverted
                      ? '狼人（变狼）'
                      : game.lonelyInherited
                        ? `好人（继承${STEP_NAME_FALLBACK[game.lonelyInherited] ?? game.lonelyInherited}）`
                        : '好人'
                  } else if (role?.key === 'cursed_fox') {
                    campLabel = lovers.includes(seat) ? '第三方（情侣）' : '独立'
                  } else if (isLover || isCupid) {
                    const [la, lb] = lovers
                    const lr1 = game.deal.find((r) => r.seat === la)
                    const lr2 = game.deal.find((r) => r.seat === lb)
                    const pairHasThird = lr1?.key === 'cursed_fox' || lr2?.key === 'cursed_fox' ||
                      lr1?.key === 'lonely_girl' || lr2?.key === 'lonely_girl'
                    if (pairHasThird) campLabel = '第三方（情侣）'
                    else if (lr1?.camp === 'good' && lr2?.camp === 'good') campLabel = '好人（情侣）'
                    else if (lr1?.camp === 'wolf' && lr2?.camp === 'wolf') campLabel = '狼人（情侣）'
                    else campLabel = '第三方（情侣）'
                  } else {
                    campLabel = role?.camp === 'wolf' ? '狼人' : role?.camp === 'good' ? '好人' : '第三方'
                  }
                  // 阵营颜色跟随实时 campLabel（孤独少女变狼等动态变化也变色）
                  const campColor = dead
                    ? 'text-slate-600'
                    : campLabel.includes('狼')
                      ? 'text-rose-300'
                      : campLabel.includes('第三方')
                        ? 'text-violet-300'
                        : 'text-emerald-300'
                  // 孤独少女的偶像：卡片上显示 ⭐
                  // 偶像跨夜持久化（game.lonelyIdol），兜底读当晚记录
                  const idolSeat = game.lonelyIdol ?? game.nightLog.find((a) => a.stepKey === 'lonely_girl')?.target
                  const isIdol = seat === idolSeat
                  // 幸运儿：奇迹商人赋予技能的座位
                  const isLucky = game.luckySeat === seat
                  // 觉醒狼美人魅惑目标
                  const isWolfBeautyCharmed = game.wolfBeautyTarget === seat
                  // isLover 已在上方声明（情侣标识）
                  // 夜间技能标记：该座位被谁用了什么技能（狼妃封锁反弹）
                  const wolfQueenTargetSeat = game.nightLog.find((a) => a.stepKey === 'wolf_queen')?.target ?? null
                  const ravenSeat = game.deal.find((r) => r.key === 'raven')?.seat
                  const witchSeat = game.deal.find((r) => r.key === 'witch')?.seat
                  const dreamSeat = game.deal.find((r) => r.key === 'dream_weaver')?.seat
                  const seatMarks: string[] = []
                  game.nightLog.forEach((a) => {
                    const t = a.target
                    if (t == null) return
                    // 狼妃封锁反弹：乌鸦/女巫毒/摄梦人对封锁目标使用技能，反弹到施法者自己
                    if (wolfQueenTargetSeat === t) {
                      if (a.stepKey === 'raven' && ravenSeat === seat) { seatMarks.push('🚫诅咒'); return }
                      if (a.stepKey === 'witch' && a.kills && witchSeat === seat) { seatMarks.push('☠️毒'); return }
                      if (a.stepKey === 'dream_weaver' && dreamSeat === seat) { seatMarks.push('💤梦'); return }
                      // 封锁目标本身不显示这些技能标记
                      if (a.stepKey === 'raven' || (a.stepKey === 'witch' && a.kills) || a.stepKey === 'dream_weaver') return
                    }
                    if (t !== seat) return
                    switch (a.stepKey) {
                      case 'nightmare': seatMarks.push('😱恐惧'); break
                      case 'werewolf': seatMarks.push('🔪刀'); break
                      case 'witch':
                        if (a.kills) seatMarks.push('☠️毒');
                        else if (a.saves) seatMarks.push('💊救');
                        break
                      case 'seer': seatMarks.push('🔍验'); break
                      case 'dream_weaver': seatMarks.push('💤梦'); break
                      case 'raven': seatMarks.push('🚫诅咒'); break
                      case 'demon_hunter': seatMarks.push('🏹猎'); break
                      case 'wolf_queen': seatMarks.push('🔒锁'); break
                      case 'wolf_witch': seatMarks.push('👁️巫验'); break
                    }
                  })
                  return (
                    <button
                      key={seat}
                      type="button"
                      onClick={() => toggleGraveyard(seat)}
                      title="点击切换淘汰/复活"
                      className={`relative flex flex-col items-center rounded-lg border px-1 py-2.5 transition active:scale-95 ${
                        dead
                          ? 'border-slate-800 bg-slate-900/40 opacity-50'
                          : 'border-slate-700 bg-slate-900'
                      }`}
                    >
                      {/* 右上角：固定标识（⭐崇拜、💑情侣、🎁幸运儿、💫魅惑） */}
                      {(isIdol || isLover || isLucky || isWolfBeautyCharmed || sheriffSeat === seat) && (
                        <span className="absolute top-0.5 right-1 flex flex-col text-base leading-none">
                          {sheriffSeat === seat ? '⭐' : ''}{isLucky ? '🎁' : ''}{isIdol ? '🌟' : ''}{isLover ? '💑' : ''}{isWolfBeautyCharmed ? '💫' : ''}
                        </span>
                      )}
                      {/* 左上角：当晚技能标记 */}
                      {seatMarks.length > 0 && (
                        <span className="absolute top-0.5 left-1 flex flex-col text-xs leading-tight text-sky-300">
                          {seatMarks.map((m, i) => <span key={i}>{m}</span>)}
                        </span>
                      )}
                      {/* 中间：号码居中 */}
                      <span className={`text-xl font-black leading-none ${dead ? 'text-slate-600 line-through' : 'text-slate-100'}`}>
                        {seat}号
                      </span>
                      <span className={`mt-0.5 text-xs leading-tight ${dead ? 'text-slate-600 line-through' : campColor}`}>
                        {role ? role.name : '待分配'}
                      </span>
                      {role && (
                        <span className={`text-[9px] leading-tight ${dead ? 'text-slate-600' : campColor}`}>
                          {campLabel}阵营
                        </span>
                      )}
                    </button>
                  )
                })}
              </div>
            </section>

            {/* 底部固定操作卡（与在线游戏同款紧凑面板，整页无需滚动） */}
            <section className="fixed inset-x-0 bottom-0 z-40 mx-auto max-h-[60dvh] w-full max-w-[480px] overflow-y-auto rounded-t-2xl border-t border-amber-500/40 bg-slate-950/95 p-3 pb-[max(12px,env(safe-area-inset-bottom))] shadow-2xl backdrop-blur">
              {game.phase === 'night' && currentStep && (
                <>
                  <div className="flex items-center justify-between">
                    <p className="text-sm font-black text-slate-100">{currentStep.name} 行动</p>
                    <span className="text-[11px] text-slate-500">
                      {game.nightIndex + 1}/{nightSteps.length}
                    </span>
                  </div>
                  {/* 夜晚顺序小字：法官知道接下来喊谁 */}
                  <p className="mt-0.5 text-[10px] leading-tight text-slate-500">
                    夜晚顺序：
                    {nightSteps.map((s, i) => (
                      <span key={s.key} className={i === game.nightIndex ? 'text-amber-300 font-bold' : i < game.nightIndex ? 'text-slate-600' : 'text-slate-400'}>
                        {s.name}{i < nightSteps.length - 1 ? ' → ' : ''}
                      </span>
                    ))}
                  </p>
                  {(() => {
                    // 蚀日侍女吞噬：被吞噬者当晚技能失效（首夜不吞噬），只显示吞噬提示、不显示操作指引
                    const devourTarget = game.nightLog.find((a) => a.stepKey === 'sun_maid_devour')?.target ?? null
                    const dhSeats = game.deal.filter((r) => r.key === 'demon_hunter').map((r) => r.seat).sort((a, b) => a - b)
                    let stepRoleSeat: number | null = null
                    if (currentStep.key === 'demon_hunter_1') stepRoleSeat = dhSeats[0] ?? null
                    else if (currentStep.key === 'demon_hunter_2') stepRoleSeat = dhSeats[1] ?? null
                    else if (currentStep.key === 'sun_maid_use' || currentStep.key === 'sun_maid_devour') stepRoleSeat = game.deal.find((r) => r.key === 'sun_maid')?.seat ?? null
                    else if (currentStep.key !== 'lovers' && currentStep.key !== 'lucky_guy_receive' && currentStep.key !== 'lucky_guy_use') stepRoleSeat = game.deal.find((r) => r.key === currentStep.key)?.seat ?? null
                    const devourBlocked = game.dayCount > 1 && devourTarget != null && stepRoleSeat != null && devourTarget === stepRoleSeat
                    if (devourBlocked) {
                      return <p className="mt-1.5 rounded-lg bg-amber-500/15 px-2 py-1 text-xs font-bold text-amber-300">⚠️ {devourTarget}号被吞噬，技能禁用</p>
                    }
                    if (currentStep.key === 'wolf_queen' && game.wolfQueenUsed) {
                      return <p className="mt-1.5 rounded-lg bg-amber-500/15 px-2 py-1 text-xs font-bold text-amber-300">⚠️ 蚀时狼妃技能已失效（仅睁眼空过）</p>
                    }
                    // 猎魔人出局：保留流程，仅提示不操作（含当晚被刀未结算）
                    if (currentStep.key === 'demon_hunter_1' || currentStep.key === 'demon_hunter_2' || currentStep.key === 'demon_hunter') {
                      const dhSeatsH = game.deal.filter((r) => r.key === 'demon_hunter').map((r) => r.seat).sort((a, b) => a - b)
                      const dhSeatH = currentStep.key === 'demon_hunter_1' ? dhSeatsH[0] : currentStep.key === 'demon_hunter_2' ? dhSeatsH[1] : dhSeatsH[0] ?? null
                      if (dhSeatH != null && (judgeGraveyard.includes(dhSeatH) || safeNightLog.some((a) => a.kills && a.target === dhSeatH))) {
                        return <p className="mt-1.5 rounded-lg bg-amber-500/20 px-2 py-1 text-xs font-bold text-amber-300">⚠️ 猎魔人（{dhSeatH}号）已出局（保留流程，直接下一步）</p>
                      }
                    }
                    // 情侣确认：高亮显示两个情侣号码
                    if (currentStep.key === 'lovers') {
                      const loversTargets = game.lovers ?? game.nightLog.find((a) => a.stepKey === 'cupid')?.targets ?? []
                      if (loversTargets.length >= 2) {
                        return <p className="mt-1.5 rounded-lg bg-pink-500/20 px-2 py-1.5 text-sm font-black text-pink-300">❤️ 情侣：{loversTargets.join('号、')}号（请两人互相确认号码）</p>
                      }
                    }
                    // 角色专属高亮提醒卡（沙龙之夜风格，所有板子统一）
                    const roleHighlight: Record<string, { text: string; cls: string }> = {
                      nightmare: { text: '😈 噩梦之影请睁眼：选择 1 名玩家恐惧（被恐者当晚不能行动；恐惧狼人则狼队空刀，不能连续两晚恐同一人）', cls: 'bg-rose-500/15 text-rose-300' },
                      seer: { text: '🔮 预言家请睁眼：查验 1 名玩家身份', cls: 'bg-sky-500/15 text-sky-300' },
                      raven: { text: '🐦 乌鸦请睁眼：诅咒 1 名玩家（白天禁言禁投）', cls: 'bg-sky-500/15 text-sky-300' },
                      cupid: { text: '❤️ 丘比特请睁眼：连接 2 名玩家为情侣（可自连）', cls: 'bg-pink-500/15 text-pink-300' },
                      lonely_girl: {
                        text: game.dayCount > 1 || game.lonelyIdol != null
                          ? game.lonelyConverted
                            ? '🌟 觉醒孤独少女已变狼人（加入狼队，参与刀人）'
                            : game.lonelyInherited
                              ? `🌟 觉醒孤独少女已继承偶像技能：${STEP_NAME_FALLBACK[game.lonelyInherited] ?? game.lonelyInherited}`
                              : '🌟 觉醒孤独少女睁眼确认（偶像仍在，尚未触发）'
                          : '🌟 觉醒孤独少女请睁眼：选择 1 名玩家作为偶像（不能选自己）',
                        cls: 'bg-pink-500/15 text-pink-300',
                      },
                      dream_weaver: { text: '💤 摄梦人请睁眼：选择 1 名玩家梦游（梦游者免疫夜间伤害；连续两晚梦游则第二晚出局）', cls: 'bg-sky-500/15 text-sky-300' },
                      hunter: { text: '🔫 猎人请睁眼确认（白天被放逐或夜间被刀后可开枪）', cls: 'bg-sky-500/15 text-sky-300' },
                      wolf_king: { text: '👑 狼王请睁眼确认（同猎人）', cls: 'bg-rose-500/15 text-rose-300' },
                      wolf_witch: { text: '🧙 狼巫请睁眼：查验 1 名玩家具体身份', cls: 'bg-rose-500/15 text-rose-300' },
                      demon_hunter: { text: '🏹 猎魔人请睁眼：选择 1 名玩家狩猎（狩猎好人也会出局）', cls: 'bg-sky-500/15 text-sky-300' },
                      demon_hunter_1: { text: '🏹 猎魔人1请睁眼：选择 1 名玩家狩猎', cls: 'bg-sky-500/15 text-sky-300' },
                      demon_hunter_2: { text: '🏹 猎魔人2请睁眼：选择 1 名玩家狩猎', cls: 'bg-sky-500/15 text-sky-300' },
                      wolf_queen: { text: '🛡 蚀时狼妃请睁眼：封锁 1 名玩家（当晚好人阵营对封锁目标释放的查验/毒药/守护，视为对施法好人自身释放；技能生效后永久失效）', cls: 'bg-rose-500/15 text-rose-300' },
                      werewolf: { text: '🐺 狼人请睁眼：统一意见后选择刀人目标', cls: 'bg-rose-500/15 text-rose-300' },
                      awake_wolf_beauty: { text: '🌹 觉醒狼美人请睁眼：魅惑 1 名玩家（不能选自己）', cls: 'bg-rose-500/15 text-rose-300' },
                      witch: { text: '🧪 女巫请睁眼：决定是否使用药水', cls: 'bg-sky-500/15 text-sky-300' },
                      awake_seer: { text: '🔍 觉醒预言家请睁眼：查验 2 名玩家', cls: 'bg-sky-500/15 text-sky-300' },
                      mirror_girl: { text: '🔮 魔镜少女请睁眼：查验 1 名玩家具体身份', cls: 'bg-sky-500/15 text-sky-300' },
                      sun_maid_devour: { text: '🌞 蚀日侍女请睁眼：选择 1 名非狼人玩家吞噬', cls: 'bg-rose-500/15 text-rose-300' },
                      sun_maid_use: { text: '🌞 蚀日侍女请睁眼：决定是否使用吞噬的技能', cls: 'bg-rose-500/15 text-rose-300' },
                      miracle_merchant: { text: '✨ 奇迹商人请睁眼：选择技能与幸运儿', cls: 'bg-sky-500/15 text-sky-300' },
                      lucky_guy_receive: { text: '🎁 幸运儿请睁眼：接收奇迹商人技能', cls: 'bg-sky-500/15 text-sky-300' },
                      lucky_guy_use: { text: '🎁 幸运儿请睁眼：使用技能或选择不使用', cls: 'bg-sky-500/15 text-sky-300' },
                    }
                    const rh = roleHighlight[currentStep.key]
                    if (rh != null && !(currentStep.key === 'sun_maid_devour' && game.dayCount === 1)) {
                      const firstNightText = (currentStep.key === 'demon_hunter' || currentStep.key === 'demon_hunter_1' || currentStep.key === 'demon_hunter_2') && game.dayCount === 1
                        ? '🏹 猎魔人请睁眼（首夜只确认座位，第二晚起才可狩猎）'
                        : rh.text
                      return <p className={'mt-1.5 rounded-lg px-2 py-1.5 text-xs font-bold ' + rh.cls}>{firstNightText}</p>
                    }
                    return (
                      <p className="mt-0.5 text-xs leading-snug text-slate-400">
                        {currentStep.key === 'demon_hunter' && game.dayCount === 1
                          ? '第一晚不能使用技能，请直接下一步（第二晚起才可狩猎）'
                          : JUDGE_STEP_HINTS[currentStep.key] ?? ''}
                      </p>
                    )
                  })()}
                  {/* 幸运儿提示：仅幸运儿使用技能步骤显示 */}
                  {currentStep.key === 'lucky_guy_use' && game.luckySeat != null && game.luckySkill != null && (() => {
                    const sn = game.luckySkill === 'check' ? '查验' : game.luckySkill === 'poison' ? '毒药' : '守护'
                    return (
                      <p className="mt-1.5 rounded-lg bg-purple-500/15 px-2 py-1 text-[11px] font-bold text-purple-300">
                        🎁 幸运儿：{game.luckySeat}号　技能：{sn}{game.luckySkillUsed ? '（已使用）' : ''}
                      </p>
                    )
                  })()}

                  {/* 边走边分配：当前阶段需要的角色还没分配座位时，法官临时指定（狼人环节两个角色一并分配） */}
                  {(() => {
                    const reqs = currentStep.key === 'werewolf' ? getWolfPackReqs(currentBoard) : getStepRoleReqs(currentStep.key)
                    if (reqs === null) return null
                    const pending = reqs.filter((req) => {
                      if (!currentBoard.roles.some((r) => r.key === req.roleKey)) return false
                      const assignedCount = game.deal.filter((r) => r.key === req.roleKey).length
                      return assignedCount < req.count
                    })
                    if (pending.length === 0) return null
                    const unusedSeats = seats.filter((s) => !game.deal.some((r) => r.seat === s))
                    return (
                      <div className="mt-2">
                        {pending.map((req) => {
                          const roleInfo = currentBoard.roles.find((r) => r.key === req.roleKey)
                          const roleDisplay = roleInfo?.name ?? currentStep.name
                          const assignedCount = game.deal.filter((r) => r.key === req.roleKey).length
                          return (
                            <div key={req.roleKey} className="mt-1.5">
                              <p className="text-xs font-bold text-amber-300">📋 请为【{roleDisplay}】指定座位（还需 {req.count - assignedCount} 个）：</p>
                              <div className="mt-1 grid grid-cols-6 gap-1.5">
                                {unusedSeats.map((seat) => (
                                  <button
                                    key={seat}
                                    type="button"
                                    onClick={() => setGame((prev) => {
                                      const newDeal = [...prev.deal, { seat, key: req.roleKey, name: roleDisplay, camp: roleInfo?.camp ?? 'good' }]
                                      return { ...prev, deal: newDeal }
                                    })}
                                    className="rounded-lg border border-amber-500/60 bg-amber-500/10 py-2 text-xs font-bold text-amber-200 active:scale-95"
                                  >
                                    {seat}号
                                  </button>
                                ))}
                              </div>
                            </div>
                          )
                        })}
                      </div>
                    )
                  })()}

                  {/* 噩梦之影恐惧：被恐惧角色禁用操作，提示法官跳过 */}
                  {(() => {
                    const nightmareTarget = game.nightLog.find((a) => a.stepKey === 'nightmare')?.target
                    if (nightmareTarget == null) return null
                    // 狼人阶段被恐惧 -> 空刀
                    if (currentStep.key === 'werewolf') {
                      const fearedRole = game.deal.find((r) => r.seat === nightmareTarget)
                      if (fearedRole && fearedRole.camp === 'wolf') {
                        return <p className="mt-1 rounded-lg bg-rose-900/60 px-2 py-1.5 text-xs font-bold text-rose-300">⚠️ {nightmareTarget}号是狼人，被噩梦之影恐惧，今晚狼队空刀！</p>
                      }
                    }
                    // 具体神职/角色被恐惧 -> 禁用
                    const stepRoleSeat = game.deal.find((r) => r.key === currentStep.key)?.seat
                    if (stepRoleSeat === nightmareTarget) {
                      if (currentStep.key === 'hunter' || currentStep.key === 'wolf_king') {
                        return <p className="mt-1 rounded-lg bg-rose-900/60 px-2 py-1.5 text-xs font-bold text-rose-300">❌ 不可开枪（被恐惧）</p>
                      }
                      return <p className="mt-1 rounded-lg bg-rose-900/60 px-2 py-1.5 text-xs font-bold text-rose-300">⚠️ 被恐惧，无法行动</p>
                    }
                    // 猎人/狼王夜间确认：简约提示开枪状态
                    if (currentStep.key === 'hunter' || currentStep.key === 'wolf_king') {
                      return <p className="mt-1 rounded-lg bg-amber-900/60 px-2 py-1.5 text-xs font-bold text-amber-300">✅ 可开枪</p>
                    }
                    return null
                  })()}

                  {/* 狼人环节：觉醒狼美人魅惑目标（座位随狼人一并分配，行动一并选择） */}
                  {currentStep.key === 'werewolf' && (() => {
                    const wbSeat = game.deal.find((r) => r.key === 'awake_wolf_beauty')?.seat ?? null
                    const hasWolfBeauty = currentBoard.roles.some((r) => r.key === 'awake_wolf_beauty')
                    if (wbSeat == null && hasWolfBeauty) {
                      return <p className="mt-2 rounded-lg bg-slate-900 px-2 py-1.5 text-xs font-bold text-slate-400">🌹 觉醒狼美人座位未分配，请先在上方指定座位</p>
                    }
                    if (wbSeat == null) return null
                    const wbAlive = !judgeGraveyard.includes(wbSeat)
                    if (!wbAlive) {
                      return <p className="mt-2 rounded-lg bg-slate-900 px-2 py-1.5 text-xs font-bold text-slate-400">🌹 觉醒狼美人（{wbSeat}号）已出局，无需魅惑</p>
                    }
                    if (game.wolfBeautyUsed) {
                      return <p className="mt-1.5 rounded-lg bg-amber-500/15 px-2 py-1 text-xs font-bold text-amber-300">⚠️ 觉醒狼美人技能已失效（仅睁眼空过）</p>
                    }
                    return (
                      <div className="mt-2">
                        <p className="text-xs font-bold text-purple-300">🌹 觉醒狼美人魅惑目标（与刀人一并选择，不能选自己）：</p>
                        <div className="mt-1 grid grid-cols-6 gap-1.5">
                          {seats.filter((st) => !judgeGraveyard.includes(st) && st !== wbSeat).map((st) => {
                            const sel = wolfBeautyTarget === st
                            return (
                              <button
                                key={st}
                                type="button"
                                onClick={() => setWolfBeautyTarget(wolfBeautyTarget === st ? null : st)}
                                className={`rounded-lg py-2 text-xs font-bold active:scale-95 ${
                                  sel
                                    ? getCampCls(game, currentStep.key).sel
                                    : getCampCls(game, currentStep.key).un
                                }`}
                              >
                                {st}号
                              </button>
                            )
                          })}
                        </div>
                      </div>
                    )
                  })()}

                  {/* 觉醒狼美人步骤：已随狼人环节选择 -> 确认提示；未合并（兜底）-> 通用选号 */}
                  {currentStep.key === 'awake_wolf_beauty' && game.wolfBeautyTarget != null && (() => {
                    const wbSeat = game.deal.find((r) => r.key === 'awake_wolf_beauty')?.seat ?? null
                    const wbAlive = wbSeat != null && !judgeGraveyard.includes(wbSeat)
                    if (!wbAlive || game.wolfBeautyUsed) return null
                    return (
                      <p className="mt-2 rounded-lg bg-purple-500/15 px-2 py-1.5 text-xs font-bold text-purple-300">
                        ✅ 觉醒狼美人魅惑目标：{game.wolfBeautyTarget}号（已在狼人环节一并选择，点下一步确认）
                      </p>
                    )
                  })()}

                  {/* 奇迹商人：技能三选一 + 幸运儿号码，同屏显示 */}
                  {currentStep.key === 'miracle_merchant' && !isFearedStep && (() => {
                    const merchantSeat = game.deal.find((r) => r.key === 'miracle_merchant')?.seat ?? null
                    const skillName = luckySkill === 'check' ? '查验' : luckySkill === 'poison' ? '毒药' : '守护'
                    return (
                    <div className="mt-2">
                      <p className="text-xs font-bold text-purple-300">✨ 奇迹商人请睁眼：先选技能，再选幸运儿号码（不能选自己）</p>

                      {/* ① 技能三选一 */}
                      <p className="mt-2 text-[11px] text-slate-500">① 选择要赋予的一次性技能（三选一）：</p>
                      <div className="mt-1 grid grid-cols-3 gap-1.5">
                        {([
                          { key: 'check', name: '查验', cls: 'bg-amber-500' },
                          { key: 'poison', name: '毒药', cls: 'bg-rose-500' },
                          { key: 'guard', name: '守护', cls: 'bg-emerald-500' },
                        ] as const).map((sk) => {
                          const selected = luckySkill === sk.key
                          const dimmed = luckySkill !== null && !selected
                          return (
                            <button
                              key={sk.key}
                              type="button"
                              onClick={() => setLuckySkill(sk.key)}
                              className={`rounded-lg py-2.5 text-xs font-bold active:scale-95 ${
                                selected
                                  ? `${sk.cls} text-slate-950 ring-2 ring-white/70`
                                  : dimmed
                                    ? 'bg-slate-800 text-slate-600 opacity-40'
                                    : `${sk.cls} text-slate-950`
                              }`}
                            >
                              {sk.name}
                            </button>
                          )
                        })}
                      </div>

                      {/* ② 幸运儿号码（排除自己、死者） */}
                      <p className="mt-2 text-[11px] text-slate-500">② 选择幸运儿（不能选自己）：</p>
                      <div className="mt-1 grid grid-cols-6 gap-1.5">
                        {seats
                          .filter((st) => !judgeGraveyard.includes(st))
                          .map((seat) => {
                            const isSelf = seat === merchantSeat
                            const selected = luckySeat === seat
                            return (
                              <button
                                key={seat}
                                type="button"
                                disabled={isSelf}
                                onClick={() => setLuckySeat(seat)}
                                className={`rounded-lg py-2 text-xs font-bold active:scale-95 ${
                                  isSelf
                                    ? 'border border-slate-800 bg-slate-900 text-slate-600 opacity-40'
                                    : selected
                                      ? getCampCls(game, currentStep.key).sel
                                      : getCampCls(game, currentStep.key).un
                                }`}
                              >
                                {seat}号
                              </button>
                            )
                          })}
                      </div>

                      {luckySeat != null && luckySkill != null && (
                        <p className="mt-2 rounded-lg bg-purple-500/15 px-2 py-1.5 text-xs font-bold text-purple-300">
                          ✅ 幸运儿：{luckySeat}号，技能：{skillName}（点下一步确认；若幸运儿是狼人，技能作废且你次日出局）
                        </p>
                      )}
                    </div>
                    )
                  })()}

                  {/* 幸运儿接收技能告知（第一晚，仅告知不使用） */}
                  {currentStep.key === 'lucky_guy_receive' && (() => {
                    const lSeat = game.luckySeat ?? null
                    const lSkill = game.luckySkill ?? null
                    if (lSeat == null || lSkill == null) {
                      return <p className="mt-2 rounded-lg bg-slate-900 px-2 py-1.5 text-xs font-bold text-slate-400">🎁 幸运儿请睁眼，本局无幸运儿，无需行动</p>
                    }
                    const sn = lSkill === 'check' ? '查验' : lSkill === 'poison' ? '毒药' : '守护'
                    return (
                      <div className="mt-2 rounded-lg bg-purple-500/15 px-2 py-1.5">
                        <p className="text-xs font-bold text-purple-300">🎁 幸运儿（{lSeat}号）请睁眼</p>
                        <p className="mt-1 text-[11px] text-purple-200">你获得一次性技能【{sn}】。今晚后期「幸运儿·使用技能」阶段再决定是否使用。</p>
                      </div>
                    )
                  })()}

                  {/* 蚀日侍女吞噬目标选择（首夜只睁眼不行动） */}
                  {currentStep.key === 'sun_maid_devour' && !isFearedStep && (
                    <div className="mt-2">
                      {game.dayCount === 1 ? (
                        <p className="rounded-lg bg-slate-900 px-2 py-1.5 text-xs font-bold text-rose-300">🌞 蚀日侍女睁眼（首夜只确认座位，不行动，点下一步）</p>
                      ) : (
                        <>
                          <p className="text-xs font-bold text-rose-300">🌞 蚀日侍女请睁眼，选择一名非狼人玩家吞噬</p>
                          <p className="mt-1 text-[11px] text-slate-500">技能说明：获得并当晚使用该玩家的技能，被吞噬者当晚失去技能</p>
                          {nightTargets[0] != null && (() => {
                            const targetRole = game.deal.find((r) => r.seat === nightTargets[0])
                            if (!targetRole) return null
                            const sk = SUN_MAID_SKILL_MAP[targetRole.key] ?? null
                            const sn = sk ? SUN_MAID_SKILL_NAMES[sk] : targetRole.name
                            return <p className="mt-1 rounded-lg bg-rose-500/10 px-2 py-1 text-xs font-bold text-rose-300">吞噬 {nightTargets[0]}号：获得【{sn}】技能</p>
                          })()}
                        </>
                      )}
                    </div>
                  )}

                  {/* 蚀日侍女使用吞噬技能 */}
                  {currentStep.key === 'sun_maid_use' && !isFearedStep && (
                    <div className="mt-2">
                      <p className="text-xs font-bold text-rose-300">🌞 蚀日侍女请睁眼，决定是否使用吞噬的技能</p>
                      {(() => {
                        const skill = getSunMaidSkill(game)
                        if (skill == null) return <p className="mt-1 text-[11px] text-slate-500">本晚未吞噬到技能（可直接跳过）</p>
                        const sn = SUN_MAID_SKILL_NAMES[skill] ?? skill
                        const need2 = skill === 'check2'
                        const sunSeat = game.deal.find((r) => r.key === 'sun_maid')?.seat ?? null
                        return (
                          <>
                            <p className="mt-1 text-[11px] text-slate-500">本晚吞噬获得【{sn}】技能{need2 ? '（查验 2 人）' : ''}</p>
                            {skill === 'poison' && (
                              <p className="mt-1 rounded-lg bg-purple-500/10 px-2 py-1 text-[11px] font-bold text-purple-300">
                                🍷 女巫药水存量：解药 x{game.witchAntidoteCount ?? 1} | 毒药 x{game.witchPoisonCount ?? 1}（蚀日侍女本晚最多使用一瓶）
                              </p>
                            )}
                            <div className="mt-1.5 grid grid-cols-6 gap-1.5">
                              {seats.filter((st) => !judgeGraveyard.includes(st) && st !== sunSeat).map((st) => {
                                const sel = nightTargets.includes(st)
                                return (
                                  <button
                                    key={st}
                                    type="button"
                                    onClick={() => setNightTargets((prevNt) => sel
                                      ? prevNt.filter((x) => x !== st)
                                      : need2
                                        ? (prevNt.length >= 2 ? prevNt : [...prevNt, st])
                                        : (prevNt[0] === st ? [] : [st]))}
                                    className={`rounded-lg py-2 text-xs font-bold active:scale-95 ${
                                      sel
                                        ? getCampCls(game, currentStep.key).sel
                                        : getCampCls(game, currentStep.key).un
                                    }`}
                                  >
                                    {st}号
                                  </button>
                                )
                              })}
                            </div>
                            <p className="mt-1 text-[11px] text-slate-500">
                              {need2
                                ? (nightTargets.length >= 2 ? `已选 ${nightTargets[0]}号、${nightTargets[1]}号（再点可改选）` : `请选择 2 名玩家查验（${nightTargets.length}/2）`)
                                : (nightTargets[0] != null ? `已选 ${nightTargets[0]}号（再点可取消）` : '请选择 1 名玩家')}
                            </p>
                            {(() => {
                              const wolfQueenTarget = game.nightLog.find((a) => a.stepKey === 'wolf_queen')?.target ?? null
                              if (skill === 'check2' && nightTargets.length === 2) {
                                const hasWolf = nightTargets.some((t) => t !== wolfQueenTarget && game.deal.some((r) => r.seat === t && r.camp === 'wolf'))
                                return <p className="mt-1 rounded-lg bg-amber-500/10 px-2 py-1 text-xs font-bold text-amber-300">查验结果：{hasWolf ? '有狼人' : '无狼人'}</p>
                              }
                              if (skill === 'check' && nightTargets[0] != null) {
                                const t = nightTargets[0]
                                const hasWolf = t !== wolfQueenTarget && game.deal.some((r) => r.seat === t && r.camp === 'wolf')
                                return <p className="mt-1 rounded-lg bg-amber-500/10 px-2 py-1 text-xs font-bold text-amber-300">查验 {t}号：{hasWolf ? '有狼人' : '无狼人'}</p>
                              }
                              if (skill === 'identity' && nightTargets[0] != null) {
                                const t = nightTargets[0]
                                const tr = game.deal.find((r) => r.seat === t)
                                if (!tr) return null
                                const campLabel = tr.camp === 'wolf' ? '狼人' : tr.camp === 'good' ? '好人' : tr.camp === 'third' ? '第三方' : '独立'
                                return <p className="mt-1 rounded-lg bg-sky-500/10 px-2 py-1 text-xs font-bold text-sky-300">查验 {t}号：{tr.name}（{campLabel}）</p>
                              }
                              if (skill === 'curse' && nightTargets[0] != null) {
                                return <p className="mt-1 rounded-lg bg-amber-500/10 px-2 py-1 text-xs font-bold text-amber-300">已诅咒 {nightTargets[0]}号（本白天禁言）</p>
                              }
                              if (skill === 'guard' && nightTargets[0] != null) {
                                return <p className="mt-1 rounded-lg bg-emerald-500/10 px-2 py-1 text-xs font-bold text-emerald-300">已守护 {nightTargets[0]}号（今晚免疫夜间伤害）</p>
                              }
                              if (skill === 'fear' && nightTargets[0] != null) {
                                return <p className="mt-1 rounded-lg bg-amber-500/10 px-2 py-1 text-xs font-bold text-amber-300">已恐惧 {nightTargets[0]}号（今晚无法使用技能）</p>
                              }
                              if (skill === 'block' && nightTargets[0] != null) {
                                return <p className="mt-1 rounded-lg bg-cyan-500/10 px-2 py-1 text-xs font-bold text-cyan-300">已封锁 {nightTargets[0]}号（当晚好人技能作用该目标，反弹给施法好人自身）</p>
                              }
                              if ((skill === 'poison' || skill === 'hunt') && nightTargets[0] != null) {
                                return <p className="mt-1 rounded-lg bg-rose-500/10 px-2 py-1 text-xs font-bold text-rose-300">{skill === 'poison' ? '毒药' : '狩猎'}目标：{nightTargets[0]}号</p>
                              }
                              return null
                            })()}
                          </>
                        )
                      })()}
                    </div>
                  )}

                  {/* 魔镜少女查验 */}
                  {currentStep.key === 'mirror_girl' && !isFearedStep && (
                    <div className="mt-2">
                      <p className="text-xs font-bold text-sky-300">🔮 魔镜少女请睁眼，选择一名玩家查验具体身份</p>
                      {nightTargets[0] != null && (() => {
                        const targetRole = game.deal.find((r) => r.seat === nightTargets[0])
                        if (!targetRole) return null
                        const campLabel = targetRole.camp === 'wolf' ? '狼人' : targetRole.camp === 'good' ? '好人' : targetRole.camp === 'third' ? '第三方' : '独立'
                        return <p className="mt-1 rounded-lg bg-sky-500/10 px-2 py-1 text-xs font-bold text-sky-300">查验 {nightTargets[0]}号：{targetRole.name}（{campLabel}）</p>
                      })()}
                    </div>
                  )}

                  {/* 觉醒预言家查验两人 */}
                  {currentStep.key === 'awake_seer' && !isFearedStep && (
                    <div className="mt-2">
                      <p className="text-xs font-bold text-amber-300">🔍 觉醒预言家请睁眼，选择两名玩家查验（只告知是否有狼人）</p>
                      {nightTargets.length === 2 && (() => {
                        const wolfQueenTarget = game.nightLog.find((a) => a.stepKey === 'wolf_queen')?.target ?? null
                        const hasWolf = nightTargets.some((t) => {
                          if (t === wolfQueenTarget) return false // 狼妃封锁反弹=金水
                          return game.deal.some((r) => r.seat === t && r.camp === 'wolf')
                        })
                        return <p className="mt-1 rounded-lg bg-amber-500/10 px-2 py-1 text-xs font-bold text-amber-300">查验结果：{hasWolf ? '有狼人' : '无狼人'}</p>
                      })()}
                    </div>
                  )}

                  {currentStep.key === 'witch' && !isFearedStep && !(() => {
                    const devourTarget = game.nightLog.find((a) => a.stepKey === 'sun_maid_devour')?.target ?? null
                    const witchSeat = game.deal.find((r) => r.key === 'witch')?.seat ?? null
                    return game.dayCount > 1 && devourTarget != null && witchSeat != null && devourTarget === witchSeat
                  })() && (witchChoice === null || witchChoice === 'heal' || witchChoice === 'none' || witchChoice === 'poison') && (() => {
                    const wACount = game.witchAntidoteCount ?? (game.witchAntidoteUsed ? 0 : 1)
                    const wPCount = game.witchPoisonCount ?? (game.witchPoisonUsed ? 0 : 1)
                    const noPotion = wACount <= 0 && wPCount <= 0
                    return (
                    <>
                    {wACount > 0 && (
                    <div className="mt-2 rounded-lg bg-slate-900 px-2 py-1.5 text-xs font-bold text-rose-300">
                      {wolfTargetNow != null ? `今晚刀口：${wolfTargetNow}号玩家` : '今晚平安（狼人未刀人）'}
                    </div>
                    )}
                    <div className="mt-1.5 rounded-lg bg-purple-500/10 px-2 py-1 text-[11px] font-bold text-purple-300">
                      💊 药水存量：解药 x{wACount} | 毒药 x{wPCount}
                    </div>
                    {witchChoice === 'heal' && (
                      <p className="mt-1.5 rounded-lg bg-emerald-500/10 px-2 py-1 text-[11px] font-bold text-emerald-300">
                        ✅ 已选择：解药救活 {wolfTargetNow != null ? `${wolfTargetNow}号` : '无刀口'}（可点下方改选，点"下一步"提交）
                      </p>
                    )}
                    {witchChoice === 'none' && (
                      <p className="mt-1.5 rounded-lg bg-slate-700/40 px-2 py-1 text-[11px] font-bold text-slate-300">
                        ✅ 已选择：本轮不用药（可点下方改选，点"下一步"提交）
                      </p>
                    )}
                    {witchChoice === 'poison' && (
                      <p className="mt-1.5 rounded-lg bg-rose-500/10 px-2 py-1 text-[11px] font-bold text-rose-300">
                        ✅ 已选择：毒药杀人，请在下方选择毒药目标（可点上方按钮改选）
                      </p>
                    )}
                    {noPotion ? (
                      <p className="mt-2 rounded-lg bg-slate-800 px-2 py-1.5 text-xs font-bold text-slate-300">本轮不使用任何药水（双药已空）</p>
                    ) : (
                      <>
                      {isSelfKill && (
                        <p className="mt-1 rounded-lg bg-rose-900/60 px-2 py-1.5 text-xs font-bold text-rose-300">⚠️ 你被刀了，不能自救！只能用毒药或不用药。</p>
                      )}
                      <div className="mt-2 grid grid-cols-3 gap-1.5">
                        <button
                          type="button"
                          onClick={() => setWitchChoice('heal')}
                          disabled={isSelfKill || wACount <= 0}
                          className={`rounded-lg py-2 text-xs font-bold text-slate-950 active:scale-95 disabled:opacity-40 ${
                            witchChoice === 'heal' ? 'bg-emerald-500 ring-2 ring-white/70' : 'bg-emerald-500/70'
                          }`}
                        >
                          解药救人{wACount <= 0 ? '（已用）' : witchChoice === 'heal' ? '（已选）' : ''}
                        </button>
                        <button
                          type="button"
                          onClick={() => setWitchChoice('poison')}
                          disabled={wPCount <= 0}
                          className={`rounded-lg py-2 text-xs font-bold text-slate-950 active:scale-95 disabled:opacity-40 ${
                            witchChoice === 'poison' ? 'bg-rose-500 ring-2 ring-white/70' : 'bg-rose-500/70'
                          }`}
                        >
                          毒药杀人{wPCount <= 0 ? '（已用）' : witchChoice === 'poison' ? '（已选）' : ''}
                        </button>
                        <button
                          type="button"
                          onClick={() => setWitchChoice('none')}
                          className={`rounded-lg py-2 text-xs font-bold text-slate-100 active:scale-95 ${
                            witchChoice === 'none' ? 'bg-slate-500 ring-2 ring-white/70' : 'bg-slate-700'
                          }`}
                        >
                          不用药{witchChoice === 'none' ? '（已选）' : ''}
                        </button>
                      </div>
                      </>
                    )}
                    </>
                    )
                  })()}

                  {/* 幸运儿使用技能阶段（专属面板） */}
                  {currentStep.key === 'lucky_guy_use' && !isFearedStep && (() => {
                    const lSeat = game.luckySeat ?? null
                    const lSkill = game.luckySkill ?? null
                    const lUsed = game.luckySkillUsed ?? false
                    const skillName = lSkill === 'check' ? '查验' : lSkill === 'poison' ? '毒药' : '守护'
                    // 无幸运儿 / 无技能 / 已使用：空过提示
                    if (lSeat == null || lSkill == null || lUsed) {
                      return (
                        <div className="mt-2 rounded-lg bg-slate-900 px-2 py-1.5 text-xs font-bold text-slate-400">
                          🎁 幸运儿请睁眼，{lSeat == null ? '本局无幸运儿' : '技能已使用'}，无需行动
                        </div>
                      )
                    }
                    // 查验结果（选目标后实时显示，狼妃反弹=金水）
                    const checkResult = lSkill === 'check' && luckyTarget != null ? (() => {
                      const wq = game.nightLog.find((a) => a.stepKey === 'wolf_queen')?.target ?? null
                      const rebounded = luckyTarget === wq
                      const isWolf = game.deal.some((r) => r.seat === luckyTarget && r.camp === 'wolf')
                      return rebounded ? '金水（好人）' : isWolf ? '查杀（狼人）' : '金水（好人）'
                    })() : null
                    return (
                      <div className="mt-2">
                        <p className="text-xs font-bold text-purple-300">
                          🎁 你是幸运儿（{lSeat}号），获得一次性技能【{skillName}】，是否使用？
                        </p>
                        {/* 决定：使用 / 暂不使用 */}
                        {luckyUseChoice === null && (
                          <div className="mt-2 grid grid-cols-2 gap-1.5">
                            <button
                              type="button"
                              onClick={() => setLuckyUseChoice('use')}
                              className="rounded-lg bg-purple-500 py-2 text-xs font-bold text-slate-950 active:scale-95"
                            >
                              使用技能
                            </button>
                            <button
                              type="button"
                              onClick={() => setLuckyUseChoice('skip')}
                              className="rounded-lg bg-slate-700 py-2 text-xs font-bold text-slate-100 active:scale-95"
                            >
                              暂不使用（保留）
                            </button>
                          </div>
                        )}
                        {/* 选择使用：选目标号码（排除自己、死者） */}
                        {luckyUseChoice === 'use' && (
                          <div className="mt-2">
                            <p className="text-[11px] text-slate-500">
                              选择【{skillName}】目标（不能选自己）：
                            </p>
                            <div className="mt-1.5 grid grid-cols-6 gap-1.5">
                              {seats
                                .filter((s) => !judgeGraveyard.includes(s))
                                .map((s) => {
                                  const isSelf = s === lSeat
                                  const selected = luckyTarget === s
                                  return (
                                    <button
                                      key={s}
                                      type="button"
                                      disabled={isSelf}
                                      onClick={() => setLuckyTarget(s)}
                                      className={`rounded-lg py-2 text-xs font-bold active:scale-95 ${
                                        isSelf
                                          ? 'border border-slate-800 bg-slate-900 text-slate-600 opacity-40'
                                          : selected
                                            ? getCampCls(game, currentStep.key).sel
                                            : getCampCls(game, currentStep.key).un
                                      }`}
                                    >
                                      {s}号
                                    </button>
                                  )
                                })}
                            </div>
                            {/* 查验结果实时显示 */}
                            {checkResult != null && (
                              <p className="mt-1.5 rounded-lg bg-emerald-500/10 px-2 py-1 text-xs font-bold text-emerald-300">
                                查验 {luckyTarget}号：{checkResult}
                              </p>
                            )}
                            {luckyTarget != null && (
                              <button
                                type="button"
                                onClick={handleNextStep}
                                className="mt-2 w-full rounded-lg bg-purple-500 py-2 text-xs font-bold text-slate-950 shadow-lg shadow-purple-500/30 active:scale-95"
                              >
                                ✅ 提交使用技能{lSkill === 'poison' ? `（毒 ${luckyTarget}号）` : lSkill === 'check' ? `（查验 ${luckyTarget}号）` : `（守护 ${luckyTarget}号）`}
                              </button>
                            )}
                            <button
                              type="button"
                              onClick={() => { setLuckyUseChoice(null); setLuckyTarget(null) }}
                              className="mt-1.5 w-full rounded-lg border border-slate-700 py-1.5 text-[11px] font-bold text-slate-300 active:scale-95"
                            >
                              返回改选
                            </button>
                          </div>
                        )}
                        {/* 选择暂不使用 */}
                        {luckyUseChoice === 'skip' && (
                          <p className="mt-2 rounded-lg bg-slate-800 px-2 py-1.5 text-xs font-bold text-slate-300">
                            已选择暂不使用，技能保留到之后夜晚（点下一步继续）
                          </p>
                        )}
                      </div>
                    )
                  })()}

                  {(() => {
                    const devourTarget = game.nightLog.find((a) => a.stepKey === 'sun_maid_devour')?.target ?? null
                    const dhSeats = game.deal.filter((r) => r.key === 'demon_hunter').map((r) => r.seat).sort((a, b) => a - b)
                    let stepRoleSeat: number | null = null
                    if (currentStep.key === 'demon_hunter_1') stepRoleSeat = dhSeats[0] ?? null
                    else if (currentStep.key === 'demon_hunter_2') stepRoleSeat = dhSeats[1] ?? null
                    else if (currentStep.key !== 'lovers' && currentStep.key !== 'lucky_guy_receive' && currentStep.key !== 'lucky_guy_use' && currentStep.key !== 'sun_maid_use' && currentStep.key !== 'sun_maid_devour') stepRoleSeat = game.deal.find((r) => r.key === currentStep.key)?.seat ?? null
                    return game.dayCount > 1 && devourTarget != null && stepRoleSeat != null && devourTarget === stepRoleSeat
                  })() ? (
                    null
                  ) : (
                  ((isInheritedStep && currentStep.needTarget) ||
                    (currentStep.needTarget && currentStep.key !== 'witch' && currentStep.key !== 'miracle_merchant' && currentStep.key !== 'sun_maid_use' && !(currentStep.key === 'sun_maid_devour' && game.dayCount === 1) && !(currentStep.key === 'wolf_queen' && game.wolfQueenUsed)) ||
                    (currentStep.key === 'witch' && witchChoice === 'poison')) &&
                  (isInheritedStep ||
                    !(() => {
                      const dhS = game.deal.filter((r) => r.key === 'demon_hunter').map((r) => r.seat).sort((a, b) => a - b)
                      const s = currentStep.key === 'demon_hunter_1' ? dhS[0] : currentStep.key === 'demon_hunter_2' ? dhS[1] : null
                      return s != null && (judgeGraveyard.includes(s) || safeNightLog.some((a) => a.kills && a.target === s))
                    })()) && (
                    <>
                      <p className="mt-2 text-[11px] font-bold text-slate-500">
                        {isInheritedStep
                          ? '该角色已出局，由觉醒孤独少女（继承技能）代替操作：'
                          : currentStep.key === 'witch'
                            ? '选择要毒的玩家（可点上方按钮改选）'
                            : currentStep.targetCount === 2
                              ? '依次选 2 名玩家（再点取消）'
                              : '点击选择目标（再点取消）'}
                      </p>
                      {/* 预言家查验结果：狼妃封锁反弹=金水；查验狼人座位=查杀，否则=金水 */}
                      {currentStep.key === 'seer' && nightTargets[0] != null && (() => {
                        const targetSeat = nightTargets[0]
                        const wolfQueenTarget = game.nightLog.find((a) => a.stepKey === 'wolf_queen')?.target ?? null
                        const rebounded = wolfQueenTarget === targetSeat
                        const isWolf = game.deal.some((r) => r.seat === targetSeat && r.camp === 'wolf')
                        const result = rebounded ? '金水（好人）' : isWolf ? '查杀（狼人）' : '金水（好人）'
                        return <p className="mt-1 rounded-lg bg-emerald-500/10 px-2 py-1 text-xs font-bold text-emerald-300">查验 {targetSeat}号：{result}</p>
                      })()}
                      {/* 狼巫查验结果：显示具体角色名 */}
                      {currentStep.key === 'wolf_witch' && nightTargets[0] != null && (() => {
                        const targetRole = game.deal.find((r) => r.seat === nightTargets[0])
                        if (!targetRole) return null
                        return <p className="mt-1 rounded-lg bg-purple-500/10 px-2 py-1 text-xs font-bold text-purple-300">查验 {nightTargets[0]}号：{targetRole.name}</p>
                      })()}
                      {/* 噩梦之影恐惧结果 */}
                      {currentStep.key === 'nightmare' && nightTargets[0] != null && (
                        <p className="mt-1 rounded-lg bg-purple-500/10 px-2 py-1 text-xs font-bold text-purple-300">已恐惧 {nightTargets[0]}号（被恐者当晚不能行动）</p>
                      )}
                      {/* 乌鸦诅咒结果 */}
                      {currentStep.key === 'raven' && nightTargets[0] != null && (
                        <p className="mt-1 rounded-lg bg-teal-500/10 px-2 py-1 text-xs font-bold text-teal-300">已诅咒 {nightTargets[0]}号（白天禁言禁投）</p>
                      )}
                      {/* 丘比特情侣结果 */}
                      {currentStep.key === 'cupid' && nightTargets.length >= 1 && (
                        <p className="mt-1 rounded-lg bg-pink-500/10 px-2 py-1 text-xs font-bold text-pink-300">已连情侣：{nightTargets.join('号、')}号</p>
                      )}
                      {/* 摄梦人梦游结果 */}
                      {currentStep.key === 'dream_weaver' && nightTargets[0] != null && (
                        <p className="mt-1 rounded-lg bg-indigo-500/10 px-2 py-1 text-xs font-bold text-indigo-300">已梦游 {nightTargets[0]}号（免疫夜间伤害）</p>
                      )}
                      {/* 孤独少女偶像结果 */}
                      {currentStep.key === 'lonely_girl' && nightTargets[0] != null && (
                        <p className="mt-1 rounded-lg bg-amber-500/10 px-2 py-1 text-xs font-bold text-amber-300">已选偶像：{nightTargets[0]}号</p>
                      )}

                      <div className="mt-1 grid grid-cols-6 gap-1.5">
                        {seats
                          .filter((seat) => !judgeGraveyard.includes(seat))
                          .map((seat) => {
                            const selected = nightTargets.includes(seat)
                            // 号码按钮按当前角色阵营整体配色（狼=红 好=蓝 第三=粉 咒狐=橙）
                            const campCls = getCampCls(game, currentStep.key)
                            // 摄梦人不能对自己使用技能：摄梦人座位置灰
                            const dreamSeat = game.deal.find((r) => r.key === 'dream_weaver')?.seat
                            const isDreamSelf = currentStep.key === 'dream_weaver' && seat === dreamSeat
                            // 觉醒孤独少女不能选自己为偶像：自己座位置灰
                            const lonelySeat = game.deal.find((r) => r.key === 'lonely_girl')?.seat
                            const isLonelySelf = currentStep.key === 'lonely_girl' && seat === lonelySeat
                            // 噩梦之影不能连续两晚恐惧同一人
                            const isNightmareRepeat = currentStep.key === 'nightmare' && game.prevNightmareTarget === seat
                            // 觉醒狼美人不能魅惑自己
                            const isWolfBeautySelf = currentStep.key === 'awake_wolf_beauty' && seat === game.deal.find((r) => r.key === 'awake_wolf_beauty')?.seat
                            // 蚀日侍女不能吞噬自己
                            const isSunMaidSelf = currentStep.key === 'sun_maid_devour' && seat === game.deal.find((r) => r.key === 'sun_maid')?.seat
                            // 乌鸦可诅咒自己，但不能连续两晚诅咒同一人
                            const isRavenRepeat = currentStep.key === 'raven' && game.prevRavenTarget === seat
                            // 丘比特可连自己（自连 + 另一名玩家）
                            const isSelf = isDreamSelf || isLonelySelf || isNightmareRepeat || isWolfBeautySelf || isSunMaidSelf || isRavenRepeat
                            return (
                              <button
                                key={seat}
                                type="button"
                                disabled={isSelf || isFearedStep}
                                title={isDreamSelf ? '摄梦人不能对自己使用技能' : isLonelySelf ? '不能选自己为偶像' : undefined}
                                onClick={() => handleSeatSelect(seat)}
                                className={`rounded-lg py-2 text-xs font-bold active:scale-95 disabled:cursor-not-allowed disabled:opacity-30 ${
                                  isSelf
                                    ? 'border border-slate-800 bg-slate-900 text-slate-600'
                                    : selected
                                      ? campCls.sel
                                      : campCls.un
                                }`}
                              >
                                {seat}号
                              </button>
                            )
                          })}
                      </div>
                    </>
                  )
                  )
                  }

                  <div className="mt-2.5 flex gap-2">
                    {currentStep.canSkip && (
                      <button
                        type="button"
                        onClick={handleSkipStep}
                        className="rounded-xl bg-slate-700 px-4 py-2.5 text-sm font-bold text-slate-100 active:scale-95"
                      >
                        跳过
                      </button>
                    )}
                    <button
                      type="button"
                      onClick={handleNextStep}
                      disabled={!canNext}
                      className="flex-1 rounded-xl bg-amber-500 py-2.5 text-sm font-bold text-slate-950 shadow-lg shadow-amber-500/30 active:scale-95 disabled:opacity-40"
                    >
                      {isLastStep
                        ? (currentStep.needTarget && nightTargets.length >= currentStep.targetCount ? '提交并天亮' : '天亮了')
                        : '下一步'}
                    </button>
                  </div>
                  </>
              )}

              {game.phase === 'day' && (
                <>
                  {/* 警长竞选（第一晚） */}
                  {game.dayStage === 'sheriff' && (
                    <>
                      <p className="text-sm font-black text-slate-100">警长竞选：点选上警玩家（再点取消），选完点确定</p>
                      <div className="mt-1.5 grid grid-cols-6 gap-1.5">
                        {seats.filter((s) => !judgeGraveyard.includes(s)).map((seat) => (
                          <button
                            key={seat}
                            type="button"
                            onClick={() => setSheriffCandidates((prev) => prev.includes(seat) ? prev.filter((s) => s !== seat) : [...prev, seat])}
                            className={`rounded-lg py-2 text-xs font-bold active:scale-95 ${
                              sheriffCandidates.includes(seat)
                                ? 'bg-amber-500 text-slate-950'
                                : 'border border-slate-700 bg-slate-900 text-slate-300'
                            }`}
                          >
                            {seat}号
                          </button>
                        ))}
                      </div>
                      {sheriffCandidates.length > 0 && (
                        <>
                          <p className="mt-2 text-xs text-slate-400">从警上玩家中选警长：</p>
                          <div className="mt-1.5 grid grid-cols-6 gap-1.5">
                            {sheriffCandidates.map((seat) => (
                              <button
                                key={seat}
                                type="button"
                                onClick={() => setSheriffSeat(seat)}
                                className={`rounded-lg py-2 text-xs font-bold active:scale-95 ${
                                  sheriffSeat === seat
                                    ? 'bg-rose-500 text-slate-950'
                                    : 'border border-slate-700 bg-slate-900 text-slate-300'
                                }`}
                              >
                                ⭐{seat}号
                              </button>
                            ))}
                          </div>
                        </>
                      )}
                      <div className="mt-2.5 grid grid-cols-2 gap-2">
                        <button
                          type="button"
                          onClick={() => setGame((prev) => ({ ...prev, dayStage: 'deaths', graveyard: [...new Set([...(prev.graveyard ?? []), ...(prev.deaths ?? [])])] }))}
                          className="rounded-xl bg-slate-700 py-2.5 text-sm font-bold text-slate-100 active:scale-95"
                        >
                          无人上警
                        </button>
                        <button
                          type="button"
                          disabled={sheriffSeat === null}
                          onClick={() => setGame((prev) => ({ ...prev, dayStage: 'deaths', graveyard: [...new Set([...(prev.graveyard ?? []), ...(prev.deaths ?? [])])] }))}
                          className="rounded-xl bg-amber-500 py-2.5 text-sm font-bold text-slate-950 active:scale-95 disabled:opacity-40"
                        >
                          确定警长
                        </button>
                      </div>
                    </>
                  )}
                  {game.dayStage === 'nightGun' && game.nightGunShooter !== null && (
                    <>
                      <p className="text-sm font-black text-slate-100">
                        {game.nightGunShooter}号夜间死亡，是否发动技能开枪？（不翻牌）
                      </p>
                      {!gunArming ? (
                        <div className="mt-2.5 grid grid-cols-2 gap-2">
                          <button
                            type="button"
                            onClick={() => setGunArming(true)}
                            className="rounded-xl bg-rose-500 py-2.5 text-sm font-bold text-slate-950 active:scale-95"
                          >
                            开枪
                          </button>
                          <button
                            type="button"
                            onClick={handleNightGunNoShoot}
                            className="rounded-xl bg-slate-700 py-2.5 text-sm font-bold text-slate-100 active:scale-95"
                          >
                            不开枪
                          </button>
                        </div>
                      ) : (
                        <>
                          <div className="mt-1.5 grid grid-cols-6 gap-1.5">
                            {seats
                              .filter(
                                (seat) =>
                                  !judgeGraveyard.includes(seat) && seat !== game.nightGunShooter,
                              )
                              .map((seat) => (
                                <button
                                  key={seat}
                                  type="button"
                                  onClick={() => handleNightGunShoot(seat)}
                                  className="rounded-lg border border-slate-700 bg-slate-900 py-2 text-xs font-bold text-slate-300 active:scale-95"
                                >
                                  {seat}号
                                </button>
                              ))}
                          </div>
                          <button
                            type="button"
                            onClick={() => setGunArming(false)}
                            className="mt-2 w-full rounded-lg border border-slate-700 py-2 text-xs font-bold text-slate-300 active:scale-95"
                          >
                            取消开枪
                          </button>
                        </>
                      )}
                    </>
                  )}

                  {game.dayStage === 'lastWords' && (
                    <>
                      <p className="text-sm font-black text-amber-300">
                        死亡玩家发表遗言（法官口头进行）
                      </p>
                      <button
                        type="button"
                        onClick={skipLastWords}
                        className="mt-2.5 w-full rounded-xl bg-amber-500 py-2.5 text-sm font-bold text-slate-950 active:scale-95"
                      >
                        遗言结束，继续
                      </button>
                    </>
                  )}
                  {game.dayStage === 'deaths' && (
                    <>
                      <p className="text-sm font-black text-slate-100">昨晚死讯</p>
                      <p className="mt-1 text-xs font-bold text-rose-300">
                        {game.deaths.length > 0
                          ? game.deaths.map((seat) => `${seat}号死亡`).join('、')
                          : '平安夜，无人死亡'}
                      </p>
                      <button
                        type="button"
                        onClick={startVote}
                        className="mt-2.5 w-full rounded-xl bg-amber-500 py-2.5 text-sm font-bold text-slate-950 active:scale-95"
                      >
                        发起投票
                      </button>
                    </>
                  )}

                  {game.dayStage === 'vote' && (
                    <>
                      <p className="text-sm font-black text-slate-100">投票放逐（点选一名玩家）</p>
                      <div className="mt-1.5 grid grid-cols-6 gap-1.5">
                        {seats
                          .filter((seat) => !judgeGraveyard.includes(seat))
                          .map((seat) => {
                            const ravenTargetRaw = game.nightLog.find((a) => a.stepKey === 'raven')?.target
                            const wolfQueenTargetSeat = game.nightLog.find((a) => a.stepKey === 'wolf_queen')?.target ?? null
                            const ravenSeatNow = game.deal.find((r) => r.key === 'raven')?.seat
                            // 狼妃封锁反弹：乌鸦诅咒被封锁目标 -> 反弹到乌鸦自己
                            const ravenTarget = (wolfQueenTargetSeat === ravenTargetRaw && ravenSeatNow != null) ? ravenSeatNow : ravenTargetRaw
                            const muted = ravenTarget === seat
                            return (
                            <button
                              key={seat}
                              type="button"
                              onClick={() => setVoteSeat(seat)}
                              className={`rounded-lg py-2 text-xs font-bold active:scale-95 ${
                                voteSeat === seat
                                  ? 'bg-amber-500 text-slate-950'
                                  : 'border border-slate-700 bg-slate-900 text-slate-300'
                              }`}
                            >
                              {seat}号{muted ? ' 🚫' : ''}
                            </button>
                          )})}
                      </div>
                      <div className="mt-2.5 grid grid-cols-3 gap-1.5">
                        <button
                          type="button"
                          onClick={confirmExile}
                          disabled={voteSeat === null}
                          className="rounded-lg bg-rose-500 py-2 text-xs font-bold text-slate-950 active:scale-95 disabled:opacity-40"
                        >
                          确认放逐{voteSeat !== null ? ` ${voteSeat}号` : ''}
                        </button>
                        <button
                          type="button"
                          onClick={markTie}
                          className="rounded-lg bg-slate-700 py-2 text-xs font-bold text-slate-100 active:scale-95"
                        >
                          平票
                        </button>
                        <button
                          type="button"
                          onClick={cancelVote}
                          className="rounded-lg border border-slate-700 py-2 text-xs font-bold text-slate-300 active:scale-95"
                        >
                          取消
                        </button>
                      </div>
                    </>
                  )}

                  {game.dayStage === 'exile' && game.exiledSeat !== null && (
                    <>
                      <p className="text-sm font-black text-rose-300">
                        {game.exiledSeat}号被放逐，是否有遗言？
                      </p>
                      <div className="mt-2.5 grid grid-cols-2 gap-2">
                        <button
                          type="button"
                          onClick={() => handleLastWords(true)}
                          className="rounded-xl bg-amber-500 py-2.5 text-sm font-bold text-slate-950 active:scale-95"
                        >
                          有遗言
                        </button>
                        <button
                          type="button"
                          onClick={() => handleLastWords(false)}
                          className="rounded-xl bg-slate-700 py-2.5 text-sm font-bold text-slate-100 active:scale-95"
                        >
                          无遗言
                        </button>
                      </div>
                    </>
                  )}

                  {game.dayStage === 'gun' && game.exiledSeat !== null && (
                    <>
                      <p className="text-sm font-black text-slate-100">
                        {game.exiledSeat}号是{exiledRole?.name ?? '该角色'}，是否{gunActionLabel}？
                      </p>
                      {!gunArming ? (
                        <div className="mt-2.5 grid grid-cols-2 gap-2">
                          <button
                            type="button"
                            onClick={() => setGunArming(true)}
                            className="rounded-xl bg-rose-500 py-2.5 text-sm font-bold text-slate-950 active:scale-95"
                          >
                            {gunActionLabel}
                          </button>
                          <button
                            type="button"
                            onClick={handleGunNoShoot}
                            className="rounded-xl bg-slate-700 py-2.5 text-sm font-bold text-slate-100 active:scale-95"
                          >
                            不{gunActionLabel}
                          </button>
                        </div>
                      ) : (
                        <>
                          <div className="mt-1.5 grid grid-cols-6 gap-1.5">
                            {seats
                              .filter(
                                (seat) =>
                                  !judgeGraveyard.includes(seat) && seat !== game.exiledSeat,
                              )
                              .map((seat) => (
                                <button
                                  key={seat}
                                  type="button"
                                  onClick={() => handleGunShoot(seat)}
                                  className="rounded-lg border border-slate-700 bg-slate-900 py-2 text-xs font-bold text-slate-300 active:scale-95"
                                >
                                  {seat}号
                                </button>
                              ))}
                          </div>
                          <button
                            type="button"
                            onClick={() => setGunArming(false)}
                            className="mt-2 w-full rounded-lg border border-slate-700 py-2 text-xs font-bold text-slate-300 active:scale-95"
                          >
                            取消{gunActionLabel}
                          </button>
                        </>
                      )}
                    </>
                  )}

                  {game.dayStage === 'summary' && (
                    <>
                      <p className="text-sm font-black text-emerald-300">白天流程完成</p>
                      <ul className="mt-1.5 max-h-[24dvh] space-y-1 overflow-y-auto">
                        {game.dayLog.map((note, index) => (
                          <li
                            key={index}
                            className="rounded-lg bg-slate-900 px-2.5 py-1.5 text-xs text-slate-300"
                          >
                            {note}
                          </li>
                        ))}
                      </ul>
                      {(() => {
                        const gy = game.graveyard ?? []
                        const aliveWolf = game.deal.filter((r) => r.camp === 'wolf' && !gy.includes(r.seat)).length
                        const aliveGood = game.deal.filter((r) => r.camp === 'good' && !gy.includes(r.seat)).length
                        const lovers = game.lovers ?? []
                        const lr = lovers.map((s) => game.deal.find((r) => r.seat === s))
                        const isHW = lr.length === 2 && lr[0] && lr[1] &&
                          ((lr[0].camp === 'good' && lr[1].camp === 'wolf') ||
                           (lr[0].camp === 'wolf' && lr[1].camp === 'good'))
                        const hasThird = lr.some((r) => r && (r.key === 'cursed_fox' || r.key === 'lonely_girl'))
                        let win: string | null = null
                        if ((isHW || hasThird) && aliveGood === 0 && aliveWolf === 0) win = '第三方阵营胜利'
                        else if (aliveWolf === 0) win = '好人阵营胜利'
                        else if (aliveGood === 0) win = '狼人阵营胜利'
                        return win ? (
                          <p className="mt-2 rounded-lg bg-amber-500/20 px-3 py-2 text-center text-sm font-black text-amber-300">{win}</p>
                        ) : null
                      })()}
                      <button
                        type="button"
                        onClick={enterNight}
                        className="mt-2.5 w-full rounded-xl bg-amber-500 py-2.5 text-sm font-bold text-slate-950 active:scale-95"
                      >
                        进入黑夜
                      </button>
                    </>
                  )}
                </>
              )}
            </section>

            {/* 行动记录弹层（夜晚记录 + 白天记录 + 重置回配牌） */}
            {showJudgeLog && (
              <div
                className="fixed inset-0 z-50 flex items-end justify-center bg-black/60"
                onClick={() => setShowJudgeLog(false)}
              >
                <div
                  className="max-h-[70dvh] w-full max-w-[480px] overflow-y-auto rounded-t-2xl border-t border-slate-700 bg-slate-900 p-4 pb-[max(1rem,env(safe-area-inset-bottom))]"
                  onClick={(e) => e.stopPropagation()}
                >
                  <div className="flex items-center justify-between">
                    <p className="text-base font-black text-slate-100">行动记录</p>
                    <button
                      type="button"
                      onClick={() => setShowJudgeLog(false)}
                      className="text-slate-400"
                    >
                      ✕
                    </button>
                  </div>
                  <p className="mt-3 text-xs font-bold text-slate-400">第 {game.dayCount} 夜</p>
                  <ul className="mt-1 space-y-1">
                    {game.nightLog.length === 0 && (
                      <li className="text-xs text-slate-600">暂无</li>
                    )}
                    {game.nightLog.map((action, index) => (
                      <li
                        key={index}
                        className="rounded-lg bg-slate-950 px-2.5 py-1.5 text-xs text-slate-300"
                      >
                        <span className="text-slate-500">{action.stepName}：</span>
                        {action.note}
                      </li>
                    ))}
                  </ul>
                  <p className="mt-3 text-xs font-bold text-slate-400">白天记录</p>
                  <ul className="mt-1 space-y-1">
                    {game.dayLog.length === 0 && <li className="text-xs text-slate-600">暂无</li>}
                    {game.dayLog.map((note, index) => (
                      <li
                        key={index}
                        className="rounded-lg bg-slate-950 px-2.5 py-1.5 text-xs text-slate-300"
                      >
                        {note}
                      </li>
                    ))}
                  </ul>
                  <button
                    type="button"
                    onClick={() => {
                      setShowJudgeLog(false)
                      resetGame()
                    }}
                    className="mt-4 w-full rounded-xl border border-slate-700 py-2.5 text-sm font-bold text-slate-300 active:scale-95"
                  >
                    重置游戏（返回配牌）
                  </button>
                </div>
              </div>
            )}
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
