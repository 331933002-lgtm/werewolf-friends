import { useNavigate } from 'react-router-dom'

function Home() {
  const navigate = useNavigate()

  const buttons = [
    {
      label: '创建房间',
      path: '/create',
      className:
        'bg-amber-500 text-slate-950 shadow-amber-500/30 active:scale-95',
    },
    {
      label: '加入房间',
      path: '/join',
      className:
        'bg-emerald-500 text-slate-950 shadow-emerald-500/30 active:scale-95',
    },
    {
      label: '测试环境',
      path: '/room/demo',
      className: 'bg-slate-700 text-slate-100 shadow-slate-900/40 active:scale-95',
    },
  ]

  return (
    <div className="relative mx-auto flex min-h-dvh w-full max-w-[480px] flex-col items-center justify-center overflow-hidden px-6 text-slate-100">
      {/* 背景：水墨狼头插画 + 半透明遮罩保证文字可读（路径基于 Vite BASE_URL，兼容子路径部署） */}
      <div
        className="absolute inset-0 bg-cover bg-center"
        style={{ backgroundImage: `url(${import.meta.env.BASE_URL}bg-home.jpg)` }}
      />
      <div className="absolute inset-0 bg-slate-950/55" />

      <header className="relative z-10 mb-14 text-center">
        <h1 className="text-4xl font-black tracking-wide text-white drop-shadow-[0_2px_10px_rgba(0,0,0,0.95)]">
          901线上狼人杀
        </h1>
        <p className="mt-4 text-sm text-slate-200 drop-shadow-[0_1px_6px_rgba(0,0,0,0.95)]">
          天黑请闭眼，和朋友一起开局
        </p>
      </header>

      <nav className="relative z-10 flex w-full max-w-sm flex-col gap-5">
        {buttons.map((button) => (
          <button
            key={button.label}
            type="button"
            onClick={() => navigate(button.path)}
            className={`w-full rounded-2xl py-5 text-xl font-bold shadow-lg transition active:scale-95 ${button.className}`}
          >
            {button.label}
          </button>
        ))}
      </nav>
    </div>
  )
}

export default Home
