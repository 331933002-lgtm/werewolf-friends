import type { Board } from '../data/boards'
import { ROLE_DESCRIPTIONS } from '../data/roles'

export type GamePhase = 'waiting' | 'night' | 'day'

export interface SeatRole {
  seat: number
  key: string
  name: string
  camp: 'wolf' | 'good' | 'third'
}

export interface NightAction {
  stepKey: string
  stepName: string
  note: string
  target: number | null
  kills: boolean
  saves: boolean
}

export interface NightStepConfig {
  key: string
  name: string
  prompt: string
  needTarget: boolean
  targetCount: number
  canSkip: boolean
}

/** 白天流程阶段：死讯 -> 投票 -> 放逐（遗言） -> 开枪 -> 完成 */
export type DayStage = 'deaths' | 'vote' | 'exile' | 'gun' | 'summary'

export interface SavedGame {
  deal: SeatRole[]
  phase: GamePhase
  nightIndex: number
  nightLog: NightAction[]
  dayCount: number
  /** 天亮时计算并存下的昨晚死讯（座位号） */
  deaths: number[]
  /** 白天流程当前阶段 */
  dayStage: DayStage
  /** 被放逐的玩家座位 */
  exiledSeat: number | null
  /** 被放逐玩家是否有遗言 */
  exileHasLastWords: boolean | null
  /** 白天操作记录（放逐/遗言/开枪/平票），跨天累计用于复盘 */
  dayLog: string[]
}

/**
 * 夜间行动顺序配置（key 与板子 nightOrder 严格对应）：
 * 觉醒孤独少女 -> 丘比特 -> 情侣（不对话只确认彼此号码） -> 噩梦之影 -> 摄梦人 ->
 * 蚀时狼妃 -> 狼人 -> 女巫 -> 预言家 -> 乌鸦 -> 猎人 -> 猎魔人 -> 狼王 -> 咒狐 -> 狼巫
 * prompt 直接使用 roles.ts 中的角色技能说明文本，法官自行判断结算。
 */
export const NIGHT_STEPS: NightStepConfig[] = [
  {
    key: 'lonely_girl',
    name: '觉醒孤独少女',
    prompt: ROLE_DESCRIPTIONS['lonely_girl'],
    needTarget: true,
    targetCount: 1,
    canSkip: false,
  },
  {
    key: 'cupid',
    name: '丘比特',
    prompt: ROLE_DESCRIPTIONS['cupid'],
    needTarget: true,
    targetCount: 2,
    canSkip: false,
  },
  {
    key: 'lovers',
    name: '情侣',
    prompt: '请情侣睁眼，不对话，只确认彼此的号码。',
    needTarget: false,
    targetCount: 0,
    canSkip: false,
  },
  {
    key: 'nightmare',
    name: '噩梦之影',
    prompt: ROLE_DESCRIPTIONS['nightmare'],
    needTarget: true,
    targetCount: 1,
    canSkip: false,
  },
  {
    key: 'dream_weaver',
    name: '摄梦人',
    prompt: ROLE_DESCRIPTIONS['dream_weaver'],
    needTarget: true,
    targetCount: 1,
    canSkip: false,
  },
  {
    key: 'wolf_queen',
    name: '蚀时狼妃',
    prompt: ROLE_DESCRIPTIONS['wolf_queen'],
    needTarget: true,
    targetCount: 1,
    canSkip: true,
  },
  {
    key: 'werewolf',
    name: '狼人',
    prompt: '请狼人阵营睁眼，选择今晚要刀的一名玩家（狼王可自爆/自刀，噩梦之影恐惧效果由法官自行判断）。',
    needTarget: true,
    targetCount: 1,
    canSkip: false,
  },
  {
    key: 'witch',
    name: '女巫',
    prompt: ROLE_DESCRIPTIONS['witch'],
    needTarget: true,
    targetCount: 1,
    canSkip: false,
  },
  {
    key: 'seer',
    name: '预言家',
    prompt: ROLE_DESCRIPTIONS['seer'],
    needTarget: true,
    targetCount: 1,
    canSkip: false,
  },
  {
    key: 'raven',
    name: '乌鸦',
    prompt: ROLE_DESCRIPTIONS['raven'],
    needTarget: true,
    targetCount: 1,
    canSkip: true,
  },
  {
    key: 'hunter',
    name: '猎人',
    prompt: ROLE_DESCRIPTIONS['hunter'],
    needTarget: true,
    targetCount: 1,
    canSkip: true,
  },
  {
    key: 'demon_hunter',
    name: '猎魔人',
    prompt: ROLE_DESCRIPTIONS['demon_hunter'],
    needTarget: true,
    targetCount: 1,
    canSkip: true,
  },
  {
    key: 'wolf_king',
    name: '狼王',
    prompt: ROLE_DESCRIPTIONS['wolf_king'],
    needTarget: true,
    targetCount: 1,
    canSkip: true,
  },
  {
    key: 'cursed_fox',
    name: '咒狐',
    prompt: ROLE_DESCRIPTIONS['cursed_fox'],
    needTarget: false,
    targetCount: 0,
    canSkip: false,
  },
  {
    key: 'wolf_witch',
    name: '狼巫',
    prompt: ROLE_DESCRIPTIONS['wolf_witch'],
    needTarget: true,
    targetCount: 1,
    canSkip: false,
  },
]

/** 洗牌发牌：把板子角色随机打乱，按座位 1..N 依次发放（服务端发牌逻辑的本地模拟） */
export function shuffleDeal(board: Board): SeatRole[] {
  const pool = board.roles.flatMap((role) =>
    Array.from({ length: role.count }, () => ({
      key: role.key,
      name: role.name,
      camp: role.camp,
    })),
  )
  // Fisher-Yates 洗牌
  for (let i = pool.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1))
    ;[pool[i], pool[j]] = [pool[j], pool[i]]
  }
  return pool.map((role, index) => ({ seat: index + 1, ...role }))
}

/** 根据夜晚操作记录计算死讯（被刀/被毒且未被解药救回） */
export function computeDeaths(actions: NightAction[]): number[] {
  const killed = actions
    .filter((action) => action.kills && action.target !== null)
    .map((action) => action.target as number)
  const saved = actions
    .filter((action) => action.saves && action.target !== null)
    .map((action) => action.target as number)
  return killed.filter((seat) => !saved.includes(seat)).sort((a, b) => a - b)
}

function storageKey(roomId: string) {
  return `werewolf-room-${roomId}`
}

/** 从本地恢复游戏进度（刷新后仍可继续主持） */
export function loadSavedGame(roomId: string): SavedGame | null {
  try {
    const raw = localStorage.getItem(storageKey(roomId))
    return raw ? (JSON.parse(raw) as SavedGame) : null
  } catch {
    return null
  }
}

export function saveGame(roomId: string, game: SavedGame) {
  try {
    localStorage.setItem(storageKey(roomId), JSON.stringify(game))
  } catch {
    // 本地存储不可用时静默忽略
  }
}

export function clearSavedGame(roomId: string) {
  try {
    localStorage.removeItem(storageKey(roomId))
  } catch {
    // 忽略
  }
}
