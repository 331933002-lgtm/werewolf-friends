export type Camp = 'wolf' | 'good' | 'third'

export interface BoardRole {
  key: string
  name: string
  count: number
  camp: Camp
}

export interface Board {
  name: string
  playerCount: number
  roles: BoardRole[]
  nightOrder: string[]
}

/** 预置板子列表 */
export const boards: Board[] = [
  {
    name: '12人丘比特奇缘',
    playerCount: 12,
    roles: [
      { key: 'nightmare', name: '噩梦之影', count: 1, camp: 'wolf' },
      { key: 'wolf_queen', name: '蚀时狼妃', count: 1, camp: 'wolf' },
      { key: 'wolf_witch', name: '狼巫', count: 1, camp: 'wolf' },
      { key: 'wolf_king', name: '狼王', count: 1, camp: 'wolf' },
      { key: 'seer', name: '预言家', count: 1, camp: 'good' },
      { key: 'witch', name: '女巫', count: 1, camp: 'good' },
      { key: 'hunter', name: '猎人', count: 1, camp: 'good' },
      { key: 'dream_weaver', name: '摄梦人', count: 1, camp: 'good' },
      { key: 'raven', name: '乌鸦', count: 1, camp: 'good' },
      { key: 'cursed_fox', name: '咒狐', count: 1, camp: 'third' },
      { key: 'cupid', name: '丘比特', count: 1, camp: 'third' },
      { key: 'lonely_girl', name: '觉醒孤独少女', count: 1, camp: 'third' },
    ],
    nightOrder: [
      'lonely_girl',
      'cupid',
      'lovers',
      'nightmare',
      'dream_weaver',
      'wolf_queen',
      'werewolf',
      'witch',
      'seer',
      'raven',
      'hunter',
      'demon_hunter',
      'wolf_king',
      'cursed_fox',
      'wolf_witch',
    ],
  },
]

/** 自定义板子（占位，角色配置功能待开发） */
export const customBoard: Board = {
  name: '自定义板子',
  playerCount: 12,
  roles: [],
  nightOrder: [],
}
