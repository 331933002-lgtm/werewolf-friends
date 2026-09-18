import { useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { boards, customBoard } from '../data/boards'

function CreateRoom() {
  const navigate = useNavigate()
  const [nickname, setNickname] = useState('')
  const [playerCount, setPlayerCount] = useState(6)
  const [boardName, setBoardName] = useState(boards[0].name)

  const boardOptions = [...boards, customBoard]

  const handleBoardChange = (name: string) => {
    setBoardName(name)
    const board = boardOptions.find((item) => item.name === name)
    if (board) setPlayerCount(board.playerCount)
  }

  const createRoom = () => {
    if (!nickname.trim()) {
      alert("请先输入你的昵称，再创建房间")
      return
    }
    const code = Math.random().toString(36).slice(2, 8).toUpperCase()
    const board =
      boardOptions.find((item) => item.name === boardName) ?? customBoard
    const query = new URLSearchParams({
      nickname: nickname.trim(),
      players: String(playerCount),
      board: JSON.stringify(board),
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

        <h1 className="text-3xl font-bold">创建房间</h1>
        <p className="mt-2 text-sm text-slate-400">
          选择板子和人数，即可生成房间码
        </p>

        <div className="mt-10 flex flex-col gap-6">
          <label className="flex flex-col gap-2">
            <span className="text-sm font-medium text-slate-300">选择板子</span>
            <select
              value={boardName}
              onChange={(event) => handleBoardChange(event.target.value)}
              className="w-full rounded-xl border border-slate-700 bg-slate-900 px-4 py-3 text-base text-slate-100 outline-none transition focus:border-amber-500"
            >
              {boardOptions.map((board) => (
                <option key={board.name} value={board.name}>
                  {board.name}
                </option>
              ))}
            </select>
          </label>

          <label className="flex flex-col gap-2">
            <span className="text-sm font-medium text-slate-300">我的昵称 <span className="text-rose-400">*必填</span></span>
            <input
              type="text"
              value={nickname}
              onChange={(event) => setNickname(event.target.value)}
              maxLength={6}
              placeholder="必填：请输入昵称（最多6个字）"
              className="w-full rounded-xl border border-slate-700 bg-slate-900 px-4 py-3 text-base text-slate-100 placeholder-slate-500 outline-none transition focus:border-amber-500"
            />
            <span className="text-xs text-rose-400">必须填写昵称，否则无法创建房间</span>
          </label>

          <label className="flex flex-col gap-2">
            <span className="text-sm font-medium text-slate-300">玩家人数</span>
            <select
              value={playerCount}
              onChange={(event) => setPlayerCount(Number(event.target.value))}
              className="w-full rounded-xl border border-slate-700 bg-slate-900 px-4 py-3 text-base text-slate-100 outline-none transition focus:border-amber-500"
            >
              {[5, 6, 7, 8, 9, 10, 11, 12].map((count) => (
                <option key={count} value={count}>
                  {count} 人局
                </option>
              ))}
            </select>
          </label>

          <button
            type="button"
            onClick={createRoom}
            disabled={!nickname.trim()}
            className="mt-2 w-full rounded-2xl bg-amber-500 py-4 text-lg font-bold text-slate-950 shadow-lg shadow-amber-500/30 transition active:scale-95 disabled:cursor-not-allowed disabled:opacity-40 disabled:shadow-none"
          >
            创建房间
          </button>
        </div>
      </div>
    </div>
  )
}

export default CreateRoom
