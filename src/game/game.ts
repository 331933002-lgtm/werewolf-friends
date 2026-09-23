import type { Board } from '../data/boards'
import { ROLE_DESCRIPTIONS } from '../data/roles'

export type GamePhase = 'waiting' | 'night' | 'day'

export interface SeatRole {
  seat: number
  key: string
  name: string
  camp: 'wolf' | 'good' | 'third' | 'fox'
}

export interface NightAction {
  stepKey: string
  stepName: string
  note: string
  target: number | null
  targets?: number[]
  kills: boolean
  saves: boolean
  /** 技能类型（奇迹商人/幸运儿：check/poison/guard） */
  skillType?: string | null
  /** 觉醒狼美人魅惑目标（狼人环节一并选择，无需单独睁眼步骤） */
  wolfBeautyTarget?: number | null
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
export type DayStage = 'deaths' | 'nightGun' | 'lastWords' | 'vote' | 'exile' | 'gun' | 'summary'

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
  /** 夜间死亡的猎人/狼王座位（天亮后触发开枪，不翻牌） */
  nightGunShooter?: number | null
  /** 跨晚状态：情侣两人（丘比特连完后固定） */
  lovers?: number[]
  /** 上一晚摄梦人目标（用于连续两晚判定） */
  prevDreamTarget?: number | null
  /** 女巫解药/毒药是否已用过 */
  witchAntidoteUsed?: boolean
  witchPoisonUsed?: boolean
  /** 女巫药水存量（默认解药1/毒药1；奇迹商人赠毒药给女巫时毒药+1，用掉实时递减） */
  witchAntidoteCount?: number
  witchPoisonCount?: number
  /** 孤独少女偶像座位 + 是否已变身 */
  lonelyIdol?: number | null
  lonelyConverted?: boolean
  lonelyInherited?: string | null
  /** 丘比特是否已连情侣 */
  cupidConnected?: boolean
  lovers?: number[]
  prevDreamTarget?: number | null
  witchAntidoteUsed?: boolean
  witchPoisonUsed?: boolean
  lonelyIdol?: number | null
  lonelyConverted?: boolean
  cupidConnected?: boolean
  /** 上一晚噩梦之影恐惧目标（不能连续两晚恐惧同一人） */
  prevNightmareTarget?: number | null
  prevRavenTarget?: number | null
  /** 上一晚蚀时狼妃封锁目标 */
  prevWolfQueenTarget?: number | null
  /** 蚀时狼妃反弹是否已触发（触发后技能永久失效，保留睁眼流程） */
  wolfQueenUsed?: boolean
  /** 线下法官助手：累计出局座位（夜间死讯/放逐/开枪），用于操作按钮过滤 */
  graveyard?: number[]
  /** 线下法官助手：胜方（wolf/good/lovers/cursed_fox），达到胜利条件时写入并结束 */
  winner?: string | null
  /** 线下法官助手：觉醒孤独少女追崇的偶像座位（首夜选定后全局保留） */
  lonelyIdol?: number | null
  /** 线下法官助手：摄梦人首次摄中咒狐的一次性保护是否已使用 */
  foxDreamFirstUsed?: boolean
  /** 线下法官助手：奇迹商人技能是否已用完（每局限一次） */
  merchantUsed?: boolean
  /** 线下法官助手：幸运儿座位 */
  luckySeat?: number | null
  /** 线下法官助手：幸运儿技能类型（seer/poison/guard） */
  luckySkill?: string | null
  /** 线下法官助手：幸运儿技能是否已使用 */
  luckySkillUsed?: boolean
  /** 线下法官助手：幸运儿是狼人（奇迹商人次日出局） */
  merchantIsWolf?: boolean
  /** 线下法官助手：觉醒狼美人魅惑目标 */
  wolfBeautyTarget?: number | null
  /** 线下法官助手：觉醒狼美人替死是否已生效 */
  wolfBeautyUsed?: boolean
  /** 本次白天出局为狼美人替死（替死者不能发动开枪技能） */
  exileReplaced?: boolean
  /** 蚀日侍女本晚吞噬获得的技能（poison/guard/curse/fear/block/check/check2/identity/hunt） */
  sunMaidSkill?: string | null
}

