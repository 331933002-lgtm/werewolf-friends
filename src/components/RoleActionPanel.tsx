/**
 * 角色操作面板（可独立测试的真实 JSX 交互按钮）。
 *  - 夜晚预言家：渲染「查验{X}号」按钮（点击立即提交查验）
 *  - 夜晚狼人：渲染「刀{X}号」按钮（点击立即提交狼刀）
 *  - 白天轮到发言：渲染「结束发言」按钮
 * 面板与现有各角色详细面板共存：这里提供统一的、语义明确的快捷操作按钮。
 */
interface RoleActionPanelProps {
  phase: 'night' | 'day'
  roleKey: string | null
  mySeat: number
  currentSpeaker: number | null
  /** 可选目标座位 */
  targets: number[]
  disabled?: boolean
  /** 夜晚行动：target 为目标座位 */
  onAction?: (target: number) => void
  /** 白天结束发言 */
  onTalkDone?: () => void
}

export default function RoleActionPanel({
  phase,
  roleKey,
  mySeat,
  currentSpeaker,
  targets,
  disabled = false,
  onAction,
  onTalkDone,
}: RoleActionPanelProps) {
  // 白天：只有 currentSpeaker 是自己才渲染「结束发言」
  if (phase === 'day') {
    if (currentSpeaker !== mySeat) return null
    return (
      <div data-testid="role-action-panel" className="mt-2">
        <button
          type="button"
          data-testid="end-speak"
          onClick={onTalkDone}
          disabled={disabled}
          className="w-full rounded-2xl bg-rose-500 py-2.5 text-base font-bold text-slate-950 transition active:scale-95 disabled:cursor-not-allowed disabled:opacity-40"
        >
          结束发言
        </button>
      </div>
    )
  }

  // 夜晚：按角色渲染对应操作按钮
  if (phase === 'night') {
    if (roleKey === 'seer') {
      return (
        <div data-testid="role-action-panel" className="mt-4 rounded-2xl border border-emerald-500/40 bg-slate-950 p-3">
          <p className="text-sm font-bold text-emerald-400">预言家 · 查验</p>
          <div className="mt-2 grid grid-cols-4 gap-1.5">
            {targets.map((seat) => (
              <button
                key={seat}
                type="button"
                data-testid={`check-${seat}`}
                onClick={() => onAction?.(seat)}
                disabled={disabled}
                className="rounded-xl border border-emerald-500/40 bg-emerald-500/10 py-2 text-sm font-bold text-emerald-200 transition active:scale-95 disabled:opacity-40"
              >
                查验{seat}号
              </button>
            ))}
          </div>
        </div>
      )
    }
    if (roleKey === 'wolf') {
      return (
        <div data-testid="role-action-panel" className="mt-4 rounded-2xl border border-rose-500/40 bg-slate-950 p-3">
          <p className="text-sm font-bold text-rose-400">狼人 · 刀人</p>
          <div className="mt-2 grid grid-cols-4 gap-1.5">
            {targets.map((seat) => (
              <button
                key={seat}
                type="button"
                data-testid={`kill-${seat}`}
                onClick={() => onAction?.(seat)}
                disabled={disabled}
                className="rounded-xl border border-rose-500/40 bg-rose-500/10 py-2 text-sm font-bold text-rose-200 transition active:scale-95 disabled:opacity-40"
              >
                刀{seat}号
              </button>
            ))}
          </div>
        </div>
      )
    }
  }

  return null
}
