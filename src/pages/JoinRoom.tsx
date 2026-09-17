import { useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'

function JoinRoom() {
  const navigate = useNavigate()
  const [roomCode, setRoomCode] = useState('')
  const [nickname, setNickname] = useState('')

  const joinRoom = () => {
    const code = roomCode.trim().toUpperCase()
    if (!code) return
    const query = new URLSearchParams({
      nickname: nickname.trim() || '玩家',
    })
    navigate(`/room/${code}?${query.toString()}`)
  }

  return (
    <div className="flex min-h-dvh w-full flex-col bg-slate-950 px-6 py-10 text-slate-100">
      <div className="mx-auto w-full max-w-sm">
        <Link
          to="/"
          className="mb-8 inline-block text-sm text-slate-400 transition hover:text-slate-200"
        >
          ← 返回首页
        </Link>

        <h1 className="text-3xl font-bold">加入房间</h1>
        <p className="mt-2 text-sm text-slate-400">
          输入好友分享的房间码，快速加入
        </p>

        <div className="mt-10 flex flex-col gap-6">
          <label className="flex flex-col gap-2">
            <span className="text-sm font-medium text-slate-300">房间码</span>
            <input
              type="text"
              value={roomCode}
              onChange={(event) => setRoomCode(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') joinRoom()
              }}
              maxLength={6}
              placeholder="例如：A1B2C3"
              className="w-full rounded-xl border border-slate-700 bg-slate-900 px-4 py-3 text-base tracking-[0.3em] text-slate-100 placeholder-slate-500 outline-none transition focus:border-emerald-500"
            />
          </label>

          <label className="flex flex-col gap-2">
            <span className="text-sm font-medium text-slate-300">我的昵称</span>
            <input
              type="text"
              value={nickname}
              onChange={(event) => setNickname(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') joinRoom()
              }}
              maxLength={6}
              placeholder="请输入昵称（最多6个字）"
              className="w-full rounded-xl border border-slate-700 bg-slate-900 px-4 py-3 text-base text-slate-100 placeholder-slate-500 outline-none transition focus:border-emerald-500"
            />
          </label>

          <button
            type="button"
            onClick={joinRoom}
            disabled={!roomCode.trim()}
            className="mt-2 w-full rounded-2xl bg-emerald-500 py-4 text-lg font-bold text-slate-950 shadow-lg shadow-emerald-500/30 transition active:scale-95 disabled:cursor-not-allowed disabled:opacity-40 disabled:active:scale-100"
          >
            加入房间
          </button>
        </div>
      </div>
    </div>
  )
}

export default JoinRoom
