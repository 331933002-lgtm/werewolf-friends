/**
 * 实时语音房间（TRTC Web SDK 云版 trtc-cloud-js-sdk 直连，不再走 TUICallKit）。
 *
 * 设计：所有玩家进入同一个 TRTC 语音房间，由服务端单播的语音权限
 * （VoicePerm：canSpeak / canHearWolves / isDeadChannel / hearUserIds）驱动
 *  muteLocalAudio / muteRemoteAudio 做精准控制：
 *  - canSpeak=false => muteLocalAudio(true)（服务端强制闭麦）
 *  - 远端玩家不在 hearUserIds 中 => muteRemoteAudio(uid, true)（死亡频道 / 狼人隔离 / 防诈尸）
 *  - 死亡玩家 isDeadChannel=true：只听死亡频道（死狼可额外单向收听活狼讨论）
 *
 * 麦克风交互 UI（本地开关 + 场景化状态）：
 *  - 白天：当前发言者「🎤 正在发言（点击结束发言）」；其他人「🎤 等待 X 号发言（已自动闭麦）」
 *  - 警长特权：本白天未发言的警长显示「👑 抢先发言」；发言后按钮置灰（本白天不可再抢）
 *  - 夜晚：存活狼人「🐺 狼人频道麦」；存活好人「🌙 黑夜请闭眼」；死亡玩家「💀 死亡频道麦」
 *  - 赛前/赛后（waiting/over）：「🎙 自由麦（全员可发言）」
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import TRTC_Cloud, { TRTCAppScene, TRTCRoleType } from 'trtc-cloud-js-sdk'
import type { VoicePerm } from './game/party'

export type VoicePhase = 'waiting' | 'lobby' | 'day' | 'night' | 'over'

interface VoiceRoomProps {
  userId: string
  nickname: string
  sdkAppId: number
  userSig: string
  /** 游戏房间 id：同一局所有玩家映射到同一个 TRTC 房间 */
  gameRoomId: string
  /** 服务端单播的当前语音权限 */
  perm: VoicePerm
  // ---- 游戏状态（可选；用于麦克风交互 UI，不传则退化为纯连接状态条）----
  phase?: VoicePhase
  mySeat?: number | null
  currentSpeaker?: number | null
  sheriffSeat?: number | null
  isSheriff?: boolean
  sheriffHasSpokenThisDay?: boolean
  isWolf?: boolean
  isAlive?: boolean
  /** 结束发言（talkDone）——白天轮到本地发言时点击 */
  onTalkDone?: () => void
  /** 警长抢先发言（sheriffInterrupt）——剥夺当前发言者的麦克风 */
  onSheriffInterrupt?: () => void
}

/** 同一局所有玩家进入同一个 TRTC 语音房间：返回带字母前缀的字符串房间号
 * （TRTC 字符串房间号不能是纯数字串，统一加 wf- 前缀避免误判为数字房间号） */
function toTrtcRoomId(roomId: string): string {
  return `wf-${roomId || 'room'}`
}

