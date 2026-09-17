import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { boards } from '../data/boards'
import type { Board } from '../data/boards'
import {
  NIGHT_STEPS,
  computeDeaths,
  type NightAction,
  type SeatRole,
} from '../game/game'

type Phase = 'setup' | 'night' | 'day' | 'over'
type DayStage = 'deaths' | 'vote' | 'gun' | 'summary'

interface OfflineState {
  playerCount: number
  seats: SeatRole[] | null
  phase: Phase
  nightIndex: number
  nightLog: NightAction[]
  deaths: number[]
  dayStage: DayStage
  exiledSeat: number | null
  exiledHasGun: boolean
  gunSource: number | null
  dayLog: string[]
  deadSeats: number[]
}

const STORAGE_KEY = 'werewolf-offline-judge'

const CAMP_COLORS: Record<string, string> = {
  wolf: 'text-rose-400 border-rose-500/40',
  good: 'text-emerald-400 border-emerald-500/40',
  third: 'text-amber-400 border-amber-500/40',
}

const CAMP_LABEL: Record<string, string> = {
  wolf: '狼人',
  good: '好人',
  third: '第三方',
}

function emptyState(): OfflineState {
  return {
    playerCount: 12,
    seats: null,
    phase: 'setup',
    nightIndex: 1,
    nightLog: [],
    deaths: [],
    dayStage: 'deaths',
    exiledSeat: null,
    exiledHasGun: false,
    gunSource: null,
    dayLog: [],
    deadSeats: [],
  }
}

function loadState(): OfflineState {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return emptyState()
    const parsed = JSON.parse(raw) as OfflineState
    return { ...emptyState(), ...parsed }
  } catch {
    return emptyState()
  }
}

/** 离线发牌：从板子角色池抽 N 张（N>角色数时循环补齐），保底至少 1 张狼牌 */
function buildOfflineDeck(board: Board, n: number): SeatRole[] {
  const pool = board.roles.flatMap((role) =>
    Array.from({ length: role.count }, () => ({
      key: role.key,
      name: role.name,
      camp: role.camp,
    })),
  )
  let source: typeof pool
  if (n <= pool.length) {
    source = pool
  } else {
    source = Array.from({ length: n }, (_, i) => pool[i % pool.length])
  }
  // 保底 1 狼
  const wolves = source.filter((r) => r.camp === 'wolf')
  const others = source.filter((r) => r.camp !== 'wolf')
  let shuffled: typeof pool
  if (wolves.length === 0) {
    shuffled = [...source]
  } else {
    const wolfIdx = Math.floor(Math.random() * wolves.length)
    const pickedWolf = wolves[wolfIdx]
    const restWolf = [...wolves.slice(0, wolfIdx), ...wolves.slice(wolfIdx + 1)]
    const rest = [...restWolf, ...others]
    for (let i = rest.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1))
      ;[rest[i], rest[j]] = [rest[j], rest[i]]
    }
    shuffled = [pickedWolf, ...rest]
  }
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1))
    ;[shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]]
  }
  return shuffled.slice(0, n).map((role, index) => ({ seat: index + 1, ...role }))
}

