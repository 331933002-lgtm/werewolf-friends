import { BrowserRouter, Route, Routes } from 'react-router-dom'
import Home from './pages/Home'
import CreateRoom from './pages/CreateRoom'
import JoinRoom from './pages/JoinRoom'
import Room from './pages/Room'

function App() {
  return (
    <div className="mx-auto flex min-h-screen w-full max-w-[480px] flex-col bg-slate-950 text-slate-100 shadow-2xl">
      <BrowserRouter>
        <Routes>
          <Route path="/" element={<Home />} />
          <Route path="/create" element={<CreateRoom />} />
          <Route path="/join" element={<JoinRoom />} />
          <Route path="/room/:roomId" element={<Room />} />
        </Routes>
      </BrowserRouter>
    </div>
  )
}

export default App