export default function VoiceRoom({
  userId,
  sdkAppId,
  userSig,
  gameRoomId,
  perm,
  phase = 'waiting',
  mySeat = null,
  currentSpeaker = null,
  isSheriff = false,
  sheriffHasSpokenThisDay = false,
  isWolf = false,
  isAlive = true,
  onTalkDone,
  onSheriffInterrupt,
}: VoiceRoomProps) {
  const trtcRef = useRef<InstanceType<typeof TRTC_Cloud> | null>(null)
  const permRef = useRef<VoicePerm>(perm)
  /** 本地手动开关（仅服务端 canSpeak=true 时有效；canSpeak=false 强制闭麦） */
  const micOnRef = useRef(false)
  const [micOn, setMicOn] = useState(false)
  /** 已加入的远端玩家 userId 集合（stream-added / audio-available 时登记） */
  const remoteUsersRef = useRef<Set<string>>(new Set())
  const [ready, setReady] = useState(false)
  const [errorText, setErrorText] = useState<string | null>(null)

  /** 本地麦克风：服务端 canSpeak 且本地开关打开才允许发声 */
  const applyLocalMute = useCallback(() => {
    const trtc = trtcRef.current
    if (!trtc) return
    const can = permRef.current.canSpeak && micOnRef.current
    void trtc.muteLocalAudio(!can)
  }, [])

  /** 远端静音：只有 hearUserIds 里的远端能听到，其余一律 muteRemoteAudio */
  const applyRemoteMutes = useCallback(() => {
    const trtc = trtcRef.current
    if (!trtc) return
    const hear = new Set(permRef.current.hearUserIds)
    for (const uid of remoteUsersRef.current) {
      void (hear.has(uid)
        ? trtc.muteRemoteAudio(uid, false)
        : trtc.muteRemoteAudio(uid, true))
    }
  }, [])

  /** 本地麦克风开关：点击切换（服务端强制闭麦时禁用） */
  const toggleMic = useCallback(() => {
    if (!permRef.current.canSpeak) return
    micOnRef.current = !micOnRef.current
    setMicOn(micOnRef.current)
    applyLocalMute()
  }, [applyLocalMute])

  /** PTT 按住说话（大厅/游戏结束后）：按住开麦，松开闭麦 */
  const pttDown = useCallback(() => {
    if (!ready || !permRef.current.canSpeak) return
    micOnRef.current = true
    setMicOn(true)
    applyLocalMute()
  }, [ready, applyLocalMute])
  const pttUp = useCallback(() => {
    micOnRef.current = false
    setMicOn(false)
    applyLocalMute()
  }, [applyLocalMute])

  // 服务端单播权限变化 -> 立即生效；服务端权威决定本地开关：
  // canSpeak=true 自动开麦（轮到/获准发言即解除静音）；false 强制闭麦并复位本地开关。
  // 大厅/结束后（freeMic）改"按住说话"：默认闭麦，按住才开麦（避免环境噪音串入复盘）
  useEffect(() => {
    permRef.current = perm
    const pttMode = phase === 'waiting' || phase === 'over'
    micOnRef.current = pttMode ? false : perm.canSpeak
    setMicOn(micOnRef.current)
    applyLocalMute()
    applyRemoteMutes()
  }, [perm, phase, applyLocalMute, applyRemoteMutes])

  // 进房 + 本地音频发布 + 远端监听（整局只执行一次）
  useEffect(() => {
    if (!userSig || !sdkAppId) {
      setErrorText('语音凭证未就绪（缺少 userSig / sdkAppId）')
      return
    }
    let cancelled = false
    const trtc = new TRTC_Cloud()
    trtcRef.current = trtc

    const onRemoteEnter = (uid: string) => {
      remoteUsersRef.current.add(uid)
      // 远端刚进房时立刻按当前权限静音，避免串音
      applyRemoteMutes()
    }
    const onRemoteLeave = (uid: string) => {
      remoteUsersRef.current.delete(uid)
    }
    const onUserAudioAvailable = (uid: string, available: boolean) => {
      if (available) {
        remoteUsersRef.current.add(uid)
        applyRemoteMutes()
      }
    }

    trtc.on('onRemoteUserEnterRoom', onRemoteEnter)
    trtc.on('onRemoteUserLeaveRoom', onRemoteLeave)
    trtc.on('onUserAudioAvailable', onUserAudioAvailable)

    const start = async () => {
      await trtc.enterRoom(
        {
          sdkAppId,
          userId,
          userSig,
          roomId: 0,
          strRoomId: toTrtcRoomId(gameRoomId),
          // 直播场景（全员主播）：突破"通话场景体验版默认 10 人"上限，12 人局全部可进房互听
          role: TRTCRoleType.TRTCRoleAnchor,
        },
        TRTCAppScene.TRTCAppSceneLIVE,
      )
      if (cancelled) return
      await trtc.startLocalAudio()
      // 进房后按当前权限设置麦克风与远端静音（大厅/结束后走 PTT：默认闭麦，按住说话）
      micOnRef.current =
        permRef.current.canSpeak && phase !== 'waiting' && phase !== 'over'
      setMicOn(micOnRef.current)
      applyLocalMute()
      applyRemoteMutes()
      if (!cancelled) setReady(true)
    }

    start().catch((err) => {
      console.error('[VoiceRoom] TRTC 进房失败:', err)
      if (!cancelled) {
        const msg = err?.message ?? String(err)
        const lower = String(msg).toLowerCase()
        setErrorText(
          String(msg).includes('70009')
            ? `${msg}\n（70009：请重启 server.js 让新密钥生效，并核对控制台 SDKAppID=1600162864 的密钥末6位）`
            : lower.includes('timeout') ||
                lower.includes('join room') ||
                lower.includes('not exist')
              ? `${msg}\n（提示：TRTC 通话房间默认人数上限较低，12 人局第 11/12 位玩家可能被拒导致超时——请在腾讯云 TRTC 控制台调整该应用的人数上限，或确认该玩家网络/是否重复登录同一账号）`
              : msg,
        )
      }
    })

    return () => {
      cancelled = true
      trtc.off('onRemoteUserEnterRoom', onRemoteEnter)
      trtc.off('onRemoteUserLeaveRoom', onRemoteLeave)
      trtc.off('onUserAudioAvailable', onUserAudioAvailable)
      try {
        void trtc.exitRoom()
      } catch {
        /* 忽略退房异常 */
      }
      trtcRef.current = null
    }
  }, [sdkAppId, userId, userSig, gameRoomId, applyLocalMute, applyRemoteMutes])

  // ---- 麦克风交互 UI ----
  const myTurn = isAlive && phase === 'day' && currentSpeaker !== null && currentSpeaker === mySeat
  const waitingTurn = isAlive && phase === 'day' && currentSpeaker !== null && currentSpeaker !== mySeat
  const canInterrupt =
    isAlive &&
    phase === 'day' &&
    isSheriff &&
    !sheriffHasSpokenThisDay &&
    currentSpeaker !== null &&
    currentSpeaker !== mySeat
  const wolfNight = isAlive && phase === 'night' && isWolf
  const goodNight = isAlive && phase === 'night' && !isWolf
  const dead = !isAlive
  const freeMic = phase === 'waiting' || phase === 'over'

  const statusText = freeMic
    ? '🎙 按住说话（按住开麦，松开闭麦）'
    : dead
      ? '💀 死亡频道麦（仅死者可听）'
      : myTurn
        ? '🎤 正在发言（点击结束发言）'
        : waitingTurn
          ? `🎤 等待 ${currentSpeaker} 号发言（已自动闭麦）`
          : wolfNight
            ? '🐺 狼人频道麦（点击说话）'
            : goodNight
              ? '🌙 黑夜请闭眼'
              : '🎤 麦克风待命'

  return (
    <div className="rounded-xl border border-sky-500/30 bg-sky-500/10 px-2.5 py-1 text-xs text-sky-100">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-bold">实时语音：</span>
        <span data-testid="mic-status">{statusText}</span>
        {freeMic ? (
          <button
            type="button"
            data-testid="ptt-press"
            onPointerDown={pttDown}
            onPointerUp={pttUp}
            onPointerLeave={pttUp}
            onPointerCancel={pttUp}
            onContextMenu={(e) => e.preventDefault()}
            disabled={!ready || !perm.canSpeak}
            className="touch-none select-none rounded-md bg-emerald-500/30 px-3 py-0.5 font-bold text-emerald-200 active:bg-emerald-500/60"
          >
            🎙 按住说话
          </button>
        ) : (
          <button
            type="button"
            data-testid="mic-toggle"
            onClick={toggleMic}
            disabled={!ready || !perm.canSpeak}
            className={`rounded-md px-2 py-0.5 font-bold ${
              micOn && perm.canSpeak
                ? 'bg-emerald-500/30 text-emerald-200'
                : 'bg-slate-600/40 text-slate-300'
            }`}
          >
            {micOn && perm.canSpeak ? '🎤 麦克风开' : '🔇 已闭麦'}
          </button>
        )}
        {myTurn && (
          <button
            type="button"
            data-testid="end-speak"
            onClick={onTalkDone}
            className="rounded-md bg-rose-500/30 px-2 py-0.5 font-bold text-rose-200"
          >
            🎤 结束发言
          </button>
        )}
        {canInterrupt && (
          <button
            type="button"
            data-testid="sheriff-interrupt"
            onClick={onSheriffInterrupt}
            className="rounded-md bg-amber-500/30 px-2 py-0.5 font-bold text-amber-200"
          >
            👑 抢先发言
          </button>
        )}
      </div>
        {errorText && (
          <div className="mt-1 opacity-80">
          连接失败：{errorText}
          </div>
        )}
    </div>
  )
}