function Offline() {
  const navigate = useNavigate()
  const board: Board = boards[0]
  const [state, setState] = useState<OfflineState>(loadState)
  const [playerInput, setPlayerInput] = useState(12)
  const [activeStep, setActiveStep] = useState<string | null>(null)
  const [target, setTarget] = useState<number | null>(null)
  const [witchChoice, setWitchChoice] = useState<'save' | 'poison' | 'none' | null>(null)
  const [witchPoisonTarget, setWitchPoisonTarget] = useState<number | null>(null)

  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(state))
    } catch {
      // 忽略存储失败
    }
  }, [state])

  const persist = (next: OfflineState) => setState(next)

  // ---- 生成座位 ----
  const generate = () => {
    const n = Math.min(18, Math.max(6, playerInput))
    const deck = buildOfflineDeck(board, n)
    persist({ ...emptyState(), playerCount: n, seats: deck, phase: 'night' })
    setActiveStep(null)
  }

  const randomRedeal = () => {
    if (!state.seats) return
    const deck = buildOfflineDeck(board, state.playerCount)
    persist({ ...state, seats: deck })
  }

  const changeSeatRole = (seat: number, roleKey: string) => {
    if (!state.seats) return
    const role = board.roles.find((r) => r.key === roleKey)
    if (!role) return
    persist({
      ...state,
      seats: state.seats.map((s) =>
        s.seat === seat
          ? { seat, key: role.key, name: role.name, camp: role.camp }
          : s,
      ),
    })
  }

  // ---- 夜晚 ----
  const openStep = (stepKey: string) => {
    setActiveStep(stepKey)
    setTarget(null)
    setWitchChoice(null)
    setWitchPoisonTarget(null)
  }

  /** 记录一步夜晚操作（狼刀/女巫救毒标记 kills/saves，其余只记录目标） */
  const recordAction = (stepKey: string, note: string, t: number | null) => {
    const step = NIGHT_STEPS.find((s) => s.key === stepKey)
    let kills = false
    let saves = false
    if (stepKey === 'werewolf' && t !== null) kills = true
    if (stepKey === 'witch' && t !== null) {
      kills = witchChoice === 'poison'
      saves = witchChoice === 'save'
    }
    const action: NightAction = {
      stepKey,
      stepName: step?.name ?? stepKey,
      note,
      target: t,
      kills,
      saves,
    }
    persist({
      ...state,
      nightLog: [...state.nightLog.filter((a) => a.stepKey !== stepKey), action],
    })
    setActiveStep(null)
  }

  const witchTargetSeat = state.nightLog.find((a) => a.stepKey === 'werewolf')?.target ?? null

  const submitWitch = () => {
    if (!witchChoice) return
    if (witchChoice === 'poison' && witchPoisonTarget === null) return
    const t = witchChoice === 'poison' ? witchPoisonTarget : witchChoice === 'save' ? witchTargetSeat : null
    const note =
      witchChoice === 'save'
        ? `女巫救 ${witchTargetSeat}号`
        : witchChoice === 'poison'
          ? `女巫毒 ${witchPoisonTarget}号`
          : '女巫不用药'
    recordAction('witch', note, t)
  }

  // ---- 天亮 / 白天 ----
  const daybreak = () => {
    const deaths = computeDeaths(state.nightLog)
    const deadSeats = [...new Set([...state.deadSeats, ...deaths])]
    persist({ ...state, phase: 'day', deaths, deadSeats, dayStage: 'deaths' })
  }

  const openVote = () => persist({ ...state, dayStage: 'vote' })

  const exile = (seat: number) => {
    if (!state.seats) return
    const role = state.seats.find((s) => s.seat === seat)
    const canGun = role?.key === 'hunter' || role?.key === 'wolf_king'
    const log = [
      ...state.dayLog,
      `第${state.nightIndex}天：${seat}号（${role?.name ?? '?'}）被放逐${canGun ? '，可以发动技能' : ''}`,
    ]
    persist({
      ...state,
      dayStage: canGun ? 'gun' : 'summary',
      exiledSeat: seat,
      exiledHasGun: canGun,
      gunSource: canGun ? seat : null,
      dayLog: log,
      deadSeats: [...state.deadSeats, seat],
    })
  }

  const gun = (targetSeat: number) => {
    if (!state.seats || state.gunSource === null) return
    const shooter = state.seats.find((s) => s.seat === state.gunSource)
    const victim = state.seats.find((s) => s.seat === targetSeat)
    persist({
      ...state,
      dayStage: 'summary',
      dayLog: [
        ...state.dayLog,
        `${state.gunSource}号（${shooter?.name}）开枪带走 ${targetSeat}号（${victim?.name}）`,
      ],
      deadSeats: [...state.deadSeats, targetSeat],
    })
  }

  const enterNight = () =>
    persist({
      ...state,
      phase: 'night',
      nightIndex: state.nightIndex + 1,
      nightLog: [],
      deaths: [],
      dayStage: 'deaths',
      exiledSeat: null,
      exiledHasGun: false,
      gunSource: null,
    })

  const endGame = () => persist({ ...state, phase: 'over' })

  const resetAll = () => {
    localStorage.removeItem(STORAGE_KEY)
    setState(emptyState())
    setActiveStep(null)
  }

  const seatRoleMap = new Map<string, { name: string; prompt: string }>()
  NIGHT_STEPS.forEach((s) => seatRoleMap.set(s.key, s))

  // ---- 渲染 ----
  return (
    <div className="min-h-dvh w-full bg-slate-950 px-4 py-6 pb-16 text-slate-100">
      <div className="mx-auto max-w-lg">
        <div className="flex items-center justify-between">
          <button
            type="button"
            onClick={() => navigate('/')}
            className="rounded-xl border border-slate-700 px-4 py-2 text-sm font-medium text-slate-300 active:scale-95"
          >
            ← 返回
          </button>
          <h1 className="text-2xl font-black">线下法官模式</h1>
          <button
            type="button"
            onClick={resetAll}
            className="rounded-xl border border-rose-500/40 px-4 py-2 text-sm font-medium text-rose-300 active:scale-95"
          >
            重置
          </button>
        </div>
        <p className="mt-2 text-center text-xs text-slate-500">
          法官平板上帝视角 · 完全本地，不影响线上房间
        </p>

        {/* 设置：输入人数 */}
        {state.seats === null && (
          <div className="mt-8 rounded-2xl border border-slate-800 bg-slate-900 p-6">
            <p className="text-sm text-slate-400">游戏人数（6-18 人，默认 12）</p>
            <div className="mt-3 flex items-center gap-4">
              <input
                type="range"
                min={6}
                max={18}
                value={playerInput}
                onChange={(e) => setPlayerInput(Number(e.target.value))}
                className="w-full accent-amber-500"
              />
              <span className="w-12 shrink-0 text-center text-2xl font-black text-amber-400">
                {playerInput}
              </span>
            </div>
            <div className="mt-2 flex flex-wrap gap-1.5">
              {[6, 8, 10, 12, 15, 18].map((n) => (
                <button
                  key={n}
                  type="button"
                  onClick={() => setPlayerInput(n)}
                  className={`rounded-lg px-3 py-1 text-xs font-bold transition active:scale-95 ${
                    playerInput === n
                      ? 'bg-amber-500 text-slate-950'
                      : 'border border-slate-700 text-slate-300'
                  }`}
                >
                  {n}人
                </button>
              ))}
            </div>
            <p className="mt-4 text-sm text-slate-400">板子：{board.name}</p>
            <button
              type="button"
              onClick={generate}
              className="mt-5 w-full rounded-2xl bg-amber-500 py-5 text-xl font-bold text-slate-950 shadow-lg shadow-amber-500/30 transition active:scale-95"
            >
              生成 {playerInput} 个座位并随机发牌
            </button>
          </div>
        )}

        {/* 复盘 */}
        {state.phase === 'over' && state.seats && (
          <div className="mt-6 rounded-2xl border border-indigo-500/40 bg-slate-900 p-6">
            <p className="text-center text-xl font-black text-indigo-300">游戏复盘</p>
            <div className="mt-4 flex flex-col gap-2">
              {state.seats.map((s) => (
                <div
                  key={s.seat}
                  className={`flex items-center justify-between rounded-xl border px-4 py-2.5 ${
                    CAMP_COLORS[s.camp]
                  } ${state.deadSeats.includes(s.seat) ? 'opacity-50 line-through' : ''}`}
                >
                  <span className="font-medium">{s.seat}号</span>
                  <span className="text-sm">
                    {s.name}
                    <span className="ml-2 text-xs opacity-70">{CAMP_LABEL[s.camp]}</span>
                  </span>
                </div>
              ))}
            </div>
            <div className="mt-4 rounded-xl border border-slate-800 bg-slate-950 p-3">
              <p className="text-xs font-medium text-slate-400">出局记录</p>
              {state.dayLog.length > 0 ? (
                state.dayLog.map((l, i) => (
                  <p key={i} className="mt-1 text-xs text-slate-300">
                    {l}
                  </p>
                ))
              ) : (
                <p className="mt-1 text-xs text-slate-500">暂无</p>
              )}
            </div>
            <button
              type="button"
              onClick={resetAll}
              className="mt-5 w-full rounded-2xl bg-indigo-500 py-4 text-lg font-bold text-slate-950 transition active:scale-95"
            >
              再来一局
            </button>
          </div>
        )}

        {state.seats && state.phase !== 'over' && (
          <>
            {/* 上帝视角座位表 */}
            <div className="mt-6 rounded-2xl border border-slate-800 bg-slate-900 p-4">
              <div className="flex items-center justify-between">
                <p className="text-sm font-medium text-slate-400">上帝视角 · 座位表</p>
                <span className="text-xs text-slate-500">
                  第{state.nightIndex}晚 · {state.nightLog.length}/{NIGHT_STEPS.length} 步已记录
                </span>
              </div>
              <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-3">
                {state.seats.map((s) => (
                  <div
                    key={s.seat}
                    className={`rounded-xl border px-3 py-2 ${
                      state.deadSeats.includes(s.seat) ? 'border-slate-800 opacity-40' : ''
                    } ${CAMP_COLORS[s.camp]}`}
                  >
                    <div className="flex items-center justify-between">
                      <span className="font-bold">{s.seat}号</span>
                      {state.deadSeats.includes(s.seat) && (
                        <span className="text-xs text-rose-400">出局</span>
                      )}
                    </div>
                    <select
                      value={s.key}
                      onChange={(e) => changeSeatRole(s.seat, e.target.value)}
                      className="mt-1 w-full rounded-lg border border-slate-700 bg-slate-800 px-1.5 py-1 text-xs text-slate-200"
                    >
                      {board.roles.map((r) => (
                        <option key={r.key} value={r.key}>
                          {r.name}
                        </option>
                      ))}
                    </select>
                  </div>
                ))}
              </div>
              <button
                type="button"
                onClick={randomRedeal}
                className="mt-3 w-full rounded-xl border border-slate-700 py-3 text-sm font-bold text-slate-300 transition active:scale-95"
              >
                随机重发
              </button>
            </div>

            {/* 夜晚流程 */}
            {state.phase === 'night' && (
              <div className="mt-6 rounded-2xl border border-slate-800 bg-slate-900 p-4">
                <p className="text-sm font-medium text-slate-400">夜晚流程（点击角色控制）</p>
                <div className="mt-3 grid grid-cols-2 gap-2">
                  {NIGHT_STEPS.map((step) => {
                    const logged = state.nightLog.some((a) => a.stepKey === step.key)
                    return (
                      <button
                        key={step.key}
                        type="button"
                        onClick={() => openStep(step.key)}
                        className={`rounded-xl px-3 py-3 text-sm font-bold transition active:scale-95 ${
                          activeStep === step.key
                            ? 'bg-amber-500 text-slate-950'
                            : logged
                              ? 'border border-emerald-500/40 text-emerald-300'
                              : 'border border-slate-700 text-slate-300'
                        }`}
                      >
                        {step.name}
                        {logged && ' ✓'}
                      </button>
                    )
                  })}
                </div>
                <button
                  type="button"
                  onClick={daybreak}
                  className="mt-4 w-full rounded-2xl bg-emerald-500 py-5 text-xl font-bold text-slate-950 shadow-lg shadow-emerald-500/30 transition active:scale-95"
                >
                  天亮了（结算昨晚死讯）
                </button>
              </div>
            )}

            {/* 角色操作面板 */}
            {activeStep !== null && state.phase === 'night' && (
              <div className="mt-4 rounded-2xl border border-amber-500/40 bg-slate-950 p-4">
                {NIGHT_STEPS.filter((s) => s.key === activeStep).map((step) => (
                  <div key={step.key}>
                    <p className="text-sm font-bold text-amber-400">{step.name}</p>
                    <p className="mt-2 text-xs leading-relaxed text-slate-400">
                      {step.prompt}
                    </p>

                    {step.key === 'witch' && (
                      <div className="mt-4">
                        <p className="text-xs text-slate-400">
                          {witchTargetSeat !== null
                            ? `狼人今晚刀的是 ${witchTargetSeat}号`
                            : '今晚平安夜（无人被刀）'}
                        </p>
                        <div className="mt-2 flex flex-col gap-2">
                          <button
                            type="button"
                            onClick={() => setWitchChoice('save')}
                            className={`rounded-xl py-3 text-sm font-bold transition active:scale-95 ${
                              witchChoice === 'save'
                                ? 'bg-emerald-500 text-slate-950'
                                : 'border border-slate-700 text-slate-200'
                            }`}
                          >
                            救 {witchTargetSeat ?? '—'}号（解药）
                          </button>
                          <button
                            type="button"
                            onClick={() => setWitchChoice('poison')}
                            className={`rounded-xl py-3 text-sm font-bold transition active:scale-95 ${
                              witchChoice === 'poison'
                                ? 'bg-rose-500 text-slate-950'
                                : 'border border-slate-700 text-slate-200'
                            }`}
                          >
                            用毒药
                          </button>
                          <button
                            type="button"
                            onClick={() => setWitchChoice('none')}
                            className={`rounded-xl py-3 text-sm font-bold transition active:scale-95 ${
                              witchChoice === 'none'
                                ? 'bg-slate-500 text-slate-950'
                                : 'border border-slate-700 text-slate-200'
                            }`}
                          >
                            不用药
                          </button>
                        </div>
                        {witchChoice === 'poison' && (
                          <>
                            <p className="mt-3 text-xs text-slate-400">选择毒药目标</p>
                            <div className="mt-2 grid grid-cols-4 gap-2">
                              {(state.seats ?? []).map((s) => (
                                <button
                                  key={s.seat}
                                  type="button"
                                  onClick={() =>
                                    setWitchPoisonTarget(
                                      witchPoisonTarget === s.seat ? null : s.seat,
                                    )
                                  }
                                  className={`rounded-xl py-2.5 text-sm font-bold transition active:scale-95 ${
                                    witchPoisonTarget === s.seat
                                      ? 'bg-rose-500 text-slate-950'
                                      : 'border border-slate-700 text-slate-300'
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
                          onClick={submitWitch}
                          disabled={!witchChoice || (witchChoice === 'poison' && witchPoisonTarget === null)}
                          className="mt-4 w-full rounded-xl bg-purple-500 py-3.5 text-base font-bold text-slate-950 transition active:scale-95 disabled:cursor-not-allowed disabled:opacity-40"
                        >
                          记录女巫操作
                        </button>
                      </div>
                    )}

                    {step.key !== 'witch' && (
                      <div className="mt-4">
                        {step.needTarget && (
                          <>
                            <p className="text-xs text-slate-400">选择目标玩家</p>
                            <div className="mt-2 grid grid-cols-4 gap-2">
                              {(state.seats ?? []).map((s) => (
                                <button
                                  key={s.seat}
                                  type="button"
                                  onClick={() => setTarget(target === s.seat ? null : s.seat)}
                                  className={`rounded-xl py-2.5 text-sm font-bold transition active:scale-95 ${
                                    target === s.seat
                                      ? 'bg-amber-500 text-slate-950'
                                      : 'border border-slate-700 text-slate-300'
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
                          onClick={() =>
                            recordAction(
                              step.key,
                              step.needTarget
                                ? `${step.name}操作 ${target ?? '—'}号`
                                : `${step.name}已完成（无需目标）`,
                              target,
                            )
                          }
                          disabled={step.needTarget && target === null}
                          className="mt-4 w-full rounded-xl bg-amber-500 py-3.5 text-base font-bold text-slate-950 transition active:scale-95 disabled:cursor-not-allowed disabled:opacity-40"
                        >
                          记录{step.name}操作
                        </button>
                      </div>
                    )}
                  </div>
                ))}
              </div>
            )}

            {/* 白天流程 */}
            {state.phase === 'day' && (
              <div className="mt-6 rounded-2xl border border-emerald-500/40 bg-slate-900 p-4">
                <p className="text-sm font-bold text-emerald-400">白天 · 第{state.nightIndex}天</p>
                {state.deaths.length > 0 ? (
                  <p className="mt-2 text-base font-medium text-slate-200">
                    昨晚死讯：{state.deaths.map((d) => `${d}号`).join('、')}
                  </p>
                ) : (
                  <p className="mt-2 text-base font-medium text-emerald-300">平安夜</p>
                )}

                {state.dayStage === 'deaths' && (
                  <button
                    type="button"
                    onClick={openVote}
                    className="mt-4 w-full rounded-2xl bg-emerald-500 py-4 text-lg font-bold text-slate-950 transition active:scale-95"
                  >
                    发起投票（法官点选被放逐玩家）
                  </button>
                )}

                {state.dayStage === 'vote' && (
                  <>
                    <p className="mt-3 text-xs text-slate-400">点选被投票放逐的玩家（平票/流局由法官决定）</p>
                    <div className="mt-2 grid grid-cols-4 gap-2">
                      {state.seats.map((s) => (
                        <button
                          key={s.seat}
                          type="button"
                          onClick={() => exile(s.seat)}
                          className="rounded-xl border border-emerald-500/40 py-2.5 text-sm font-bold text-emerald-300 transition active:scale-95"
                        >
                          {s.seat}号
                        </button>
                      ))}
                    </div>
                  </>
                )}

                {state.dayStage === 'gun' && state.gunSource !== null && (
                  <>
                    <p className="mt-3 text-base font-medium text-rose-300">
                      {state.gunSource}号（
                      {state.seats.find((s) => s.seat === state.gunSource)?.name}）发动技能，选择带走玩家
                    </p>
                    <div className="mt-2 grid grid-cols-4 gap-2">
                      {state.seats.map((s) => (
                        <button
                          key={s.seat}
                          type="button"
                          onClick={() => gun(s.seat)}
                          className="rounded-xl border border-rose-500/40 py-2.5 text-sm font-bold text-rose-300 transition active:scale-95"
                        >
                          {s.seat}号
                        </button>
                      ))}
                    </div>
                  </>
                )}

                {state.dayStage === 'summary' && (
                  <>
                    <div className="mt-3 rounded-xl border border-slate-800 bg-slate-950 p-3">
                      <p className="text-xs text-slate-400">白天记录</p>
                      {state.dayLog.slice(-3).map((l, i) => (
                        <p key={i} className="mt-1 text-xs text-slate-300">
                          {l}
                        </p>
                      ))}
                    </div>
                    <div className="mt-4 flex flex-col gap-2">
                      <button
                        type="button"
                        onClick={enterNight}
                        className="w-full rounded-2xl bg-amber-500 py-4 text-lg font-bold text-slate-950 transition active:scale-95"
                      >
                        进入黑夜（第{state.nightIndex + 1}晚）
                      </button>
                      <button
                        type="button"
                        onClick={endGame}
                        className="w-full rounded-2xl border border-indigo-500/40 py-4 text-lg font-bold text-indigo-300 transition active:scale-95"
                      >
                        结束游戏（复盘身份）
                      </button>
                    </div>
                  </>
                )}
              </div>
            )}
          </>
        )}
      </div>
    </div>
  )
}

export default Offline
