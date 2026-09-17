/**
 * 倒计时时长规范（单位：秒）。
 * 实际倒计时由服务端时间戳统一下发（nightPhase 帧 stepDeadline / dayStarted 帧 speakerDeadline 等），
 * 前端只负责用服务端时间戳换算剩余秒数，绝不本地硬编码乱码时长。
 * 本文件同时作为自动化测试的断言依据，必须与服务端 party/game.js 默认值保持一致：
 *   NIGHT_STEP_MS = 60_000、TALK_MS = 90_000、LAST_WORDS_MS = 70_000
 */
export const NIGHT_STEP_SECONDS = 60
export const TALK_SECONDS = 90
export const LAST_WORDS_SECONDS = 70

/** 用服务端时间戳计算剩余秒数（向上取整，最少 0 秒） */
export function remainingSeconds(deadline: number, nowMs: number): number {
  return Math.max(0, Math.ceil((deadline - nowMs) / 1000))
}