/**
 * 夜间行动顺序配置（key 与板子 nightOrder 严格对应）：
 * 觉醒孤独少女 -> 丘比特 -> 情侣（不对话只确认彼此号码） -> 噩梦之影 -> 摄梦人 ->
 * 蚀时狼妃 -> 狼人 -> 女巫 -> 预言家 -> 乌鸦 -> 猎人 -> 猎魔人 -> 狼王 -> 咒狐 -> 狼巫
 * prompt 直接使用 roles.ts 中的角色技能说明文本，法官自行判断结算。
 */
export const NIGHT_STEPS: NightStep[] = [
  {
    key: 'miracle_merchant',
    name: '奇迹商人',
    prompt: ROLE_DESCRIPTIONS['miracle_merchant'],
    needTarget: true,
    targetCount: 1,
    canSkip: true,
  },
  {
    key: 'lucky_guy_receive',
    name: '幸运儿',
    prompt: '幸运儿睁眼，使用奇迹商人赋予的技能（或选择不使用）。',
    needTarget: false,
    targetCount: 0,
    canSkip: true,
  },
  {
    key: 'sun_maid_devour',
    name: '蚀日侍女·吞噬',
    prompt: '蚀日侍女睁眼（第一晚仅确认座位，不吞噬；第二晚起选择一名非狼人玩家吞噬）。',
    needTarget: true,
    targetCount: 1,
    canSkip: true,
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
    prompt: '狼人睁眼，统一意见后刀人。',
    needTarget: true,
    targetCount: 1,
    canSkip: true,
  },
  {
    key: 'awake_wolf_beauty',
    name: '觉醒狼美人',
    prompt: '觉醒狼美人睁眼，魅惑一名玩家（不能选自己）。',
    needTarget: true,
    targetCount: 1,
    canSkip: true,
  },
  {
    key: 'witch',
    name: '女巫',
    prompt: ROLE_DESCRIPTIONS['witch'],
    needTarget: false,
    targetCount: 0,
    canSkip: true,
  },
  {
    key: 'awake_seer',
    name: '觉醒预言家',
    prompt: ROLE_DESCRIPTIONS['awake_seer'],
    needTarget: true,
    targetCount: 2,
    canSkip: true,
  },
  {
    key: 'mirror_girl',
    name: '魔镜少女',
    prompt: ROLE_DESCRIPTIONS['mirror_girl'],
    needTarget: true,
    targetCount: 1,
    canSkip: true,
  },
  {
    key: 'dream_weaver',
    name: '摄梦人',
    prompt: ROLE_DESCRIPTIONS['dream_weaver'],
    needTarget: true,
    targetCount: 1,
    canSkip: true,
  },
  {
    key: 'demon_hunter_1',
    name: '猎魔人1',
    prompt: '猎魔人1睁眼，选择一名玩家狩猎（第二晚起）。',
    needTarget: true,
    targetCount: 1,
    canSkip: true,
  },
  {
    key: 'demon_hunter_2',
    name: '猎魔人2',
    prompt: '猎魔人2睁眼，选择一名玩家狩猎（第二晚起）。',
    needTarget: true,
    targetCount: 1,
    canSkip: true,
  },
  {
    key: 'cursed_fox',
    name: '咒狐',
    prompt: '咒狐睁眼（仅第一晚）。',
    needTarget: false,
    targetCount: 0,
    canSkip: true,
  },
  {
    key: 'sun_maid_use',
    name: '蚀日侍女·使用技能',
    prompt: '蚀日侍女睁眼，使用吞噬到的技能（或选择不使用）。',
    needTarget: true,
    targetCount: 1,
    canSkip: true,
  },
  {
    key: 'lucky_guy_use',
    name: '幸运儿·使用技能',
    prompt: '幸运儿睁眼，使用奇迹商人赋予的技能（或选择不使用）。',
    needTarget: false,
    targetCount: 0,
    canSkip: true,
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

/**
 * 根据夜晚操作记录计算死讯
 * 摄梦人规则：
 *  - 梦游者免疫夜间伤害（狼刀/女巫毒/猎魔人狩猎均无效，除非连续两晚梦游或摄梦人出局）
 *  - 连续两晚成为梦游者 -> 第二晚天亮出局（prevDreamTarget 必须是上一晚目标）
 *  - 摄梦人本晚出局 -> 梦游者一并出局
 */
/** 蚀日侍女：吞噬角色 -> 获得的技能类型（结算从吞噬记录反推，不依赖外部状态） */
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

/** 被吞噬/被恐惧角色 -> 其夜间步骤 key（蚀日侍女技能结算共用） */
const DEVOUR_ROLE_STEPS: Record<string, string[]> = {
  witch: ['witch'],
  dream_weaver: ['dream_weaver'],
  raven: ['raven'],
  nightmare: ['nightmare'],
  wolf_queen: ['wolf_queen'],
  seer: ['seer'],
  awake_seer: ['awake_seer'],
  mirror_girl: ['mirror_girl'],
  demon_hunter: ['demon_hunter', 'demon_hunter_1', 'demon_hunter_2'],
}

export function computeDeaths(actions: NightAction[], state?: {
  deal: SeatRole[]
  graveyard: number[]
  lovers?: number[]
  prevDreamTarget?: number | null
  foxDreamFirstUsed?: boolean
  luckySeat?: number | null
  luckySkill?: string | null
  wolfBeautyTarget?: number | null
  wolfBeautyUsed?: boolean
  wolfQueenUsed?: boolean
  sunMaidSkill?: string | null
}): number[] {
  // 蚀日侍女吞噬：被吞噬者当晚失去技能（忽略其行动，避免被吞者技能仍生效）
  {
    const devourAction = actions.find((a) => a.stepKey === 'sun_maid_devour')
    const devoured = devourAction?.target ?? null
    if (devoured != null && state) {
      const devouredRole = state.deal.find((r) => r.seat === devoured)?.key
      if (devouredRole && DEVOUR_ROLE_STEPS[devouredRole]) {
        actions = actions.filter((a) => !DEVOUR_ROLE_STEPS[devouredRole].includes(a.stepKey))
      }
    }
  }
  // 蚀日侍女本晚吞噬获得的技能（优先状态字段，兜底从吞噬记录反推）
  const sunDevourAction = actions.find((a) => a.stepKey === 'sun_maid_devour')
  const sunSkillFromLog = sunDevourAction?.target != null && state
    ? (SUN_MAID_SKILL_MAP[state.deal.find((r) => r.seat === sunDevourAction.target)?.key ?? ''] ?? null)
    : null
  const sunSkill = state?.sunMaidSkill ?? sunSkillFromLog ?? null

  // 蚀日侍女使用【恐惧】：被恐者当晚技能失效（忽略其行动）
  {
    const sunFearAction = actions.find((a) => a.stepKey === 'sun_maid_use')
    const fearTarget = sunFearAction?.target ?? null
    if (sunSkill === 'fear' && fearTarget != null && state) {
      const fearedRole = state.deal.find((r) => r.seat === fearTarget)?.key
      if (fearedRole && DEVOUR_ROLE_STEPS[fearedRole]) {
        actions = actions.filter((a) => !DEVOUR_ROLE_STEPS[fearedRole].includes(a.stepKey))
      }
    }
  }
  const dreamAction = actions.find((a) => a.stepKey === 'dream_weaver')
  const dreamTarget = dreamAction?.target ?? null
  const killed = actions
    .filter((action) => action.kills && action.target !== null)
    .map((action) => action.target as number)
  const saved = actions
    .filter((action) => action.stepKey === 'witch' && action.saves && action.target !== null)
    .map((action) => action.target as number)
  // 梦游者免疫夜间伤害：先剔除（随后按连续两晚/摄梦人出局两条途径单独加回）
  let base = killed.filter((seat) => !saved.includes(seat))
  if (dreamTarget !== null) {
    base = base.filter((seat) => seat !== dreamTarget)
  }
  // 咒狐：被狼人刀不会出局（仅预言家查验可出局）
  if (state) {
    base = base.filter((seat) => state.deal.find((r) => r.seat === seat)?.key !== 'cursed_fox')
  }
  // 女巫毒药修正：毒猎魔人无效（毒药仍消耗）；被蚀时狼妃封锁的目标毒药反弹给女巫自己（解药不反弹）；梦游者免疫毒
  const witchAction = actions.find((a) => a.stepKey === 'witch')
  if (witchAction?.kills && witchAction.target != null) {
    const wolfQueenTarget = actions.find((a) => a.stepKey === 'wolf_queen')?.target ?? null
    const witchSeat = state?.deal.find((r) => r.key === 'witch')?.seat ?? null
    const demonHunterSeats = state?.deal.filter((r) => r.key === 'demon_hunter').map((r) => r.seat) ?? []
    let effectivePoison = witchAction.target
    if (effectivePoison === wolfQueenTarget && witchSeat != null) {
      effectivePoison = witchSeat // 狼妃封锁：毒反弹给女巫自己
      state!.wolfQueenUsed = true // 反弹触发：技能永久失效
    }
    if (demonHunterSeats.includes(effectivePoison)) {
      effectivePoison = null // 毒猎魔人无效（双猎魔人同样免疫）
    }
    base = base.filter((seat) => seat !== witchAction.target)
    if (effectivePoison != null && effectivePoison !== dreamTarget) {
      base.push(effectivePoison)
    }
  }
  // 蚀时狼妃封锁：只反弹好人阵营技能（查验/毒药/守护），狼刀为狼人阵营技能不反弹、正常结算
  const deaths = new Set(base)
  if (state) {
    const roleOf = (seat: number) => state.deal.find((r) => r.seat === seat)
    const wolfQueenTarget = actions.find((a) => a.stepKey === 'wolf_queen')?.target ?? null

    // 普通预言家查验封锁目标 -> 反弹触发（金水，技能永久失效）
    const seerAction = actions.find((a) => a.stepKey === 'seer')
    if (seerAction?.target != null && seerAction.target === wolfQueenTarget) {
      state.wolfQueenUsed = true
    }
    // 普通预言家查验咒狐 -> 咒狐出局（摄梦首次保护一次）
    if (seerAction?.target != null && roleOf(seerAction.target)?.key === 'cursed_fox') {
      const foxProtected = seerAction.target === dreamTarget && !(state.foxDreamFirstUsed ?? false)
      if (!foxProtected) deaths.add(seerAction.target)
    }

    // 觉醒预言家：每晚查验两人，其中含咒狐则咒狐出局
    //   狼妃反弹查验（咒狐是封锁目标）-> 咒狐隐藏；梦游保护 -> 不出局
    const awakeSeerAction = actions.find((a) => a.stepKey === 'awake_seer')
    const awakeTargets = awakeSeerAction?.targets
      ?? (awakeSeerAction?.target != null ? [awakeSeerAction.target] : [])
    for (const t of awakeTargets) {
      if (t === wolfQueenTarget) state.wolfQueenUsed = true // 查验封锁目标 -> 反弹触发
      if (roleOf(t)?.key === 'cursed_fox') {
        if (t === wolfQueenTarget) continue // 查验被反弹，咒狐隐藏
        if (t === dreamTarget) continue // 摄梦保护被查验出局的咒狐
        deaths.add(t)
      }
    }

    // 连续两晚成为梦游者 -> 第二晚天亮出局
    if (dreamTarget !== null && state.prevDreamTarget !== null && dreamTarget === state.prevDreamTarget) {
      deaths.add(dreamTarget)
    }

    // 摄梦人本晚出局 -> 梦游者一并出局
    const dreamerSeat = state.deal.find((r) => r.key === 'dream_weaver')?.seat
    if (
      dreamerSeat != null &&
      deaths.has(dreamerSeat) &&
      dreamTarget !== null &&
      dreamTarget !== dreamerSeat
    ) {
      deaths.add(dreamTarget)
    }

    // 猎魔人（单猎魔人板子）
    const demonHunterAction = actions.find((a) => a.stepKey === 'demon_hunter')
    const singleHunterSeat = state.deal.find((r) => r.key === 'demon_hunter')?.seat
    if (demonHunterAction?.target != null && singleHunterSeat != null) {
      const targetRole = roleOf(demonHunterAction.target)
      if (targetRole && targetRole.camp === 'wolf') {
        if (demonHunterAction.target !== dreamTarget) deaths.add(demonHunterAction.target)
      } else if (demonHunterAction.target !== dreamTarget) {
        // 狩猎好人 -> 目标好人免死，猎魔人自己出局（梦游者免疫则狩猎落空，不反噬）
        deaths.delete(demonHunterAction.target)
        deaths.add(singleHunterSeat)
      }
    }

    // 双猎魔人（沙龙之夜）：按座位排序，demon_hunter_1/2 依次结算
    const dhSeats = state.deal
      .filter((r) => r.key === 'demon_hunter')
      .map((r) => r.seat)
      .sort((a, b) => a - b)
    const dhPairs: { act: NightAction | undefined; seat: number | undefined }[] = [
      { act: actions.find((a) => a.stepKey === 'demon_hunter_1'), seat: dhSeats[0] },
      { act: actions.find((a) => a.stepKey === 'demon_hunter_2'), seat: dhSeats[1] },
    ]
    for (const { act, seat } of dhPairs) {
      if (act?.target == null || seat == null) continue
      const targetRole = roleOf(act.target)
      if (targetRole && targetRole.camp === 'wolf') {
        if (act.target !== dreamTarget) deaths.add(act.target) // 梦游狼人免疫，猎人不死
      } else if (act.target !== dreamTarget) {
        deaths.delete(act.target) // 目标好人免死
        deaths.add(seat) // 该猎魔人自己出局（梦游者免疫则落空）
      }
    }

    // 奇迹商人：幸运儿是狼人 -> 商人次日出局（首次成为梦游者则不出局）
    const merchantAction = actions.find((a) => a.stepKey === 'miracle_merchant')
    if (merchantAction?.target != null) {
      const merchantSeat = state.deal.find((r) => r.key === 'miracle_merchant')?.seat
      const luckyRole = roleOf(merchantAction.target)
      if (
        luckyRole &&
        luckyRole.camp === 'wolf' &&
        merchantSeat != null &&
        merchantSeat !== dreamTarget
      ) {
        deaths.add(merchantSeat)
      }
    }

    // 幸运儿技能结算
    const luckyAction = actions.find((a) => a.stepKey === 'lucky_guy_use')
    if (luckyAction?.target != null) {
      const luckySkill = state.luckySkill
      const luckyTarget = luckyAction.target
      const luckySeat = state.luckySeat
      if (luckySkill === 'check' && luckyTarget === wolfQueenTarget) {
        state.wolfQueenUsed = true // 幸运儿查验封锁目标 -> 反弹触发
      }
      if (luckySkill === 'poison') {
        // 先移除 action.kills 带入的原目标，再按规则判定
        deaths.delete(luckyTarget)
        if (luckyTarget === wolfQueenTarget) {
          // 狼妃封锁：毒反弹给幸运儿自己（梦游免疫）
          if (luckySeat != null && luckySeat !== dreamTarget) deaths.add(luckySeat)
        } else if (luckyTarget !== dreamTarget) {
          // 梦游免疫；毒猎魔人无效
          if (roleOf(luckyTarget)?.key !== 'demon_hunter') deaths.add(luckyTarget)
        }
      } else if (luckySkill === 'guard') {
        // 同守同救：被守护者同时被刀+被解药救 -> 死亡；否则免疫狼刀
        if (saved.includes(luckyTarget) && killed.includes(luckyTarget)) {
          deaths.add(luckyTarget)
        } else {
          deaths.delete(luckyTarget)
        }
      }
      // 查验：不影响死亡
    }

    // 蚀日侍女使用吞噬技能结算（sunSkill 由上方反推得到）
    const sunUseAction = actions.find((a) => a.stepKey === 'sun_maid_use')
    const sunTarget = sunUseAction?.target ?? null
    const sunSeat = state.deal.find((r) => r.key === 'sun_maid')?.seat ?? null
    if (sunTarget != null && sunSkill != null && sunSeat != null) {
      if (sunSkill === 'poison') {
        deaths.delete(sunTarget)
        if (sunTarget === wolfQueenTarget) {
          if (sunSeat !== dreamTarget) deaths.add(sunSeat) // 狼妃封锁：毒反弹给蚀日侍女自己
        } else if (sunTarget !== dreamTarget) {
          if (roleOf(sunTarget)?.key !== 'demon_hunter') deaths.add(sunTarget) // 毒猎魔人无效
        }
      } else if (sunSkill === 'hunt') {
        deaths.delete(sunTarget)
        const tr = roleOf(sunTarget)
        if (tr?.camp === 'wolf') {
          if (sunTarget !== dreamTarget) deaths.add(sunTarget)
        } else if (sunTarget !== dreamTarget) {
          if (sunSeat !== dreamTarget) deaths.add(sunSeat) // 狩猎好人 -> 蚀日侍女自己出局（梦游者免疫则落空）
        }
      } else if (sunSkill === 'guard') {
        deaths.delete(sunTarget) // 守护：免疫当晚夜间伤害
      } else if (sunSkill === 'block') {
        // 蚀时狼妃封锁技能：只反弹好人技能，狼刀不反弹、正常结算
      }
      // check / check2 / identity / curse / fear：无直接死亡效果
    }

    // 觉醒狼美人替死：首次面临出局时，被魅惑者替代出局（夜间）
    const wolfBeautySeat = state.deal.find((r) => r.key === 'awake_wolf_beauty')?.seat ?? null
    const wolfBeautyTarget = state.wolfBeautyTarget ?? null
    const wolfBeautyUsed = state.wolfBeautyUsed ?? false
    if (
      wolfBeautySeat != null &&
      wolfBeautyTarget != null &&
      !wolfBeautyUsed &&
      deaths.has(wolfBeautySeat)
    ) {
      state.wolfBeautyUsed = true
      if (wolfBeautyTarget !== dreamTarget) {
        // 被魅惑者非梦游：成功替死
        deaths.delete(wolfBeautySeat)
        deaths.add(wolfBeautyTarget)
      }
      // 被魅惑者梦游：替死被保护，狼美人自己死
    }

    // 情侣殉情（咒狐不参与链子）
    const lovers = (state.lovers ?? []).filter(
      (l) => state.deal.find((r) => r.seat === l)?.key !== 'cursed_fox',
    )
    for (const seat of [...deaths]) {
      const other = lovers.find((l) => l !== seat && (lovers[0] === seat || lovers[1] === seat))
      if (other != null && !deaths.has(other) && !state.graveyard.includes(other)) {
        if (other === dreamTarget) continue
        deaths.add(other)
      }
    }
  }
  return [...deaths].filter((s) => !state?.graveyard.includes(s)).sort((a, b) => a - b)
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
