import tlsSigPkg from 'tls-sig-api-v2';
const TLSSigAPIv2 = tlsSigPkg.Api;
let nextConnId = 1;
/** 给 ws 连接打上稳定的连接 id（ws 无内置 id，PartyKit 有 conn.id） */
function tagConnection(ws) {
    const conn = ws;
    if (!conn.id)
        conn.id = `conn-${nextConnId++}`;
    return conn;
}
/** 整个黑夜统一 60 秒（所有玩家看到的倒计时完全一样，杜绝通过时长猜身份） */
export const TRTC_SDK_APP_ID = 1600162864;
export const TRTC_SDK_SECRET_KEY = '25ee18743d1a545c71e279c48dbf836fc245295c8bb5f1516e043832bb2f8134';
const TRTC_USER_SIG_EXPIRE = 60 * 60 * 8;
/** 腾讯云官方 tls-sig-api-v2 生成 UserSig（内部 deflate 压缩 + base64url 外层编码，TLS.sig 为 HMAC-SHA256 的 Base64） */
const TRTC_SIG_API = new TLSSigAPIv2(TRTC_SDK_APP_ID, TRTC_SDK_SECRET_KEY);
function createTrtcUserSig(userID) {
    return TRTC_SIG_API.genUserSig(userID, TRTC_USER_SIG_EXPIRE);
}
const NIGHT_STEP_MS = Number(process.env.NIGHT_STEP_MS) || 60_000;
const NIGHT_TOTAL_MS = Number(process.env.NIGHT_TOTAL_MS) || 300_000;
/** 白天发言阶段统一时长（结束后自动开始投票） */
const TALK_MS = Number(process.env.TALK_MS) || 90_000;
/** 白天投票阶段统一时长（到点强制计票；全部存活玩家投完则提前结算） */
const VOTE_MS = Number(process.env.VOTE_MS) || 60_000;
/** 遗言阶段统一时长（规范：70 秒；倒计时由服务端时间戳统一下发） */
const LAST_WORDS_MS = Number(process.env.LAST_WORDS_MS) || 70_000;
/** 警长竞选：上警/警下投票/选发言方向/移交警徽 各阶段倒计时 */
const SHERIFF_APPLY_MS = Number(process.env.SHERIFF_APPLY_MS) || 30_000;
const SHERIFF_VOTE_MS = Number(process.env.SHERIFF_VOTE_MS) || 30_000;
const SHERIFF_ORDER_MS = Number(process.env.SHERIFF_ORDER_MS) || 30_000;
const SHERIFF_DEATH_MS = Number(process.env.SHERIFF_DEATH_MS) || 30_000;
/** 警长可选发言方向 */
const SHERIFF_DIRS = ['dead_left', 'dead_right', 'sheriff_left', 'sheriff_right'];
/**
 * 夜晚行动阶段：服务端按顺序依次开放对应角色玩家的面板；
 * 角色不在场的阶段自动跳过；所有阶段提前完成时立即天亮。
 */
/** 夜晚行动顺序：觉醒孤独少女 -> 丘比特 -> 噩梦之影 -> 摄梦人 -> 蚀时狼妃 -> 狼人 -> 女巫 -> 预言家 -> 乌鸦 -> 猎魔人 -> 狼巫
 *  孤独少女/丘比特仅首夜参与；猎魔人从第二晚起才参与（advanceNightStep 内跳过）；
 *  蚀时狼妃技能生效后下一晚起不再出现该阶段。
 *  requiredAction：通知前端渲染对应操作面板的指令键（随带 roleKey 的私发帧单播给行动者）。 */
const NIGHT_PHASE_ORDER = [
    { roleKey: 'lonely_girl', label: '觉醒孤独少女', requiredAction: 'lonely_girl_idol' },
    { roleKey: 'cupid', label: '丘比特', requiredAction: 'cupid_link' },
    { roleKey: 'nightmare', label: '噩梦之影', requiredAction: 'nightmare_fear' },
    { roleKey: 'dream_weaver', label: '摄梦人', requiredAction: 'dream_weaver_visit' },
    { roleKey: 'wolf_queen', label: '蚀时狼妃', requiredAction: 'wolf_queen_block' },
    { roleKey: 'wolf', label: '狼人', requiredAction: 'wolf_vote' },
    { roleKey: 'witch', label: '女巫', requiredAction: 'witch_action' },
    { roleKey: 'seer', label: '预言家', requiredAction: 'seer_check' },
    { roleKey: 'raven', label: '乌鸦', requiredAction: 'raven_curse' },
    { roleKey: 'demon_hunter', label: '猎魔人', requiredAction: 'demon_hunter_hunt' },
    { roleKey: 'wolf_witch', label: '狼巫', requiredAction: 'wolf_witch_check' },
];
/** Fisher-Yates 洗牌 */
function shuffle(arr) {
    const a = [...arr];
    for (let i = a.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        const tmp = a[i];
        a[i] = a[j];
        a[j] = tmp;
    }
    return a;
}
function createEmptyGameState() {
    return {
        phase: 'lobby',
        boardName: '',
        playerCount: 0,
        seats: [],
        nightDeadline: null,
        nightStepIndex: -1,
        currentPhase: null,
        wolfTarget: null,
        witchSave: false,
        witchPoison: null,
        witchSaved: false,
        witchPoisoned: false,
        deaths: [],
        dayIndex: 1,
        dayStage: null,
        talkDeadline: null,
        voteDeadline: null,
        exiledSeat: null,
        gunSourceSeat: null,
        deadSeats: [],
        speakerOrder: [],
        speakerIndex: 0,
        speakerDeadline: null,
        sheriffSeat: null,
        sheriffCandidates: [],
        sheriffVotes: new Map(),
        sheriffOrderDir: null,
        sheriffElectionDone: false,
        sheriffApplyDeadline: null,
        sheriffVoteDeadline: null,
        nightmareTarget: null,
        nightmarePrevTarget: null,
        wolfQueenTarget: null,
        wolfQueenPrevTarget: null,
        wolfQueenTriggered: false,
        wolfQueenUsed: false,
        dreamPrevTarget: null,
        demonHunterTarget: null,
        demonHunterPrevTarget: null,
        ravenPrevTarget: null,
        ravenTarget: null,
        wolfWitchCheck: null,
        deathCauses: {},
        wolfKilledHunter: null,
        gunNightKill: false,
        cupidTargets: null,
        lonelyIdol: null,
        lonelyConverted: false,
        foxDreamFirstUsed: false,
        winner: null,
        voicePerm: {},
        sheriffHasSpokenThisDay: false,
        sheriffInterruptSeat: null,
        voteHistory: [],
    };
}
function createEmptyRoomState() {
    return {
        players: new Map(),
        connToPlayer: new Map(),
        playerConns: new Map(),
        conns: new Map(),
        hostPlayerId: null,
        gameState: createEmptyGameState(),
        wolfVotes: new Map(),
        wolfChat: [],
        nightTimer: null,
        seerTarget: null,
        dreamTarget: null,
        witchChoice: null,
        dayVotes: new Map(),
        sheriffApplied: new Set(),
        sheriffAfterFn: null,
        dayActionTimer: null,
    };
}
/**
 * 通用 Node.js WebSocket 房间服务。注意：同一实例的所有房间共享同一个类实例，
 * 所以状态必须按房间 id 分桶，并自己维护连接归属。
 *
 * 第二阶段·第二步：夜间私密行动面板 + 全局统一倒计时。
 * - 夜晚开始：服务端记录统一 nightDeadline（90 秒），全屋玩家看到同一个倒计时。
 * - 服务端按 NIGHT_PHASE_ORDER 依次开放对应角色玩家面板，角色不在场自动跳过。
 * - 狼人沟通/投票只广播给狼人玩家；平民全程只看到"天黑请闭眼"。
 * - 所有阶段提前完成 -> 立即天亮（跳过剩余倒计时）。
 */
export default class GameServer {
    /** roomId -> 房间状态（隔离房间数据） */
    rooms = new Map();
    /** 连接 id -> 房间 id（实例共享，必须自己记住每个连接属于哪个房间） */
    connRoom = new Map();
    /** 从请求 URL 中解析房间 id：/party/<partyName>/<roomId> */
    resolveRoomId(conn, req) {
        try {
            const url = new URL(req?.url ?? '/', 'http://localhost');
            const parts = url.pathname.split('/').filter(Boolean);
            const roomId = parts[parts.length - 1];
            if (roomId) {
                this.connRoom.set(conn.id, roomId);
                return roomId;
            }
        }
        catch {
            // 解析失败时回退
        }
        const fallback = this.connRoom.get(conn.id);
        if (fallback)
            return fallback;
        return 'default';
    }
    getRoom(roomId) {
        let room = this.rooms.get(roomId);
        if (!room) {
            room = createEmptyRoomState();
            this.rooms.set(roomId, room);
        }
        return room;
    }
    /** 新 WebSocket 连接进入（由 server.js 在 ws 'connection' 时调用） */
    handleConnection(ws, req) {
        const conn = tagConnection(ws);
        const roomId = this.resolveRoomId(conn, req);
        const room = this.getRoom(roomId);
        room.conns.set(conn.id, conn);
        // 新连接先收到当前房间的玩家列表快照
        conn.send(JSON.stringify({
            type: 'roster',
            players: this.snapshot(room),
            hostPlayerId: room.hostPlayerId,
        }));
        // 游戏已开始时补发座位快照（不含身份），刷新页面可恢复
        if (room.gameState.phase !== 'lobby') {
            conn.send(JSON.stringify(this.publicGameStartedMessage(room)));
        }
        // 夜晚进行中：补发倒计时与当前阶段；白天：按当前白天子阶段补发状态
        if (room.gameState.phase === 'night') {
            conn.send(JSON.stringify({
                type: 'nightStarted',
                nightDeadline: room.gameState.nightDeadline,
                nightIndex: room.gameState.dayIndex,
            }));
            this.sendNightPhaseToConn(room, conn);
        }
        else if (room.gameState.phase === 'day') {
            // 先补发当前警长状态（👑 标记）
            conn.send(JSON.stringify({
                type: 'sheriffChanged',
                seat: room.gameState.sheriffSeat,
            }));
            const gs = room.gameState;
            const stage = gs.dayStage ?? 'talk';
            if (stage === 'sheriffApply' ||
                stage === 'sheriffTalk' ||
                stage === 'sheriffVote' ||
                stage === 'sheriffOrder' ||
                stage === 'sheriffDeath') {
                // 竞选/警徽子阶段：补发子阶段状态
                conn.send(JSON.stringify({
                    type: 'sheriffStage',
                    stage,
                    candidates: gs.sheriffCandidates,
                    deadline: stage === 'sheriffApply'
                        ? gs.sheriffApplyDeadline
                        : stage === 'sheriffVote'
                            ? gs.sheriffVoteDeadline
                            : null,
                    aliveSeats: stage === 'sheriffDeath'
                        ? this.aliveSeats(room).filter((s) => s !== gs.sheriffSeat)
                        : this.aliveSeats(room),
                    sheriffSeat: gs.sheriffSeat,
                }));
                if (stage === 'sheriffTalk') {
                    conn.send(JSON.stringify({
                        type: 'speakerChanged',
                        currentSpeaker: gs.speakerOrder[gs.speakerIndex] ?? null,
                        speakerOrder: gs.speakerOrder,
                        speakerIndex: gs.speakerIndex,
                        speakerDeadline: gs.speakerDeadline,
                    }));
                }
                if (stage === 'sheriffOrder') {
                    const sheriff = gs.seats.find((s) => s.seat === gs.sheriffSeat);
                    const playerId = room.connToPlayer.get(conn.id);
                    if (sheriff && playerId === sheriff.playerId) {
                        conn.send(JSON.stringify({ type: 'sheriffOrderPanel', options: [...SHERIFF_DIRS] }));
                    }
                }
                if (stage === 'sheriffDeath') {
                    const sheriff = gs.seats.find((s) => s.seat === gs.sheriffSeat);
                    const playerId = room.connToPlayer.get(conn.id);
                    if (sheriff && playerId === sheriff.playerId) {
                        conn.send(JSON.stringify({
                            type: 'sheriffGiveawayPanel',
                            aliveSeats: this.aliveSeats(room).filter((s) => s !== gs.sheriffSeat),
                        }));
                    }
                }
            }
            else {
                conn.send(JSON.stringify({
                    type: 'dayStarted',
                    dayIndex: room.gameState.dayIndex,
                    dayStage: room.gameState.dayStage ?? 'talk',
                    deaths: room.gameState.deaths,
                    deadSeats: room.gameState.deadSeats,
                    currentSpeaker: room.gameState.dayStage === 'talk'
                        ? room.gameState.sheriffInterruptSeat ??
                            room.gameState.speakerOrder[room.gameState.speakerIndex] ??
                            null
                        : null,
                    speakerOrder: room.gameState.speakerOrder,
                    speakerDeadline: room.gameState.dayStage === 'talk'
                        ? room.gameState.speakerDeadline
                        : null,
                    talkDeadline: room.gameState.speakerDeadline,
                    voteDeadline: room.gameState.voteDeadline,
                    sheriffSeat: room.gameState.sheriffSeat,
                    sheriffHasSpokenThisDay: room.gameState.sheriffHasSpokenThisDay,
                }));
            }
            // 开枪阶段：给被放逐者本人补发开枪面板
            if (room.gameState.dayStage === 'gun' &&
                room.gameState.gunSourceSeat !== null) {
                const exiled = room.gameState.seats.find((s) => s.seat === room.gameState.gunSourceSeat);
                if (exiled) {
                    this.sendToPlayer(room, exiled.playerId, {
                        type: 'gunPanel',
                        seat: exiled.seat,
                        canGun: true,
                        roleName: exiled.roleName,
                        shooterName: exiled.nickname,
                    });
                }
            }
        }
    }
    /** 收到 WebSocket 消息（由 server.js 在 ws 'message' 时调用） */
    handleMessage(ws, message) {
        const sender = tagConnection(ws);
        let msg;
        try {
            msg = JSON.parse(String(message));
        }
        catch {
            return;
        }
        const roomId = this.connRoom.get(sender.id) ?? 'default';
        const room = this.getRoom(roomId);
        switch (msg.type) {
            case 'join':
                this.handleJoin(room, msg, sender);
                break;
            case 'ready':
                this.handleReady(room, msg);
                break;
            case 'start':
                this.handleStart(room, msg, sender);
                break;
            case 'getRole':
                this.handleGetRole(room, msg, sender);
                break;
            case 'startNight':
                this.handleStartNight(room, msg, sender);
                break;
            case 'wolfChat':
                this.handleWolfChat(room, msg);
                break;
            case 'wolfVote':
                this.handleWolfVote(room, msg);
                break;
            case 'nightTarget':
                this.handleNightTarget(room, msg, sender);
                break;
            case 'cupidAction':
                this.handleCupidAction(room, msg, sender);
                break;
            case 'witchAction':
                this.handleWitchAction(room, msg, sender);
                break;
            case 'dayVote':
                this.handleDayVote(room, msg, sender);
                break;
            case 'talkDone':
                this.handleTalkDone(room, msg, sender);
                break;
            case 'sheriffApply':
                this.handleSheriffApply(room, msg);
                break;
            case 'sheriffWithdraw':
                this.handleSheriffWithdraw(room, msg);
                break;
            case 'sheriffVote':
                this.handleSheriffVote(room, msg);
                break;
            case 'sheriffOrder':
                this.handleSheriffOrder(room, msg);
                break;
            case 'sheriffGiveaway':
                this.handleSheriffGiveaway(room, msg);
                break;
            case 'gunTarget':
                this.handleGunTarget(room, msg, sender);
                break;
            case 'sheriffInterrupt':
                this.handleSheriffInterrupt(room, msg, sender);
                break;
            case 'changeSeat':
                this.handleChangeSeat(room, msg, sender);
                break;
            case 'skipTalk':
                if (msg.playerId !== room.hostPlayerId) {
                    sender.send(JSON.stringify({ type: 'error', message: '只有房主可以跳过发言' }));
                    break;
                }
                if (room.gameState.phase === 'day' && room.gameState.dayStage === 'talk') {
                    this.startVote(room);
                }
                break;
        }
    }
    /** 连接关闭（由 server.js 在 ws 'close' 时调用） */
    handleClose(ws) {
        const conn = tagConnection(ws);
        const roomId = this.connRoom.get(conn.id) ?? 'default';
        const room = this.getRoom(roomId);
        const playerId = room.connToPlayer.get(conn.id);
        room.conns.delete(conn.id);
        if (playerId) {
            room.players.delete(playerId);
            room.connToPlayer.delete(conn.id);
            if (room.playerConns.get(playerId) === conn.id) {
                room.playerConns.delete(playerId);
            }
            // 房主离开后，把房主身份转移给房间内最早加入的玩家
            if (room.hostPlayerId === playerId) {
                const first = [...room.players.keys()][0];
                room.hostPlayerId = first ?? null;
            }
            this.broadcastRoster(room);
            this.updateLobbyVoicePerms(room);
        }
        this.connRoom.delete(conn.id);
    }
    // ---- 大厅 ----
    handleJoin(room, msg, sender) {
        const nickname = msg.nickname?.trim() || '玩家';
        const existing = room.players.get(msg.playerId);
        // 入座即分配座位号（1..12 最小空位）；重进沿用原座位；发牌时座位不再变化
        const isSpectator = !!msg.spectator;
        const seat = isSpectator ? null : (existing?.seat ?? this.nextFreeSeat(room));
        const avatarIdx = isSpectator ? null : (existing?.avatarIdx ?? this.nextFreeAvatar(room));
        room.players.set(msg.playerId, { nickname, ready: existing?.ready ?? false, seat, avatarIdx, isSpectator });
        room.connToPlayer.set(sender.id, msg.playerId);
        room.playerConns.set(msg.playerId, sender.id);
        if (room.hostPlayerId === null) {
            room.hostPlayerId = msg.playerId;
        }
        this.broadcastRoster(room);
        // 大厅语音凭证：进房即可进入 TRTC 房间（前端 PTT 按住说话；开局后以 role 帧的 userSig 为准）
        this.sendToPlayer(room, msg.playerId, {
            type: 'trtcCredential',
            trtc: { sdkAppId: TRTC_SDK_APP_ID, userSig: createTrtcUserSig(msg.playerId) },
            voicePerm: isSpectator
                ? { canSpeak: false, canHearWolves: false, isDeadChannel: true, hearUserIds: [] }
                : { canSpeak: true, canHearWolves: false, isDeadChannel: false, hearUserIds: [] },
        });
        this.updateLobbyVoicePerms(room);
    }
    /** 大厅自由麦（前端 PTT 按住说话）：全员可说话，互听其他所有玩家（含新入座/换座/离场后动态更新） */
    updateLobbyVoicePerms(room) {
        if (room.gameState.phase !== 'lobby')
            return;
        const list = [...room.players.values()];
        for (const info of list) {
            this.sendToPlayer(room, info.playerId, {
                type: 'voicePerm',
                phase: 'lobby',
                dayStage: null,
                currentPhase: null,
                currentSpeaker: null,
                canSpeak: true,
                canHearWolves: false,
                isDeadChannel: false,
                hearUserIds: list.filter((x) => x.playerId !== info.playerId).map((x) => x.playerId),
            });
        }
    }
    /** 换座：仅大厅阶段，目标座位必须为空；换座后头像跟随玩家（前端本地迁移），ready 保持不变 */
    handleChangeSeat(room, msg, sender) {
        if (room.gameState.phase !== 'lobby')
            return;
        const player = room.players.get(msg.playerId);
        if (!player)
            return;
        const target = Number(msg.seat);
        if (!Number.isInteger(target) || target < 1 || target > 12 || target === player.seat)
            return;
        const occupied = new Set();
        for (const info of room.players.values()) {
            if (info.playerId !== msg.playerId && info.seat != null)
                occupied.add(info.seat);
        }
        if (occupied.has(target))
            return;
        player.seat = target;
        this.broadcastRoster(room);
        this.updateLobbyVoicePerms(room);
    }
    /** 分配下一个空座位号（1..12 最小空位；超出后按占用数+1） */
    nextFreeSeat(room) {
        const occupied = new Set();
        for (const info of room.players.values()) {
            if (info.seat != null)
                occupied.add(info.seat);
        }
        for (let seat = 1; seat <= 12; seat++) {
            if (!occupied.has(seat))
                return seat;
        }
        return occupied.size + 1;
    }
    /** 分配房间内未使用的头像索引（1..12，保证同房间不重复；池子耗尽后随机兜底） */
    nextFreeAvatar(room) {
        const used = new Set();
        for (const info of room.players.values()) {
            if (info.avatarIdx != null)
                used.add(info.avatarIdx);
        }
        const free = [];
        for (let i = 1; i <= 12; i++) {
            if (!used.has(i))
                free.push(i);
        }
        if (free.length === 0)
            return 1 + Math.floor(Math.random() * 12);
        return free[Math.floor(Math.random() * free.length)];
    }
    handleReady(room, msg) {
        const player = room.players.get(msg.playerId);
        if (player) {
            player.ready = msg.ready;
            this.broadcastRoster(room);
        }
    }
    // ---- 发牌 ----
    handleStart(room, msg, sender) {
        if (msg.playerId !== room.hostPlayerId) {
            sender.send(JSON.stringify({ type: 'error', message: '只有房主可以开始游戏' }));
            return;
        }
        if (room.gameState.phase !== 'lobby') {
            sender.send(JSON.stringify({
                type: 'error',
                message: '游戏已经开始，请刷新页面查看状态',
            }));
            return;
        }
        const board = msg.board;
        if (!board || !Array.isArray(board.roles) || board.roles.length === 0) {
            sender.send(JSON.stringify({ type: 'error', message: '板子数据无效，请重新创建房间' }));
            return;
        }
        // 展开角色牌堆（count 表示该角色几张牌）
        const deck = [];
        for (const role of board.roles) {
            for (let i = 0; i < role.count; i++) {
                deck.push({ key: role.key, name: role.name, camp: role.camp ?? 'good' });
            }
        }
        const playerList = [...room.players.entries()].filter(([, info]) => info.seat != null);
        if (playerList.length === 0) {
            sender.send(JSON.stringify({ type: 'error', message: '房间里还没有玩家' }));
            return;
        }
        if (playerList.length > deck.length) {
            sender.send(JSON.stringify({
                type: 'error',
                message: `玩家数量（${playerList.length}）超过角色数量（${deck.length}），请先加入对应人数的玩家`,
            }));
            return;
        }
        // 人数校验：开发者模式允许 3~牌池上限 人开局；正式局必须恰好等于板子人数
        const devMode = Boolean(msg.devMode);
        const needCount = board.playerCount ?? deck.length;
        if (devMode) {
            if (playerList.length < 3 || playerList.length > deck.length) {
                sender.send(JSON.stringify({
                    type: 'error',
                    message: `开发者模式需要 3~${deck.length} 名玩家，当前 ${playerList.length} 名`,
                }));
                return;
            }
        }
        else if (playerList.length !== needCount) {
            sender.send(JSON.stringify({
                type: 'error',
                message: `人数不足/超额：本板子需要 ${needCount} 名玩家，当前 ${playerList.length} 名，请等待玩家加入`,
            }));
            return;
        }
        // 所有非房主玩家必须已准备（服务端强校验，防止前端绕过）
        const notReady = playerList.filter(([pid, info]) => pid !== room.hostPlayerId && !info.ready);
        if (notReady.length > 0) {
            sender.send(JSON.stringify({
                type: 'error',
                message: '有玩家还未准备，无法开始游戏',
            }));
            return;
        }
        // 洗牌并按加入顺序发牌：座位 1..N
        // 房主指定了测试身份 -> 按指定分配
        // 开发者模式 -> 从完整角色池纯随机抽 n 张（不补普通村民、不做 1 狼 1 好人保底，允许任意组合如 2 狼 1 神）
        // 正式局 -> 走保底随机（n < 牌池时至少 1 狼 1 好人）
        const assignments = msg.assignments ?? [];
        const actualCount = playerList.length;
        let shuffled;
        if (assignments.length > 0) {
            const built = this.buildDeckWithAssignments(deck, playerList, assignments);
            if (!built) {
                sender.send(JSON.stringify({
                    type: 'error',
                    message: '指定身份无效：角色不存在、角色重复或玩家不在房间内',
                }));
                return;
            }
            shuffled = built;
        }
        else if (devMode) {
            shuffled = shuffle(deck).slice(0, actualCount);
        }
        else {
            shuffled = this.buildDeck(deck, actualCount);
        }
        // 记录本局板子配置（游戏结束后"重新开始一局"需要按此重新发牌，不依赖前端重发板子）
        room.boardConfig = {
            name: board.name ?? '未知板子',
            playerCount: devMode ? actualCount : needCount,
            roles: board.roles,
            devMode,
        };
        room.gameState = {
            ...createEmptyGameState(),
            boardName: board.name ?? '未知板子',
            playerCount: devMode ? actualCount : needCount,
            seats: playerList.map(([playerId, info], index) => ({
                seat: info.seat ?? index + 1,
                playerId,
                nickname: info.nickname,
                roleKey: shuffled[index].key,
                roleName: shuffled[index].name,
                camp: shuffled[index].camp,
            })),
        };
        this.updateVoicePermissions(room);
        this.broadcastGameStarted(room);
        // 流程串联：发牌完毕自动进入第一夜（房主无需再点"天黑了"）
        this.beginNight(room);
    }
    /** 从牌堆中抽取 n 张发牌；n < 总牌数时保底 1 狼 + 1 好人（若板子两类都有），避免出现"全是好人"或"全是狼"的测试死角 */
    buildDeck(deck, n) {
        if (n >= deck.length)
            return shuffle(deck);
        const wolves = deck.filter((d) => d.camp === 'wolf');
        const others = deck.filter((d) => d.camp !== 'wolf');
        if (wolves.length === 0 || n <= 0) {
            return shuffle(others).slice(0, n);
        }
        const wolfIdx = Math.floor(Math.random() * wolves.length);
        const pickedWolf = wolves[wolfIdx];
        const restWolf = [...wolves.slice(0, wolfIdx), ...wolves.slice(wolfIdx + 1)];
        if (n >= 2 && others.length > 0) {
            const goodIdx = Math.floor(Math.random() * others.length);
            const pickedGood = others[goodIdx];
            const rest = shuffle([
                ...restWolf,
                ...others.slice(0, goodIdx),
                ...others.slice(goodIdx + 1),
            ]);
            return shuffle([pickedWolf, pickedGood, ...rest.slice(0, n - 2)]);
        }
        const rest = shuffle([...restWolf, ...others]);
        return shuffle([pickedWolf, ...rest.slice(0, n - 1)]);
    }
    /**
     * 按房主指定分配测试身份，返回按 playerList 顺序排列的角色数组；
     * 校验失败（角色不存在/重复/玩家不存在/牌不够）返回 null。
     */
    buildDeckWithAssignments(deck, playerList, assignments) {
        const playerIds = new Set(playerList.map(([id]) => id));
        const deckKeys = new Set(deck.map((d) => d.key));
        const used = new Set();
        for (const a of assignments) {
            if (!playerIds.has(a.playerId))
                return null;
            if (!deckKeys.has(a.roleKey))
                return null;
            if (used.has(a.roleKey))
                return null;
            used.add(a.roleKey);
        }
        // 从牌堆取出指定角色
        const remaining = [...deck];
        const assigned = new Map();
        for (const a of assignments) {
            const idx = remaining.findIndex((d) => d.key === a.roleKey);
            if (idx === -1)
                return null;
            assigned.set(a.playerId, remaining.splice(idx, 1)[0]);
        }
        const shuffledRest = shuffle(remaining);
        const result = [];
        for (const [playerId] of playerList) {
            const role = assigned.get(playerId);
            if (role) {
                result.push(role);
            }
            else {
                const next = shuffledRest.shift();
                if (!next)
                    return null;
                result.push(next);
            }
        }
        return result;
    }
    // ---- 私密查看身份 ----
    async handleGetRole(room, msg, sender) {
        const seat = room.gameState.seats.find((s) => s.playerId === msg.playerId);
        if (!seat) {
            sender.send(JSON.stringify({ type: 'error', message: '游戏未开始或你不是本局玩家' }));
            return;
        }
        const userSig = await createTrtcUserSig(msg.playerId);
        const perm = this.computeVoicePerm(room, seat);
        room.gameState.voicePerm[msg.playerId] = perm;
        sender.send(JSON.stringify({
            type: 'role',
            seat: seat.seat,
            roleKey: seat.roleKey,
            roleName: seat.roleName,
            camp: seat.camp,
            trtc: { sdkAppId: TRTC_SDK_APP_ID, userSig },
            voicePerm: perm,
            // ---- 刷新后恢复当前阶段快照（否则前端丢失"结束发言"等交互状态） ----
            phase: room.gameState.phase,
            dayStage: room.gameState.dayStage ?? null,
            currentSpeaker: room.gameState.phase === 'day' && room.gameState.dayStage === 'talk'
                ? (room.gameState.sheriffInterruptSeat ?? room.gameState.speakerOrder?.[room.gameState.speakerIndex] ?? null)
                : null,
            speakerDeadline: room.gameState.speakerDeadline ?? null,
            sheriffHasSpokenThisDay: room.gameState.sheriffHasSpokenThisDay ?? false,
            deadSeats: room.gameState.deadSeats ?? [],
            voteHistory: room.gameState.voteHistory ?? [],
            avatarBySeat: [...room.players.values()].filter((p) => p.seat != null).map((p) => ({ seat: p.seat, avatarIdx: p.avatarIdx })),
            deaths: room.gameState.deaths ?? [],
            dayIndex: room.gameState.dayIndex ?? 1,
            sheriffSeat: room.gameState.sheriffSeat ?? null,
            nightPhase: room.gameState.nightPhase ?? null,
            nightDeadline: room.gameState.nightDeadline ?? null,
            voteDeadline: room.gameState.voteDeadline ?? null,
            mutedSeat: room.gameState.mutedSeat ?? null,
        }));
    }
    // ---- 夜晚 ----
    handleStartNight(room, msg, sender) {
        if (msg.playerId !== room.hostPlayerId) {
            sender.send(JSON.stringify({ type: 'error', message: '只有房主可以开始夜晚' }));
            return;
        }
        // 上一局已结束（gameOver）后房主点击"重新开始一局"：完全清空上一局数据并重新发牌，直接进入第一夜
        if (room.gameState.phase === 'over') {
            this.restartGame(room, sender);
            return;
        }
        if (room.gameState.phase !== 'lobby') {
            sender.send(JSON.stringify({ type: 'error', message: '当前不在夜晚开始阶段' }));
            return;
        }
        this.beginNight(room);
    }
    /** 进入第一夜（发牌后 / 重开一局后 / 房主手动开始 共用）：重置夜晚状态 -> 广播 nightStarted -> 推送首个行动 -> 启动倒计时 */
    beginNight(room) {
        this.resetNight(room);
        this.broadcastToRoom(room, {
            type: 'nightStarted',
            nightDeadline: room.gameState.nightDeadline,
            nightIndex: room.gameState.dayIndex,
        });
        this.advanceNightStep(room);
        this.scheduleNightEnd(room);
    }
    /**
     * 游戏结束后的"重新开始一局"：
     * 完全清空上一局数据（角色分配、夜晚记录、票数、死亡状态、技能状态、计时器），
     * 按上一局板子重新洗牌发牌，并将 phase 重置为 night，正常进入第一夜。
     */
    restartGame(room, sender) {
        const config = room.boardConfig;
        if (!config || !Array.isArray(config.roles) || config.roles.length === 0) {
            sender.send(JSON.stringify({ type: 'error', message: '上一局的板子数据已丢失，请重新创建房间' }));
            return;
        }
        // 清掉上一局遗留的计时器
        if (room.nightTimer) {
            clearTimeout(room.nightTimer);
            room.nightTimer = null;
        }
        if (room.dayActionTimer) {
            clearTimeout(room.dayActionTimer);
            room.dayActionTimer = null;
        }
        const deck = [];
        for (const role of config.roles) {
            for (let i = 0; i < role.count; i++) {
                deck.push({ key: role.key, name: role.name, camp: role.camp ?? 'good' });
            }
        }
        const playerList = [...room.players.entries()].filter(([, info]) => info.seat != null);
        if (playerList.length === 0) {
            sender.send(JSON.stringify({ type: 'error', message: '房间里已没有玩家' }));
            return;
        }
        // 重新发牌：座位号按加入顺序保持 1..N，角色完全重新洗牌
        // 开发者模式：从完整角色池纯随机抽 n 张（不补村民、不做阵营保底）；正式局走保底随机
        const shuffled = config.devMode
            ? shuffle(deck).slice(0, playerList.length)
            : this.buildDeck(deck, playerList.length);
        room.gameState = {
            ...createEmptyGameState(),
            boardName: config.name ?? '未知板子',
            playerCount: config.playerCount ?? deck.length,
            seats: playerList.map(([playerId, info], index) => ({
                seat: info.seat ?? index + 1,
                playerId,
                nickname: info.nickname,
                roleKey: shuffled[index].key,
                roleName: shuffled[index].name,
                camp: shuffled[index].camp,
            })),
        };
        // 清空房间级累加数据（票数、狼队聊天、竞选记录等）
        room.wolfVotes = new Map();
        room.wolfChat = [];
        room.dayVotes = new Map();
        room.sheriffApplied = new Set();
        room.seerTarget = null;
        room.dreamTarget = null;
        room.witchChoice = null;
        room.sheriffAfterFn = null;
        // 直接进入第一夜
        this.beginNight(room);
    }
    /** 重置进入夜晚的各类状态（首夜与后续各夜共用；整局药水与出局记录保留） */
    resetNight(room) {
        room.gameState.phase = 'night';
        this.updateVoicePermissions(room);
        room.gameState.nightDeadline = Date.now() + NIGHT_TOTAL_MS;
        room.gameState.nightStepIndex = -1;
        room.gameState.currentPhase = null;
        room.gameState.wolfTarget = null;
        room.gameState.witchSave = false;
        room.gameState.witchPoison = null;
        room.gameState.deaths = [];
        room.gameState.dayStage = null;
        room.gameState.talkDeadline = null;
        room.gameState.voteDeadline = null;
        room.gameState.exiledSeat = null;
        room.gameState.gunSourceSeat = null;
        room.gameState.speakerOrder = [];
        room.gameState.speakerIndex = 0;
        room.gameState.speakerDeadline = null;
        // 警长竞选状态跨夜清理（警长座位/发言方向/是否竞选过 跨夜保留）
        room.gameState.sheriffCandidates = [];
        room.gameState.sheriffVotes.clear();
        room.gameState.sheriffApplyDeadline = null;
        room.gameState.sheriffVoteDeadline = null;
        room.sheriffApplied.clear();
        room.sheriffAfterFn = null;
        // 警长抢先发言只存在于白天发言阶段，进入夜晚后清空
        room.gameState.sheriffInterruptSeat = null;
        // 四角色技能状态：当前目标清空并滚动到"上一晚"（连选限制/连梦判定用）
        room.gameState.nightmarePrevTarget = room.gameState.nightmareTarget;
        room.gameState.nightmareTarget = null;
        room.gameState.wolfQueenPrevTarget = room.gameState.wolfQueenTarget;
        room.gameState.wolfQueenTarget = null; // wolfQueenUsed 跨夜保留（技能已失效不再出阶段）
        room.gameState.wolfQueenTriggered = false;
        room.gameState.dreamPrevTarget = room.dreamTarget;
        room.gameState.demonHunterPrevTarget = room.gameState.demonHunterTarget;
        room.gameState.demonHunterTarget = null;
        // 乌鸦：当前目标滚动到"上一晚"（禁言只影响下一白天），新一晚重新选择
        room.gameState.ravenPrevTarget = room.gameState.ravenTarget;
        room.gameState.ravenTarget = null;
        room.gameState.wolfKilledHunter = null;
        room.gameState.gunNightKill = false;
        room.wolfVotes.clear();
        room.wolfChat = [];
        room.seerTarget = null;
        room.dreamTarget = null;
        room.witchChoice = null;
        room.dayVotes.clear();
    }
    /** 推进到下一个有玩家在场的阶段；全部完成则天亮
     *  跳过规则：
     *  - 觉醒孤独少女/丘比特仅首夜参与（偶像/情侣只在首夜选择，之后不再出现）
     *  - 孤独少女已变身/继承后不再有少女阶段
     *  - 猎魔人第一晚不参与（第二晚起才可狩猎）
     *  - 蚀时狼妃技能已生效后不再有该阶段（下一夜永久失去技能）
     *  - 噩梦之影恐惧女巫 -> 女巫当晚不能用药（跳过女巫阶段）
     *  - 噩梦之影恐惧预言家 -> 预言家当晚无法查验（跳过预言家阶段） */
    advanceNightStep(room) {
        if (room.stepTimer) {
            clearTimeout(room.stepTimer);
            room.stepTimer = null;
        }
        const order = NIGHT_PHASE_ORDER;
        let next = room.gameState.nightStepIndex + 1;
        while (next < order.length) {
            const phase = order[next];
            if (phase.roleKey === 'lonely_girl' && (room.gameState.dayIndex !== 1 || room.gameState.lonelyConverted)) {
                next++;
                continue;
            }
            if (phase.roleKey === 'cupid' && (room.gameState.dayIndex !== 1 || room.gameState.cupidTargets !== null)) {
                next++;
                continue;
            }
            if (phase.roleKey === 'demon_hunter' && room.gameState.dayIndex < 2) {
                next++;
                continue;
            }
            if (phase.roleKey === 'wolf_queen' && room.gameState.wolfQueenUsed) {
                next++;
                continue;
            }
            if (this.phasePlayers(room, phase.roleKey).length > 0) {
                room.gameState.nightStepIndex = next;
                room.gameState.currentPhase = phase.roleKey;
                room.gameState.stepDeadline = Date.now() + NIGHT_STEP_MS;
                // 每个夜晚阶段切换时重新计算语音权限（狼人阶段存活狼人开麦互听；神职阶段全员闭麦）
                this.updateVoicePermissions(room);
                this.broadcastNightPhase(room);
                this.sendPhasePrivateInfo(room, phase.roleKey);
                // 每步独立倒计时：该角色（狼人=存活狼群）未提交操作、倒计时归零时视为空过，
                // 才推进到下一步；任何情况下都绝不提前结束夜晚、绝不因“无人操作”直接进入白天。
                const phaseIndex = next;
                const phaseRole = phase.roleKey;
                room.stepTimer = setTimeout(() => {
                    if (room.gameState.phase === 'night' &&
                        room.gameState.nightStepIndex === phaseIndex &&
                        room.gameState.currentPhase === phaseRole) {
                        room.stepTimer = null;
                        this.advanceNightStep(room);
                    }
                }, NIGHT_STEP_MS);
                // 被恐惧者仍会收到自己的行动面板（按钮禁用），但不需要其提交，短暂提示后自动跳过。
                if (this.isNightmareTarget(room, phase.roleKey)) {
                    setTimeout(() => {
                        if (room.stepTimer) {
                            clearTimeout(room.stepTimer);
                            room.stepTimer = null;
                        }
                        if (room.gameState.phase === 'night' &&
                            room.gameState.nightStepIndex === phaseIndex &&
                            room.gameState.currentPhase === phaseRole)
                            this.advanceNightStep(room);
                    }, 1200);
                }
                return;
            }
            next++;
        }
        // 所有阶段完成（含空过）-> 立即天亮（跳过剩余倒计时）
        this.endNight(room);
    }
    /** 噩梦之影是否恐惧了某角色（按 roleKey 找座位）；恐惧对象已出局则视为未恐惧 */
    isNightmareTarget(room, roleKey) {
        const gs = room.gameState;
        if (gs.nightmareTarget === null)
            return false;
        const seat = gs.seats.find((s) => s.seat === gs.nightmareTarget);
        return seat !== undefined && !gs.deadSeats.includes(seat.seat) && seat.roleKey === roleKey;
    }
    /** 统一黑夜倒计时：到点强制天亮 */
    scheduleNightEnd(room) {
        if (room.nightTimer) {
            clearTimeout(room.nightTimer);
            room.nightTimer = null;
        }
        const deadline = room.gameState.nightDeadline;
        if (deadline === null)
            return;
        const remaining = deadline - Date.now();
        if (remaining <= 0) {
            this.endNight(room);
            return;
        }
        room.nightTimer = setTimeout(() => this.endNight(room), remaining);
    }
    endNight(room) {
        if (room.gameState.phase !== 'night')
            return;
        if (room.nightTimer) {
            clearTimeout(room.nightTimer);
        if (room.stepTimer) {
            clearTimeout(room.stepTimer);
            room.stepTimer = null;
        }
            room.nightTimer = null;
        }
        const gs = room.gameState;
        // 丘比特未在首夜完成连线时，服务端兜底随机连两名玩家；绝不广播“跳过”。
        this.ensureCupidConnected(room);
        const deaths = new Set();
        const wolfTarget = gs.wolfTarget;
        const dreamTarget = room.dreamTarget;
        const wolfQueenTarget = gs.wolfQueenTarget;
        // ---- 蚀时狼妃 ----
        // 女巫毒药被封锁者 -> 反弹给女巫自己（解药不可反弹：救被封锁者正常救活）
        // 毒猎魔人：完全无效且不反弹（无论猎魔人是否被封锁），但毒药已在提交时标记为已消耗
        let poisonKill = gs.witchPoison;
        if (gs.witchPoison !== null && gs.witchPoison === wolfQueenTarget) {
            gs.wolfQueenTriggered = true;
            const pSeat = gs.seats.find((s) => s.seat === gs.witchPoison);
            if (pSeat && pSeat.roleKey === 'demon_hunter') {
                poisonKill = null;
            }
            else {
                const witch = gs.seats.find((s) => s.roleKey === 'witch' && !gs.deadSeats.includes(s.seat));
                poisonKill = witch ? witch.seat : null;
            }
        }
        // 摄梦人梦游被封锁者 -> 反弹给摄梦人（摄梦人单独出局，梦游者免疫）
        let wolfQueenDreamRebound = false;
        if (dreamTarget !== null && dreamTarget === wolfQueenTarget) {
            wolfQueenDreamRebound = true;
            gs.wolfQueenTriggered = true;
        }
        // ---- 狼刀（梦游者免疫狼刀；女巫解药救活；咒狐被狼选中不出局；狼巫查验到咒狐亦不出局） ----
        let wolfKill = wolfTarget;
        if (wolfKill !== null && gs.witchSave)
            wolfKill = null;
        if (wolfKill !== null && wolfKill === dreamTarget)
            wolfKill = null;
        if (wolfKill !== null) {
            const wkSeat = gs.seats.find((s) => s.seat === wolfKill);
            if (wkSeat && wkSeat.roleKey === 'cursed_fox')
                wolfKill = null;
        }
        // ---- 女巫毒（梦游者免疫毒；毒猎魔人无效） ----
        if (poisonKill !== null && poisonKill === dreamTarget)
            poisonKill = null;
        if (poisonKill !== null) {
            const pSeat = gs.seats.find((s) => s.seat === poisonKill);
            if (pSeat && pSeat.roleKey === 'demon_hunter')
                poisonKill = null;
        }
        // ---- 猎魔人狩猎（目标狼 -> 次日目标出局；目标好人 -> 次日猎魔人出局） ----
        let demonKill = null;
        if (gs.demonHunterTarget !== null) {
            const tSeat = gs.seats.find((s) => s.seat === gs.demonHunterTarget);
            if (tSeat) {
                if (tSeat.camp === 'wolf') {
                    demonKill = tSeat.seat;
                }
                else {
                    const hunter = gs.seats.find((s) => s.roleKey === 'demon_hunter' && !gs.deadSeats.includes(s.seat));
                    if (hunter)
                        demonKill = hunter.seat;
                }
            }
        }
        // ---- 写入死亡 ----
        if (wolfKill !== null)
            deaths.add(wolfKill);
        if (poisonKill !== null)
            deaths.add(poisonKill);
        if (demonKill !== null)
            deaths.add(demonKill);
        // ---- 摄梦人 ----
        // 连续两晚成为梦游者 -> 出局（视为吃女毒药）
        if (dreamTarget !== null && dreamTarget === gs.dreamPrevTarget) {
            deaths.add(dreamTarget);
        }
        // 摄梦人夜间出局 -> 梦游者一并出局（摄梦人因狼妃反弹出局时梦游者免疫）
        const dreamer = gs.seats.find((s) => s.roleKey === 'dream_weaver' && !gs.deadSeats.includes(s.seat));
        if (dreamer && deaths.has(dreamer.seat) && !wolfQueenDreamRebound) {
            if (dreamTarget !== null && dreamTarget !== dreamer.seat) {
                deaths.add(dreamTarget);
            }
        }
        // ---- 咒狐被预言家查验 -> 出局（出局时点：天亮） ----
        // 例外：摄梦人第一次摄中咒狐的那一夜，咒狐被查验不出局（保护一次）。
        //       若摄梦因蚀时狼妃封锁而反弹（咒狐并未真正进入梦游），不构成摄中、不保护。
        const foxSeat = gs.seats.find((s) => s.roleKey === 'cursed_fox');
        const foxDreamedThisNight = foxSeat && dreamTarget === foxSeat.seat && !wolfQueenDreamRebound;
        if (room.seerTarget !== null) {
            const sSeat = gs.seats.find((s) => s.seat === room.seerTarget);
            if (sSeat && sSeat.roleKey === 'cursed_fox') {
                const protectedByFirstDream = foxDreamedThisNight && !gs.foxDreamFirstUsed;
                if (!protectedByFirstDream) {
                    deaths.add(sSeat.seat);
                }
            }
        }
        // 首次摄中咒狐发生 -> 用掉一次性保护（无论当晚是否被查验）
        if (foxDreamedThisNight && !gs.foxDreamFirstUsed) {
            gs.foxDreamFirstUsed = true;
        }
        // ---- 殉情：情侣一方出局 -> 另一方跟着出局（链式；丘比特连接的两人整局固定） ----
        this.applyLoversDeath(room, deaths);
        const deathList = [...deaths];
        gs.deaths = deathList;
        // 累加整局出局名单
        gs.deadSeats = [
            ...new Set([...gs.deadSeats, ...deathList]),
        ].sort((a, b) => a - b);
        // 记录出局原因（供猎人/狼王开枪规则与复盘使用）
        const causes = {};
        if (wolfKill !== null)
            causes[wolfKill] = 'wolf';
        if (poisonKill !== null)
            causes[poisonKill] = 'poison';
        if (demonKill !== null)
            causes[demonKill] = 'hunt';
        if (dreamTarget !== null && dreamTarget === gs.dreamPrevTarget) {
            causes[dreamTarget] = 'dream_double';
        }
        const dreamer2 = gs.seats.find((s) => s.roleKey === 'dream_weaver' && !gs.deadSeats.includes(s.seat));
        if (dreamer2 && deaths.has(dreamer2.seat) && !wolfQueenDreamRebound) {
            if (dreamTarget !== null && dreamTarget !== dreamer2.seat) {
                causes[dreamTarget] = 'dream_follow';
            }
        }
        if (room.seerTarget !== null) {
            const sSeat = gs.seats.find((s) => s.seat === room.seerTarget);
            if (sSeat && sSeat.roleKey === 'cursed_fox') {
                causes[sSeat.seat] = 'seer_curse';
            }
        }
        Object.assign(gs.deathCauses, causes);
        // 觉醒孤独少女：偶像今晚出局 -> 变身/继承身份（需在死亡名单写入后判断）
        this.applyLonelyGirl(room);
        // 被狼刀杀害的猎人：天亮后可以开枪。
        // 例外：当晚被噩梦之影恐惧的猎人/狼王若在夜晚死亡，不能开枪；
        //       狼王被狼刀属于自刀，自刀死亡不能开枪（故夜晚只对 hunter 开放开枪）。
        if (wolfKill !== null) {
            const wkSeat = gs.seats.find((s) => s.seat === wolfKill);
            if (wkSeat &&
                wkSeat.roleKey === 'hunter' &&
                gs.nightmareTarget !== wolfKill) {
                gs.wolfKilledHunter = wolfKill;
            }
        }
        // 蚀时狼妃技能生效（使用了封锁）-> 下一夜起永久失去技能
        if (gs.wolfQueenTriggered) {
            gs.wolfQueenUsed = true;
        }
        gs.phase = 'day';
        this.updateVoicePermissions(room);
        // 【隐私】天亮只公开死亡座位，绝不在全场广播中携带刀口 wolfTarget
        // （刀口属于夜间私密信息；女巫需要刀口时已通过 witchInfo 单独私发）
        this.broadcastToRoom(room, {
            type: 'nightEnded',
            deaths: deathList,
            dayIndex: room.gameState.dayIndex,
        });
        // 被狼刀杀害的猎人：天亮后先结算开枪（属于夜间死亡的特殊反应），再判断胜负
        if (gs.wolfKilledHunter !== null) {
            const hunter = gs.seats.find((s) => s.seat === gs.wolfKilledHunter);
            if (hunter) {
                gs.dayStage = 'gun';
                gs.gunSourceSeat = gs.wolfKilledHunter;
                gs.gunNightKill = true;
                this.sendToPlayer(room, hunter.playerId, {
                    type: 'gunPanel',
                    seat: gs.wolfKilledHunter,
                    canGun: true,
                    roleName: hunter.roleName,
                    shooterName: hunter.nickname,
                    nightKill: true,
                });
                // 开枪阶段 30 秒无操作 -> 自动跳过（放弃开枪），随后判断胜负并进入白天
                this.scheduleDayAction(room, () => {
                    if (this.checkWin(room))
                        return;
                    this.maybeSheriffDeath(room, () => this.startDayPhase(room));
                }, Date.now() + 30000);
                return;
            }
        }
        // 天亮结算后自动判定胜负；达成 -> 立刻停止流程，广播胜利
        if (this.checkWin(room))
            return;
        // 警长若在昨晚出局 -> 先暂停处理警徽，完成后进入白天（竞选/发言）
        this.maybeSheriffDeath(room, () => this.startDayPhase(room));
    }
    // ---- 白天流程：警长竞选 -> 轮流发言 -> 投票 -> 计票 -> 放逐/开枪/警徽 -> 下一夜 ----
    /** 存活玩家座位列表 */
    aliveSeats(room) {
        return room.gameState.seats
            .filter((s) => !room.gameState.deadSeats.includes(s.seat))
            .map((s) => s.seat);
    }
    /** 白天入口：第一天先警长竞选（之后正常发言）；随后按警长方向发言 */
    startDayPhase(room) {
        // 每天白天开始：重置警长"抢先发言"标记（下一天白天恢复正常发言）
        room.gameState.sheriffHasSpokenThisDay = false;
        room.gameState.sheriffInterruptSeat = null;
        this.updateVoicePermissions(room);
        if (room.gameState.dayIndex === 1 && !room.gameState.sheriffElectionDone) {
            this.startSheriffElection(room);
        }
        else {
            this.startNormalTalk(room);
        }
    }
    /** 计算白天发言顺序（按警长方向）：
     *  anchor = 死者（死左/死右）或警长（警左/警右）；direction +1 顺时针（右）/ -1 逆时针（左）；
     *  无死者/无警长时回退到 1 号；只含存活玩家 */
    computeSpeakerOrder(room, dir) {
        const seats = room.gameState.seats.map((s) => s.seat);
        const alive = seats.filter((s) => !room.gameState.deadSeats.includes(s));
        if (alive.length === 0)
            return [];
        let anchor = null;
        let direction = 1;
        if (dir === 'dead_left' || dir === 'sheriff_left')
            direction = -1;
        if (dir === 'sheriff_right' || dir === 'sheriff_left') {
            anchor = room.gameState.sheriffSeat;
        }
        else {
            const lastDead = room.gameState.deaths.length > 0 ? Math.max(...room.gameState.deaths) : null;
            anchor = lastDead;
        }
        if (anchor === null)
            anchor = room.gameState.sheriffSeat ?? 1;
        const startIdx = seats.indexOf(anchor);
        const order = [];
        for (let i = 1; i <= seats.length; i++) {
            const seat = seats[(((startIdx + direction * i) % seats.length) + seats.length) % seats.length];
            if (alive.includes(seat))
                order.push(seat);
        }
        return order;
    }
    /** 从 fromIndex 开始找下一个可发言者（存活且未被乌鸦禁言）；无则 -1。
     *  发言顺序 order 本身不重排（与警长方向/过麦机制兼容），被禁言者直接跳过 */
    nextSpeakerIndex(room, order, fromIndex) {
        for (let i = fromIndex; i < order.length; i++) {
            const seat = order[i];
            if (room.gameState.deadSeats.includes(seat))
                continue;
            // 昨晚乌鸦禁言目标：下一个白天不能发言
            if (room.gameState.ravenTarget === seat)
                continue;
            // 警长已抢先发言过：本白天跳过其正常轮次（当天不能再次发言，天黑后重置）
            if (room.gameState.dayStage === 'talk' &&
                room.gameState.sheriffHasSpokenThisDay &&
                room.gameState.sheriffSeat === seat)
                continue;
            return i;
        }
        return -1;
    }
    /** 进入正常发言阶段（警长竞选后或非第一天） */
    startNormalTalk(room) {
        room.gameState.dayStage = 'talk';
        room.gameState.speakerOrder = this.computeSpeakerOrder(room, room.gameState.sheriffOrderDir);
        room.gameState.speakerIndex = 0;
        if (room.gameState.speakerOrder.length === 0) {
            // 全员出局（理论极值）：直接进入投票
            this.startVote(room);
            return;
        }
        // 第一位发言者：若被乌鸦禁言则自动顺延到下一个可发言者
        const order = room.gameState.speakerOrder;
        const first = this.nextSpeakerIndex(room, order, 0);
        if (first === -1) {
            // 所有存活者都被禁言（极值）：直接进入投票
            this.startVote(room);
            return;
        }
        const skipped = order.slice(0, first);
        room.gameState.speakerIndex = first;
        room.gameState.speakerDeadline = Date.now() + TALK_MS;
        this.scheduleDayAction(room, () => this.advanceSpeaker(room, first, order), room.gameState.speakerDeadline);
        this.broadcastToRoom(room, {
            type: 'dayStarted',
            dayIndex: room.gameState.dayIndex,
            dayStage: 'talk',
            deaths: room.gameState.deaths,
            deadSeats: room.gameState.deadSeats,
            currentSpeaker: order[first],
            speakerOrder: order,
            speakerDeadline: room.gameState.speakerDeadline,
            talkDeadline: room.gameState.speakerDeadline,
            voteDeadline: null,
            sheriffSeat: room.gameState.sheriffSeat,
            mutedSeat: room.gameState.ravenTarget,
            skippedSeats: skipped,
            sheriffHasSpokenThisDay: room.gameState.sheriffHasSpokenThisDay,
        });
        this.updateVoicePermissions(room);
    }
    /** 让 speakerOrder[speakerIndex] 开始发言（90 秒），并安排超时顺延（仅顺延时广播） */
    beginSpeaker(room) {
        const order = room.gameState.speakerOrder;
        const idx = room.gameState.speakerIndex;
        if (idx >= order.length)
            return;
        room.gameState.speakerDeadline = Date.now() + TALK_MS;
        this.broadcastToRoom(room, {
            type: 'speakerChanged',
            currentSpeaker: order[idx],
            speakerOrder: order,
            speakerIndex: idx,
            speakerDeadline: room.gameState.speakerDeadline,
            sheriffHasSpokenThisDay: room.gameState.sheriffHasSpokenThisDay,
        });
        // 当前发言者变化：重新下发语音权限（只有当前发言者可开麦）
        this.updateVoicePermissions(room);
        // 当前发言者倒计时归零 -> 自动顺延
        this.scheduleDayAction(room, () => this.advanceSpeaker(room, idx, order), room.gameState.speakerDeadline);
    }
    /** 顺延到下一位存活玩家发言；全部发言完毕 -> 自动进入投票
     *  expectedIndex/expectedOrder：定时器触发时携带当时的快照，若已被手动过麦/退水推进（已变），
     *  说明这是旧定时器，直接忽略，避免跳过发言者。
     *  被乌鸦禁言的玩家自动跳过（广播 speakerSkipped 提示）。 */
    advanceSpeaker(room, expectedIndex, expectedOrder) {
        if (room.gameState.phase !== 'day' || room.gameState.dayStage !== 'talk')
            return;
        if (expectedIndex !== undefined && expectedIndex !== room.gameState.speakerIndex)
            return;
        if (expectedOrder !== undefined && room.gameState.speakerOrder !== expectedOrder)
            return;
        room.gameState.speakerIndex += 1;
        const order = room.gameState.speakerOrder;
        const next = this.nextSpeakerIndex(room, order, room.gameState.speakerIndex);
        if (next === -1) {
            // 剩余发言者全部被禁言：先广播跳过提示，再进入投票
            const skipped = order.slice(room.gameState.speakerIndex);
            if (skipped.length > 0) {
                this.broadcastToRoom(room, {
                    type: 'speakerSkipped',
                    skippedSeats: skipped,
                    reason: 'muted',
                    currentSpeaker: null,
                });
            }
            this.startVote(room);
            return;
        }
        const skipped = order.slice(room.gameState.speakerIndex, next);
        room.gameState.speakerIndex = next;
        if (skipped.length > 0) {
            this.broadcastToRoom(room, {
                type: 'speakerSkipped',
                skippedSeats: skipped,
                reason: 'muted',
                currentSpeaker: order[next],
            });
        }
        this.beginSpeaker(room);
    }
    /** 当前发言者点击"结束发言（过麦）"：正常发言或警上发言都适用 */
    handleTalkDone(room, msg, sender) {
        if (room.gameState.phase !== 'day')
            return;
        // 警上发言：当前发言者过麦 -> 顺延
        if (room.gameState.dayStage === 'sheriffTalk') {
            const order = room.gameState.speakerOrder;
            const idx = room.gameState.speakerIndex;
            if (idx >= order.length)
                return;
            const currentSeat = order[idx];
            const seat = room.gameState.seats.find((s) => s.playerId === msg.playerId);
            if (!seat || seat.seat !== currentSeat) {
                sender.send(JSON.stringify({ type: 'error', message: '还没轮到你发言' }));
                return;
            }
            this.advanceSheriffSpeaker(room);
            return;
        }
        if (room.gameState.dayStage !== 'talk') {
            sender.send(JSON.stringify({ type: 'error', message: '当前不在发言阶段' }));
            return;
        }
        // 警长抢先发言进行中：当前发言者=警长；警长过麦后原定发言者接着发言
        if (room.gameState.sheriffInterruptSeat !== null) {
            const seat = room.gameState.seats.find((s) => s.playerId === msg.playerId);
            if (!seat || seat.seat !== room.gameState.sheriffInterruptSeat) {
                sender.send(JSON.stringify({ type: 'error', message: '还没轮到你发言' }));
                return;
            }
            if (room.gameState.deadSeats.includes(seat.seat)) {
                sender.send(JSON.stringify({ type: 'error', message: '你已经出局' }));
                return;
            }
            this.endSheriffInterrupt(room);
            return;
        }
        const order = room.gameState.speakerOrder;
        const idx = room.gameState.speakerIndex;
        if (idx >= order.length)
            return;
        const currentSeat = order[idx];
        const seat = room.gameState.seats.find((s) => s.playerId === msg.playerId);
        if (!seat || seat.seat !== currentSeat) {
            sender.send(JSON.stringify({ type: 'error', message: '还没轮到你发言' }));
            return;
        }
        if (room.gameState.deadSeats.includes(seat.seat)) {
            sender.send(JSON.stringify({ type: 'error', message: '你已经出局' }));
            return;
        }
        this.advanceSpeaker(room);
    }
    // ---- 警长抢先发言 ----
    /** 警长抢先发言：立刻成为 currentSpeaker 并开麦（剥夺原定发言者的麦克风）。
     *  一天仅一次；警长发言完毕后点击"结束发言"（或超时），原定发言者接着发言。 */
    handleSheriffInterrupt(room, msg, sender) {
        const gs = room.gameState;
        if (gs.phase !== 'day' || gs.dayStage !== 'talk')
            return;
        if (gs.sheriffInterruptSeat !== null)
            return; // 已有抢先发言在进行
        if (gs.sheriffHasSpokenThisDay)
            return; // 本白天已抢先发言过，不能再发言
        const seat = gs.seats.find((s) => s.playerId === msg.playerId);
        if (!seat || gs.deadSeats.includes(seat.seat))
            return;
        if (seat.seat !== gs.sheriffSeat) {
            sender.send(JSON.stringify({ type: 'error', message: '你不是警长，不能抢先发言' }));
            return;
        }
        if ((gs.speakerOrder[gs.speakerIndex] ?? null) === seat.seat)
            return; // 本来就是自己的轮次
        gs.sheriffHasSpokenThisDay = true;
        gs.sheriffInterruptSeat = seat.seat;
        gs.speakerDeadline = Date.now() + TALK_MS;
        this.broadcastToRoom(room, {
            type: 'speakerChanged',
            currentSpeaker: seat.seat,
            speakerOrder: gs.speakerOrder,
            speakerIndex: -1,
            speakerDeadline: gs.speakerDeadline,
            sheriffHasSpokenThisDay: true,
            sheriffInterrupt: true,
        });
        // 警长开麦成为唯一发言者（其余存活玩家全部闭麦）
        this.updateVoicePermissions(room);
        // 超时未结束发言 -> 自动结束抢先发言，原定发言者接着发言
        this.scheduleDayAction(room, () => this.endSheriffInterrupt(room), gs.speakerDeadline);
    }
    /** 警长抢先发言结束：恢复顺序麦（原定发言者接着发言） */
    endSheriffInterrupt(room) {
        if (room.gameState.dayStage !== 'talk')
            return;
        if (room.gameState.sheriffInterruptSeat === null)
            return;
        room.gameState.sheriffInterruptSeat = null;
        this.beginSpeaker(room);
    }
    // ---- 警长竞选 ----
    /** 第一天白天开始：全屋弹出上警/不上警选择 */
    startSheriffElection(room) {
        const gs = room.gameState;
        gs.dayStage = 'sheriffApply';
        gs.sheriffCandidates = [];
        gs.sheriffVotes.clear();
        room.sheriffApplied.clear();
        gs.sheriffApplyDeadline = Date.now() + SHERIFF_APPLY_MS;
        this.broadcastToRoom(room, {
            type: 'sheriffStage',
            stage: 'apply',
            candidates: [],
            deadline: gs.sheriffApplyDeadline,
            aliveSeats: this.aliveSeats(room),
            sheriffSeat: gs.sheriffSeat,
        });
        this.updateVoicePermissions(room);
        this.scheduleDayAction(room, () => this.endSheriffApply(room), gs.sheriffApplyDeadline);
    }
    handleSheriffApply(room, msg) {
        const gs = room.gameState;
        if (gs.phase !== 'day' || gs.dayStage !== 'sheriffApply')
            return;
        const seat = gs.seats.find((s) => s.playerId === msg.playerId);
        if (!seat || gs.deadSeats.includes(seat.seat))
            return;
        if (room.sheriffApplied.has(msg.playerId))
            return;
        room.sheriffApplied.add(msg.playerId);
        if (msg.apply && !gs.sheriffCandidates.includes(seat.seat)) {
            gs.sheriffCandidates.push(seat.seat);
            this.broadcastToRoom(room, { type: 'sheriffRoster', candidates: gs.sheriffCandidates });
        }
        // 所有存活玩家都已选择（上警或不上警）-> 提前结束
        const appliedSeats = [...room.sheriffApplied]
            .map((pid) => gs.seats.find((s) => s.playerId === pid)?.seat)
            .filter((s) => s !== undefined);
        const alive = this.aliveSeats(room);
        if (appliedSeats.length >= alive.length && alive.every((s) => appliedSeats.includes(s))) {
            this.endSheriffApply(room);
        }
    }
    /** 上警阶段结束：无人/一人上警直接处理；多人进入警上发言 */
    endSheriffApply(room) {
        const gs = room.gameState;
        if (gs.dayStage !== 'sheriffApply')
            return;
        gs.sheriffCandidates = gs.sheriffCandidates.filter((s) => !gs.deadSeats.includes(s));
        if (gs.sheriffCandidates.length === 0) {
            gs.sheriffElectionDone = true;
            gs.sheriffSeat = null;
            this.broadcastToRoom(room, { type: 'sheriffElected', seat: null });
            this.startNormalTalk(room);
            return;
        }
        if (gs.sheriffCandidates.length === 1) {
            this.electSheriff(room, gs.sheriffCandidates[0]);
            return;
        }
        this.startSheriffTalk(room);
    }
    /** 警上发言：候选者按座位号依次发言（复用 speaker 机制，可退水；被乌鸦禁言者跳过） */
    startSheriffTalk(room) {
        const gs = room.gameState;
        gs.dayStage = 'sheriffTalk';
        gs.speakerOrder = [...gs.sheriffCandidates].sort((a, b) => a - b);
        gs.speakerIndex = 0;
        const order = gs.speakerOrder;
        const first = this.nextSpeakerIndex(room, order, 0);
        const skipped = first === -1 ? [] : order.slice(0, first);
        if (first !== -1)
            gs.speakerIndex = first;
        gs.speakerDeadline = Date.now() + TALK_MS;
        this.broadcastToRoom(room, {
            type: 'sheriffStage',
            stage: 'talk',
            candidates: gs.sheriffCandidates,
            deadline: null,
            aliveSeats: this.aliveSeats(room),
            sheriffSeat: gs.sheriffSeat,
        });
        if (skipped.length > 0) {
            this.broadcastToRoom(room, {
                type: 'speakerSkipped',
                skippedSeats: skipped,
                reason: 'muted',
                currentSpeaker: first === -1 ? null : order[first],
            });
        }
        if (first === -1) {
            this.endSheriffTalk(room);
            return;
        }
        this.broadcastToRoom(room, {
            type: 'speakerChanged',
            currentSpeaker: order[first],
            speakerOrder: order,
            speakerIndex: first,
            speakerDeadline: gs.speakerDeadline,
            sheriffHasSpokenThisDay: gs.sheriffHasSpokenThisDay,
        });
        this.updateVoicePermissions(room);
        this.scheduleDayAction(room, () => this.advanceSheriffSpeaker(room, first, order), gs.speakerDeadline);
    }
    /** 警上发言顺延（带快照校验：退水重建队列后旧定时器自动失效；被禁言者跳过） */
    advanceSheriffSpeaker(room, expectedIndex, expectedOrder) {
        const gs = room.gameState;
        if (gs.phase !== 'day' || gs.dayStage !== 'sheriffTalk')
            return;
        if (expectedIndex !== undefined && expectedIndex !== gs.speakerIndex)
            return;
        if (expectedOrder !== undefined && gs.speakerOrder !== expectedOrder)
            return;
        gs.speakerIndex += 1;
        const order = gs.speakerOrder;
        const next = this.nextSpeakerIndex(room, order, gs.speakerIndex);
        if (next === -1) {
            // 剩余候选全部被禁言：先广播跳过提示，再结束警上发言
            const skipped = order.slice(gs.speakerIndex);
            if (skipped.length > 0) {
                this.broadcastToRoom(room, {
                    type: 'speakerSkipped',
                    skippedSeats: skipped,
                    reason: 'muted',
                    currentSpeaker: null,
                });
            }
            this.endSheriffTalk(room);
            return;
        }
        const skipped = order.slice(gs.speakerIndex, next);
        gs.speakerIndex = next;
        if (skipped.length > 0) {
            this.broadcastToRoom(room, {
                type: 'speakerSkipped',
                skippedSeats: skipped,
                reason: 'muted',
                currentSpeaker: order[next],
            });
        }
        gs.speakerDeadline = Date.now() + TALK_MS;
        this.broadcastToRoom(room, {
            type: 'speakerChanged',
            currentSpeaker: order[gs.speakerIndex],
            speakerOrder: order,
            speakerIndex: gs.speakerIndex,
            speakerDeadline: gs.speakerDeadline,
            sheriffHasSpokenThisDay: gs.sheriffHasSpokenThisDay,
        });
        this.updateVoicePermissions(room);
        this.scheduleDayAction(room, () => this.advanceSheriffSpeaker(room, gs.speakerIndex, order), gs.speakerDeadline);
    }
    /** 警上玩家退水：移出候选名单；只剩 0/1 人直接结束警上发言 */
    handleSheriffWithdraw(room, msg) {
        const gs = room.gameState;
        if (gs.phase !== 'day' || gs.dayStage !== 'sheriffTalk')
            return;
        const seat = gs.seats.find((s) => s.playerId === msg.playerId);
        if (!seat || !gs.sheriffCandidates.includes(seat.seat))
            return;
        gs.sheriffCandidates = gs.sheriffCandidates.filter((s) => s !== seat.seat);
        this.broadcastToRoom(room, { type: 'sheriffRoster', candidates: gs.sheriffCandidates });
        if (gs.sheriffCandidates.length <= 1) {
            this.endSheriffTalk(room);
            return;
        }
        // 重建发言队列：退水者移除，当前发言者定位不变；当前发言者退水则顺延
        const oldOrder = gs.speakerOrder;
        const oldIdx = gs.speakerIndex;
        const oldCurrent = oldOrder[oldIdx];
        const newOrder = [...gs.sheriffCandidates].sort((a, b) => a - b);
        let newIdx = newOrder.indexOf(oldCurrent);
        if (newIdx === -1)
            newIdx = Math.min(oldIdx, newOrder.length - 1);
        gs.speakerOrder = newOrder;
        gs.speakerIndex = newIdx;
        gs.speakerDeadline = Date.now() + TALK_MS;
        this.broadcastToRoom(room, {
            type: 'speakerChanged',
            currentSpeaker: newOrder[newIdx],
            speakerOrder: newOrder,
            speakerIndex: newIdx,
            speakerDeadline: gs.speakerDeadline,
            sheriffHasSpokenThisDay: gs.sheriffHasSpokenThisDay,
        });
        this.updateVoicePermissions(room);
        this.scheduleDayAction(room, () => this.advanceSheriffSpeaker(room, newIdx, newOrder), gs.speakerDeadline);
    }
    endSheriffTalk(room) {
        const gs = room.gameState;
        if (gs.dayStage !== 'sheriffTalk')
            return;
        gs.sheriffCandidates = gs.sheriffCandidates.filter((s) => !gs.deadSeats.includes(s));
        if (gs.sheriffCandidates.length === 0) {
            gs.sheriffElectionDone = true;
            gs.sheriffSeat = null;
            this.broadcastToRoom(room, { type: 'sheriffElected', seat: null });
            this.startNormalTalk(room);
            return;
        }
        if (gs.sheriffCandidates.length === 1) {
            this.electSheriff(room, gs.sheriffCandidates[0]);
            return;
        }
        this.startSheriffVote(room);
    }
    /** 警下投票：没上警的存活玩家从候选者中选警长 */
    startSheriffVote(room) {
        const gs = room.gameState;
        gs.dayStage = 'sheriffVote';
        gs.sheriffVotes.clear();
        gs.sheriffVoteDeadline = Date.now() + SHERIFF_VOTE_MS;
        this.broadcastToRoom(room, {
            type: 'sheriffStage',
            stage: 'vote',
            candidates: gs.sheriffCandidates,
            deadline: gs.sheriffVoteDeadline,
            aliveSeats: this.aliveSeats(room),
            sheriffSeat: gs.sheriffSeat,
        });
        this.updateVoicePermissions(room);
        this.scheduleDayAction(room, () => this.resolveSheriffVote(room), gs.sheriffVoteDeadline);
    }
    handleSheriffVote(room, msg) {
        const gs = room.gameState;
        if (gs.phase !== 'day' || gs.dayStage !== 'sheriffVote')
            return;
        const seat = gs.seats.find((s) => s.playerId === msg.playerId);
        if (!seat || gs.deadSeats.includes(seat.seat))
            return;
        if (gs.sheriffCandidates.includes(seat.seat))
            return; // 警上不投票
        if (!gs.sheriffCandidates.includes(msg.target))
            return; // 只能投候选者
        gs.sheriffVotes.set(msg.playerId, msg.target);
        // 所有警下（存活且非候选）都投完 -> 提前计票
        const voters = this.aliveSeats(room).filter((s) => !gs.sheriffCandidates.includes(s));
        if (gs.sheriffVotes.size >= voters.length) {
            this.resolveSheriffVote(room);
        }
    }
    /** 警下计票：最高票当选；平票/无人投票 -> 随机指定一名候选者（最简处理） */
    resolveSheriffVote(room) {
        const gs = room.gameState;
        if (gs.dayStage !== 'sheriffVote')
            return;
        const tally = new Map();
        for (const target of gs.sheriffVotes.values()) {
            tally.set(target, (tally.get(target) ?? 0) + 1);
        }
        let max = 0;
        for (const c of tally.values())
            max = Math.max(max, c);
        const winners = [...tally.entries()]
            .filter(([, c]) => c === max)
            .map(([s]) => s);
        let winner;
        if (max === 0 || winners.length === 0) {
            winner = gs.sheriffCandidates[Math.floor(Math.random() * gs.sheriffCandidates.length)];
        }
        else if (winners.length > 1) {
            winner = winners[Math.floor(Math.random() * winners.length)];
        }
        else {
            winner = winners[0];
        }
        this.electSheriff(room, winner);
    }
    /** 当选警长：广播 👑 标记，随后让警长决定发言方向 */
    electSheriff(room, seat) {
        const gs = room.gameState;
        gs.sheriffElectionDone = true;
        gs.sheriffSeat = seat;
        const info = gs.seats.find((s) => s.seat === seat);
        this.broadcastToRoom(room, { type: 'sheriffChanged', seat });
        this.broadcastToRoom(room, {
            type: 'sheriffElected',
            seat,
            name: info?.nickname ?? `${seat}号`,
        });
        this.startSheriffOrder(room);
    }
    /** 警长决定发言方向（30 秒未选默认从死右发言） */
    startSheriffOrder(room) {
        const gs = room.gameState;
        gs.dayStage = 'sheriffOrder';
        const sheriffSeat = gs.sheriffSeat;
        const sheriff = gs.seats.find((s) => s.seat === sheriffSeat);
        this.broadcastToRoom(room, {
            type: 'sheriffStage',
            stage: 'order',
            candidates: [],
            deadline: null,
            aliveSeats: this.aliveSeats(room),
            sheriffSeat,
        });
        this.updateVoicePermissions(room);
        if (sheriff) {
            this.sendToPlayer(room, sheriff.playerId, {
                type: 'sheriffOrderPanel',
                options: [...SHERIFF_DIRS],
            });
        }
        this.scheduleDayAction(room, () => this.applySheriffOrder(room, 'dead_right'), Date.now() + SHERIFF_ORDER_MS);
    }
    handleSheriffOrder(room, msg) {
        const gs = room.gameState;
        if (gs.phase !== 'day' || gs.dayStage !== 'sheriffOrder')
            return;
        const sheriff = gs.seats.find((s) => s.seat === gs.sheriffSeat);
        if (!sheriff || sheriff.playerId !== msg.playerId)
            return;
        if (!SHERIFF_DIRS.includes(msg.dir))
            return;
        this.applySheriffOrder(room, msg.dir);
    }
    /** 应用警长方向并开始正常发言 */
    applySheriffOrder(room, dir) {
        const gs = room.gameState;
        if (gs.dayStage !== 'sheriffOrder')
            return;
        gs.sheriffOrderDir = dir;
        this.startNormalTalk(room);
    }
    // ---- 警长出局：移交警徽 / 撕毁警徽 ----
    /** 检查当前警长是否出局；是则暂停流程弹警徽面板，返回 true */
    maybeSheriffDeath(room, after) {
        const gs = room.gameState;
        if (gs.sheriffSeat === null || !gs.deadSeats.includes(gs.sheriffSeat)) {
            after();
            return false;
        }
        if (gs.dayStage === 'sheriffDeath')
            return true; // 已暂停，不重复
        this.startSheriffDeath(room, after);
        return true;
    }
    /** 警长出局：暂停流程，给警长弹移交/撕毁面板（30 秒未选择默认撕毁） */
    startSheriffDeath(room, after) {
        const gs = room.gameState;
        gs.dayStage = 'sheriffDeath';
        room.sheriffAfterFn = after;
        const sheriffSeat = gs.sheriffSeat;
        const alive = this.aliveSeats(room).filter((s) => s !== sheriffSeat);
        const sheriff = gs.seats.find((s) => s.seat === sheriffSeat);
        this.broadcastToRoom(room, {
            type: 'sheriffStage',
            stage: 'death',
            candidates: [],
            deadline: null,
            aliveSeats: alive,
            sheriffSeat,
        });
        this.updateVoicePermissions(room);
        if (sheriff) {
            this.sendToPlayer(room, sheriff.playerId, {
                type: 'sheriffGiveawayPanel',
                aliveSeats: alive,
            });
        }
        this.scheduleDayAction(room, () => this.resolveSheriffDeath(room, null), Date.now() + SHERIFF_DEATH_MS);
    }
    handleSheriffGiveaway(room, msg) {
        const gs = room.gameState;
        if (gs.phase !== 'day' || gs.dayStage !== 'sheriffDeath')
            return;
        const sheriff = gs.seats.find((s) => s.seat === gs.sheriffSeat);
        if (!sheriff || sheriff.playerId !== msg.playerId)
            return;
        this.resolveSheriffDeath(room, msg.target);
    }
    /** 警徽处理完成：移交（target=存活座位）或撕毁（target=null），随后继续被中断的流程 */
    resolveSheriffDeath(room, target) {
        const gs = room.gameState;
        if (gs.dayStage !== 'sheriffDeath')
            return;
        if (target !== null && target !== gs.sheriffSeat && !gs.deadSeats.includes(target)) {
            gs.sheriffSeat = target;
        }
        else {
            gs.sheriffSeat = null;
        }
        this.broadcastToRoom(room, { type: 'sheriffChanged', seat: gs.sheriffSeat });
        const after = room.sheriffAfterFn;
        room.sheriffAfterFn = null;
        after?.();
    }
    /** 发言倒计时结束 -> 所有存活玩家弹出投票框 */
    startVote(room) {
        if (room.gameState.phase !== 'day' || room.gameState.dayStage !== 'talk')
            return;
        room.gameState.dayStage = 'vote';
        room.gameState.sheriffInterruptSeat = null;
        this.updateVoicePermissions(room);
        room.gameState.voteDeadline = Date.now() + VOTE_MS;
        const aliveSeats = room.gameState.seats
            .filter((s) => !room.gameState.deadSeats.includes(s.seat))
            .map((s) => s.seat);
        this.broadcastToRoom(room, {
            type: 'voteStarted',
            voteDeadline: room.gameState.voteDeadline,
            aliveSeats,
        });
        this.scheduleDayAction(room, () => this.resolveVote(room), room.gameState.voteDeadline);
    }
    /** 白天投票：只有存活玩家可投，所有人投完立即计票 */
    handleDayVote(room, msg, sender) {
        if (room.gameState.phase !== 'day' || room.gameState.dayStage !== 'vote') {
            sender.send(JSON.stringify({ type: 'error', message: '当前不是投票阶段' }));
            return;
        }
        const seat = room.gameState.seats.find((s) => s.playerId === msg.playerId);
        if (!seat) {
            sender.send(JSON.stringify({ type: 'error', message: '你不是本局玩家' }));
            return;
        }
        if (room.gameState.deadSeats.includes(seat.seat)) {
            sender.send(JSON.stringify({ type: 'error', message: '你已经出局，不能投票' }));
            return;
        }
        const target = msg.target !== null &&
            Number.isInteger(msg.target) &&
            msg.target >= 1 &&
            msg.target <= room.gameState.playerCount
            ? msg.target
            : null;
        // 防御：不能投已出局的玩家
        if (target !== null && room.gameState.deadSeats.includes(target)) {
            sender.send(JSON.stringify({ type: 'error', message: `${target}号已出局，不能投给该玩家` }));
            return;
        }
        room.dayVotes.set(msg.playerId, target);
        // 所有存活玩家都已投票 -> 提前结算
        const aliveSeats = room.gameState.seats.filter((s) => !room.gameState.deadSeats.includes(s.seat));
        if (room.dayVotes.size >= aliveSeats.length) {
            this.resolveVote(room);
        }
    }
    /** 计票：结算总票数 = 基础票（每人1，警长1.5） + 乌鸦额外1票（被诅咒者获得过票时直接叠加）。
     *  所有加成计入最终票数后，再据此判定最高票/平票：平票 = 最终票数相同，绝不在加成前判定。 */
    resolveVote(room) {
        if (room.gameState.phase !== 'day' || room.gameState.dayStage !== 'vote')
            return;
        room.gameState.dayStage = 'result';
        const tally = new Map();
        for (const [pid, target] of room.dayVotes.entries()) {
            if (target === null)
                continue;
            const voter = room.gameState.seats.find((s) => s.playerId === pid);
            const weight = voter && voter.seat === room.gameState.sheriffSeat ? 1.5 : 1;
            tally.set(target, (tally.get(target) ?? 0) + weight);
        }
        // 乌鸦：昨晚被禁言的玩家只要获得了票，最终票数直接额外 +1（参与平票判定）
        const ravenTarget = room.gameState.ravenTarget;
        if (ravenTarget !== null && tally.has(ravenTarget)) {
            tally.set(ravenTarget, (tally.get(ravenTarget) ?? 0) + 1);
        }
        const finalTally = [...tally.entries()]
            .map(([seat, count]) => ({ seat, count }))
            .sort((a, b) => b.count - a.count);
        let max = 0;
        for (const { count } of finalTally)
            max = Math.max(max, count);
        const top = finalTally.filter((t) => t.count === max);
        const tie = max === 0 || top.length > 1;
        const exiledSeat = tie ? null : top[0].seat;
        if (tie) {
            room.gameState.voteHistory.push({ dayIndex: room.gameState.dayIndex, tally: finalTally, exiledSeat: null, tie: true });
            this.broadcastToRoom(room, {
                type: 'voteResult',
                tally: finalTally,
                exiledSeat: null,
                tie: true,
                history: room.gameState.voteHistory,
            });
            // 平票，无人出局 -> 直接进入下一夜
            this.scheduleDayAction(room, () => this.startNextNight(room), Date.now() + 1500);
            return;
        }
        room.gameState.exiledSeat = exiledSeat;
        room.gameState.deadSeats = [
            ...new Set([...room.gameState.deadSeats, exiledSeat]),
        ].sort((a, b) => a - b);
        room.gameState.deathCauses[exiledSeat] = 'exile';
        // 放逐结算后：殉情（被放逐者的情侣跟着出局）
        const exDeaths = new Set([exiledSeat]);
        this.applyLoversDeath(room, exDeaths);
        for (const d of [...exDeaths]) {
            if (d === exiledSeat)
                continue;
            room.gameState.deadSeats = [
                ...new Set([...room.gameState.deadSeats, d]),
            ].sort((a, b) => a - b);
            room.gameState.deathCauses[d] = 'lover';
        }
        // 觉醒孤独少女：偶像被放逐 -> 变身狼人；其他出局 -> 继承身份
        this.applyLonelyGirl(room);
        room.gameState.voteHistory.push({ dayIndex: room.gameState.dayIndex, tally: finalTally, exiledSeat, tie: false });
        this.broadcastToRoom(room, {
            type: 'voteResult',
            tally: finalTally,
            exiledSeat,
            tie: false,
            history: room.gameState.voteHistory,
        });
        // 放逐结算后：先处理警徽/开枪等反应技能，全部结算完再判定胜负（不能提前短路猎人/狼王开枪）
        if (room.gameState.sheriffSeat === exiledSeat) {
            this.startSheriffDeath(room, () => {
                const exiled = room.gameState.seats.find((s) => s.seat === exiledSeat);
                const canGun = exiled !== undefined &&
                    ['hunter', 'wolf_king'].includes(exiled.roleKey);
                if (canGun && exiled) {
                    room.gameState.dayStage = 'gun';
                    room.gameState.gunSourceSeat = exiledSeat;
                    this.sendToPlayer(room, exiled.playerId, {
                        type: 'gunPanel',
                        seat: exiledSeat,
                        canGun: true,
                        roleName: exiled.roleName,
                        shooterName: exiled.nickname,
                    });
                    // 开枪阶段 30 秒无操作 -> 自动跳过（放弃开枪），随后判胜负
                    this.scheduleDayAction(room, () => {
                        if (this.checkWin(room))
                            return;
                        this.startNextNight(room);
                    }, Date.now() + 30000);
                }
                else {
                    if (this.checkWin(room))
                        return;
                    this.scheduleDayAction(room, () => this.startNextNight(room), Date.now() + 1500);
                }
            });
            return;
        }
        // 被放逐者若为猎人/狼王 -> 自动弹出开枪面板（猎魔人白天被放逐不能开枪，已从集合移除）
        const exiled = room.gameState.seats.find((s) => s.seat === exiledSeat);
        const canGun = exiled !== undefined && ['hunter', 'wolf_king'].includes(exiled.roleKey);
        if (canGun && exiled) {
            room.gameState.dayStage = 'gun';
            room.gameState.gunSourceSeat = exiledSeat;
            this.sendToPlayer(room, exiled.playerId, {
                type: 'gunPanel',
                seat: exiledSeat,
                canGun: true,
                roleName: exiled.roleName,
                shooterName: exiled.nickname,
            });
            // 开枪阶段 30 秒无操作 -> 自动跳过（放弃开枪），随后判胜负
            this.scheduleDayAction(room, () => {
                if (this.checkWin(room))
                    return;
                this.startNextNight(room);
            }, Date.now() + 30000);
        }
        else {
            this.scheduleDayAction(room, () => this.startNextNight(room), Date.now() + 1500);
        }
    }
    /** 被放逐的猎人/狼王/猎魔人选择带走的目标 */
    handleGunTarget(room, msg, sender) {
        if (room.gameState.phase !== 'day' || room.gameState.dayStage !== 'gun') {
            sender.send(JSON.stringify({ type: 'error', message: '当前没有可发动的技能' }));
            return;
        }
        if (room.gameState.gunSourceSeat === null)
            return;
        const shooter = room.gameState.seats.find((s) => s.seat === room.gameState.gunSourceSeat);
        if (!shooter || shooter.playerId !== msg.playerId) {
            sender.send(JSON.stringify({ type: 'error', message: '只有被放逐者可以发动技能' }));
            return;
        }
        const target = Number.isInteger(msg.target) &&
            msg.target >= 1 &&
            msg.target <= room.gameState.playerCount
            ? msg.target
            : null;
        // 防御：不能带走已出局的玩家
        if (target !== null && room.gameState.deadSeats.includes(target)) {
            sender.send(JSON.stringify({ type: 'error', message: `${target}号已出局，不能选择该玩家` }));
            return;
        }
        if (target === null) {
            sender.send(JSON.stringify({ type: 'error', message: '请选择目标' }));
            return;
        }
        const victim = room.gameState.seats.find((s) => s.seat === target);
        room.gameState.deadSeats = [
            ...new Set([...room.gameState.deadSeats, target]),
        ].sort((a, b) => a - b);
        room.gameState.deathCauses[target] = 'gun';
        this.broadcastToRoom(room, {
            type: 'gunShot',
            shooter: shooter.seat,
            target,
            shooterName: shooter.nickname,
            targetName: victim?.nickname ?? `${target}号`,
        });
        // 开枪结算后：殉情 / 孤独少女继承 / 胜负判定
        const gunDeaths = new Set([target]);
        this.applyLoversDeath(room, gunDeaths);
        for (const d of [...gunDeaths]) {
            if (d === target)
                continue;
            room.gameState.deadSeats = [
                ...new Set([...room.gameState.deadSeats, d]),
            ].sort((a, b) => a - b);
            room.gameState.deathCauses[d] = 'lover';
        }
        this.applyLonelyGirl(room);
        // 开枪结算后的去向：夜晚被刀猎人天亮开枪 -> 进入白天发言；放逐/白天开枪 -> 进入下一夜
        const afterGun = () => {
            if (room.gameState.gunNightKill) {
                room.gameState.gunNightKill = false;
                this.maybeSheriffDeath(room, () => this.startDayPhase(room));
            }
            else {
                this.scheduleDayAction(room, () => this.startNextNight(room), Date.now() + 1500);
            }
        };
        // 狼王被白天开枪带走 -> 先发二次开枪面板（未结算胜负前），其他角色不再开枪
        if (victim && victim.roleKey === 'wolf_king' && target !== shooter.seat) {
            room.gameState.dayStage = 'gun';
            room.gameState.gunSourceSeat = target;
            this.sendToPlayer(room, victim.playerId, {
                type: 'gunPanel',
                seat: target,
                canGun: true,
                roleName: victim.roleName,
                shooterName: victim.nickname,
                nightKill: false,
            });
            // 狼王 30 秒内不开枪 -> 自动跳过，随后判胜负并继续枪链去向
            this.scheduleDayAction(room, () => {
                if (this.checkWin(room))
                    return;
                this.maybeSheriffDeath(room, afterGun);
            }, Date.now() + 30000);
            return;
        }
        if (this.checkWin(room))
            return;
        // 被带走者若是警长 -> 先暂停处理警徽，再继续枪链去向
        this.maybeSheriffDeath(room, afterGun);
    }
    /** 白天流程结算完毕 -> 自动进入下一夜（保留整局记录，第二天黑夜） */
    startNextNight(room) {
        if (room.gameState.phase !== 'day')
            return;
        room.gameState.dayIndex += 1;
        this.resetNight(room);
        this.broadcastToRoom(room, {
            type: 'nightStarted',
            nightDeadline: room.gameState.nightDeadline,
            nightIndex: room.gameState.dayIndex,
        });
        this.advanceNightStep(room);
        this.scheduleNightEnd(room);
    }
    // ---- 殉情 / 孤独少女 / 胜负判定 ----
    /** 殉情：情侣一方出局 -> 另一方跟着出局（链式）；丘比特连接的两人整局固定 */
    applyLoversDeath(room, deaths) {
        const gs = room.gameState;
        const pair = gs.cupidTargets;
        if (!pair)
            return;
        const [a, b] = pair;
        for (const seatNo of [...deaths]) {
            if (seatNo !== a && seatNo !== b)
                continue;
            const other = seatNo === a ? b : a;
            if (gs.deadSeats.includes(other) || deaths.has(other))
                continue;
            if (!gs.seats.some((s) => s.seat === other))
                continue;
            deaths.add(other);
            gs.deathCauses[other] = 'lover';
        }
    }
    /** 觉醒孤独少女：偶像出局时变身/继承
     *  偶像被放逐 -> 少女变身为狼人（加入狼队，每晚参与狼队行动）
     *  偶像因其他原因出局 -> 少女继承偶像的身份与阵营（技能面板以新身份出现） */
    applyLonelyGirl(room) {
        const gs = room.gameState;
        const girl = gs.seats.find((s) => s.roleKey === 'lonely_girl' && !gs.deadSeats.includes(s.seat));
        if (!girl || gs.lonelyConverted)
            return;
        const idolSeat = gs.lonelyIdol;
        if (idolSeat === null)
            return;
        const idol = gs.seats.find((s) => s.seat === idolSeat);
        if (!idol || !gs.deadSeats.includes(idol.seat))
            return;
        // 偶像已出局 -> 变身/继承（只发生一次）
        gs.lonelyConverted = true;
        let newRoleKey;
        let newRoleName;
        let newCamp;
        if (gs.deathCauses[idolSeat] === 'exile') {
            newRoleKey = 'wolf';
            newRoleName = '狼人';
            newCamp = 'wolf';
        }
        else {
            newRoleKey = idol.roleKey;
            newRoleName = idol.roleName;
            newCamp = idol.camp;
        }
        girl.roleKey = newRoleKey;
        girl.roleName = newRoleName;
        girl.camp = newCamp;
        // 【隐私】变身结果只私发少女本人；若变身为狼人，再仅向狼队播报新队友（好人收不到）
        this.sendToPlayer(room, girl.playerId, {
            type: 'lonelyGirlConverted',
            seat: girl.seat,
            newRoleKey,
            newRoleName,
            cause: gs.deathCauses[idolSeat],
            idolSeat,
        });
        if (newCamp === 'wolf') {
            this.broadcastToWolves(room, {
                type: 'wolfChat',
                playerId: 'system',
                nickname: '系统',
                text: `${girl.seat}号觉醒孤独少女变身为狼人，加入狼队`,
                ts: Date.now(),
            });
        }
    }
    /** 胜负判定（天亮结算后 / 放逐结算后 / 开枪结算后调用）：
     *  达成任意一方胜利 -> 广播 gameOver 并冻结流程，返回 true
     *  - 第三方（丘比特连接的好+狼情侣）：情侣+丘比特之外的所有玩家出局 -> 第三方胜
     *  - 好人胜：狼人全灭；狼人胜：存活狼人 >= 存活好人（有第三方情侣时还需情侣全出局）
     *  - 咒狐：狼人或好人达成胜利时若咒狐存活 -> 咒狐取代成为胜利者 */
    checkWin(room) {
        const gs = room.gameState;
        if (gs.phase === 'over')
            return true;
        const alive = gs.seats.filter((s) => !gs.deadSeats.includes(s.seat));
        const wolves = alive.filter((s) => s.camp === 'wolf').length;
        const good = alive.filter((s) => s.camp === 'good').length;
        const cursedFoxAlive = alive.some((s) => s.roleKey === 'cursed_fox');
        const pair = gs.cupidTargets;
        let thirdActive = false;
        let pairAllDead = true;
        if (pair) {
            const [a, b] = pair;
            const aSeat = gs.seats.find((s) => s.seat === a);
            const bSeat = gs.seats.find((s) => s.seat === b);
            const aAlive = alive.some((s) => s.seat === a);
            const bAlive = alive.some((s) => s.seat === b);
            pairAllDead = !aAlive && !bAlive;
            if (aSeat && bSeat && aSeat.camp !== bSeat.camp && (aAlive || bAlive)) {
                thirdActive = true;
            }
        }
        // 第三方（好+狼情侣）：情侣与丘比特之外的所有玩家出局
        if (thirdActive) {
            const outside = alive.filter((s) => {
                if (pair && (s.seat === pair[0] || s.seat === pair[1]))
                    return false;
                if (s.roleKey === 'cupid')
                    return false;
                return true;
            });
            if (outside.length === 0) {
                this.gameOver(room, 'third', '第三方情侣阵营');
                return true;
            }
        }
        // 好人胜利：狼人全灭（有第三方情侣时还需情侣全出局）
        if (wolves === 0 && (!thirdActive || pairAllDead)) {
            if (cursedFoxAlive) {
                this.gameOver(room, 'cursed_fox', '咒狐阵营');
            }
            else {
                this.gameOver(room, 'good', '好人阵营');
            }
            return true;
        }
        // 狼人胜利：存活狼人 >= 存活非狼总数（好人 + 第三阵营；12人板首夜刀1好人不至于直接终局）
        // 有第三方情侣时还需情侣全出局
        if (wolves > 0 && wolves >= alive.length - wolves && (!thirdActive || pairAllDead)) {
            if (cursedFoxAlive) {
                this.gameOver(room, 'cursed_fox', '咒狐阵营');
            }
            else {
                this.gameOver(room, 'wolf', '狼人阵营');
            }
            return true;
        }
        return false;
    }
    /** 游戏结束：冻结流程，广播胜利方与所有玩家身份 */
    gameOver(room, winner, winnerLabel) {
        const gs = room.gameState;
        gs.phase = 'over';
        gs.winner = winner;
        if (room.nightTimer) {
            clearTimeout(room.nightTimer);
            room.nightTimer = null;
        }
        if (room.dayActionTimer) {
            clearTimeout(room.dayActionTimer);
            room.dayActionTimer = null;
        }
        this.updateVoicePermissions(room);
        this.broadcastToRoom(room, {
            type: 'gameOver',
            winner,
            winnerLabel,
            roles: gs.seats.map(({ seat, nickname, roleKey, roleName }) => ({
                seat,
                nickname,
                roleKey,
                roleName,
            })),
        });
    }
    /** 定时器：到点触发白天动作（统一时间戳控制，不依赖前端各自计时） */
    scheduleDayAction(room, fn, deadline) {
        if (room.dayActionTimer)
            clearTimeout(room.dayActionTimer);
        const remaining = deadline - Date.now();
        room.dayActionTimer = setTimeout(fn, Math.max(0, remaining));
    }
    // ---- 狼人私密沟通与投票 ----
    handleWolfChat(room, msg) {
        if (room.gameState.phase !== 'night' || room.gameState.currentPhase !== 'wolf') {
            return;
        }
        const seat = room.gameState.seats.find((s) => s.playerId === msg.playerId);
        if (!seat || seat.camp !== 'wolf')
            return;
        const text = (msg.text ?? '').slice(0, 60);
        if (!text.trim())
            return;
        const entry = {
            playerId: msg.playerId,
            nickname: seat.nickname,
            text,
            ts: Date.now(),
        };
        room.wolfChat.push(entry);
        if (room.wolfChat.length > 40)
            room.wolfChat.shift();
        // 只广播给狼人玩家
        this.broadcastToWolves(room, { type: 'wolfChat', ...entry });
    }
    handleWolfVote(room, msg) {
        if (room.gameState.phase !== 'night' || room.gameState.currentPhase !== 'wolf') {
            return;
        }
        const seat = room.gameState.seats.find((s) => s.playerId === msg.playerId);
        if (!seat || seat.camp !== 'wolf')
            return;
        const target = msg.target !== null &&
            Number.isInteger(msg.target) &&
            msg.target >= 1 &&
            msg.target <= room.gameState.playerCount
            ? msg.target
            : null;
        // 防御：不能刀已出局的玩家
        if (target !== null && room.gameState.deadSeats.includes(target)) {
            const sender = room.clients.get(msg.playerId);
            if (sender)
                sender.send(JSON.stringify({ type: 'error', message: `${target}号已出局，不能选择该玩家` }));
            return;
        }
        room.wolfVotes.set(msg.playerId, target);
        this.acceptNightAction(room, msg.playerId);
        this.broadcastWolfVotes(room);
        // 所有狼人都提交后，结算狼刀并推进阶段
        const wolves = this.phasePlayers(room, 'wolf');
        if (room.wolfVotes.size >= wolves.length) {
            this.resolveWolfTarget(room);
            this.advanceNightStep(room);
        }
    }
    /** 狼刀 = 票数最高目标；平票随机；全员弃票 = 平安夜
     *  噩梦之影恐惧到狼人 -> 空刀（狼队当晚无法袭击），狼刀目标置空 */
    resolveWolfTarget(room) {
        const tally = new Map();
        for (const target of room.wolfVotes.values()) {
            if (target === null)
                continue;
            tally.set(target, (tally.get(target) ?? 0) + 1);
        }
        if (tally.size === 0) {
            room.gameState.wolfTarget = null;
            return;
        }
        let max = 0;
        for (const count of tally.values())
            max = Math.max(max, count);
        const top = [...tally.keys()].filter((seat) => tally.get(seat) === max);
        room.gameState.wolfTarget = top[Math.floor(Math.random() * top.length)];
        // 噩梦之影恐惧到狼人 -> 整个狼人阵营空刀
        const nt = room.gameState.nightmareTarget;
        if (nt !== null && !room.gameState.deadSeats.includes(nt)) {
            const nightmareSeat = room.gameState.seats.find((s) => s.seat === nt);
            if (nightmareSeat && nightmareSeat.camp === 'wolf') {
                room.gameState.wolfTarget = null;
            }
        }
    }
    // ---- 神职面板（依次弹出） ----
    handleNightTarget(room, msg, sender) {
        if (room.gameState.phase !== 'night' || room.gameState.currentPhase !== msg.roleKey) {
            return;
        }
        const seat = room.gameState.seats.find((s) => s.playerId === msg.playerId);
        if (!seat || seat.roleKey !== msg.roleKey)
            return;
        const target = Number.isInteger(msg.target) && msg.target >= 1 && msg.target <= room.gameState.playerCount
            ? msg.target
            : null;
        // 防御：目标必须是存活玩家（防止前端绕过/手改协议选择死人）
        if (target !== null && room.gameState.deadSeats.includes(target)) {
            sender.send(JSON.stringify({ type: 'error', message: `${target}号已出局，不能选择该玩家` }));
            return;
        }
        if (this.isNightmareTarget(room, msg.roleKey))
            return;
        // 可主动空过的神职：0 是私有协议中的“不使用技能”，不会向全场广播。
        if (msg.target === 0 &&
            (msg.roleKey === 'dream_weaver' || msg.roleKey === 'raven' || msg.roleKey === 'wolf_witch' || msg.roleKey === 'nightmare')) {
            if (msg.roleKey === 'dream_weaver')
                room.dreamTarget = null;
            if (msg.roleKey === 'raven')
                room.gameState.ravenTarget = null;
            if (msg.roleKey === 'wolf_witch')
                room.gameState.wolfWitchCheck = null;
            if (msg.roleKey === 'nightmare')
                room.gameState.nightmareTarget = null;
            this.acceptNightAction(room, msg.playerId);
            this.advanceNightStep(room);
            return;
        }
        // ---- 噩梦之影：恐惧（不能连续两晚恐惧同一玩家） ----
        if (msg.roleKey === 'nightmare') {
            if (target === null)
                return;
            if (target === room.gameState.nightmarePrevTarget) {
                sender.send(JSON.stringify({
                    type: 'error',
                    message: `不能连续两晚恐惧同一名玩家（${target}号昨晚已被恐惧）`,
                }));
                return;
            }
            room.gameState.nightmareTarget = target;
            this.acceptNightAction(room, msg.playerId);
            this.advanceNightStep(room);
            return;
        }
        // ---- 蚀时狼妃：封锁（target=0 表示不使用技能；可以不使用） ----
        if (msg.roleKey === 'wolf_queen') {
            // 0 不能被顶部校验解析，须用原始值特判
            if (msg.target === 0) {
                room.gameState.wolfQueenTarget = null;
                this.acceptNightAction(room, msg.playerId);
                this.advanceNightStep(room);
                return;
            }
            if (target === null)
                return;
            if (target === room.gameState.wolfQueenPrevTarget) {
                sender.send(JSON.stringify({ type: 'error', message: `不能连续两晚封锁同一名玩家（${target}号）` }));
                return;
            }
            room.gameState.wolfQueenTarget = target;
            this.acceptNightAction(room, msg.playerId);
            this.advanceNightStep(room);
            return;
        }
        // ---- 猎魔人：狩猎（第二晚起；不能猎自己；不能连续两晚狩猎同一玩家；可空过） ----
        if (msg.roleKey === 'demon_hunter') {
            if (room.gameState.dayIndex < 2)
                return;
            // target=0 表示空过（不使用技能），直接进入下一阶段
            if (msg.target === 0) {
                room.gameState.demonHunterTarget = null;
                this.acceptNightAction(room, msg.playerId);
                this.advanceNightStep(room);
                return;
            }
            if (target === null)
                return;
            if (target === seat.seat) {
                sender.send(JSON.stringify({ type: 'error', message: '不能狩猎自己' }));
                return;
            }
            if (target === room.gameState.demonHunterPrevTarget) {
                sender.send(JSON.stringify({
                    type: 'error',
                    message: `不能连续两晚狩猎同一名玩家（${target}号）`,
                }));
                return;
            }
            room.gameState.demonHunterTarget = target;
            this.acceptNightAction(room, msg.playerId);
            this.advanceNightStep(room);
            return;
        }
        // ---- 觉醒孤独少女：首夜选择偶像（不能选自己） ----
        if (msg.roleKey === 'lonely_girl') {
            if (room.gameState.dayIndex !== 1)
                return;
            if (target === null || target === seat.seat) {
                sender.send(JSON.stringify({ type: 'error', message: '请选择一名其他玩家作为偶像' }));
                return;
            }
            room.gameState.lonelyIdol = target;
            this.acceptNightAction(room, msg.playerId);
            this.advanceNightStep(room);
            return;
        }
        // ---- 预言家：查验结果私密发送本人；被狼妃封锁 -> 查验反弹给自己（视为金水） ----
        if (msg.roleKey === 'seer') {
            if (room.gameState.wolfQueenTarget !== null && target === room.gameState.wolfQueenTarget) {
                // 查验被封锁者 -> 反弹：视为查验自己（好人/金水），咒狐出局判定不触发
                room.seerTarget = seat.seat;
                room.gameState.wolfQueenTriggered = true;
                this.sendToPlayer(room, seat.playerId, {
                    type: 'seerResult',
                    target: seat.seat,
                    camp: 'good',
                    rebounded: true,
                });
                this.acceptNightAction(room, msg.playerId);
                this.advanceNightStep(room);
                return;
            }
            room.seerTarget = target;
            const checked = room.gameState.seats.find((s) => s.seat === target);
            if (checked) {
                this.sendToPlayer(room, seat.playerId, {
                    type: 'seerResult',
                    target,
                    camp: checked.camp === 'wolf' ? 'wolf' : 'good',
                    roleName: checked.roleName,
                    isCursedFox: checked.roleKey === 'cursed_fox',
                });
            }
            this.acceptNightAction(room, msg.playerId);
            this.advanceNightStep(room);
            return;
        }
        if (msg.roleKey === 'dream_weaver') {
            // 摄梦人不能对自己使用技能
            if (target === seat.seat) {
                sender.send(JSON.stringify({ type: 'error', message: '摄梦人不能对自己使用技能' }));
                return;
            }
            room.dreamTarget = target;
        }
        else if (msg.roleKey === 'raven') {
            // 不能连续两晚诅咒同一位玩家
            if (target === room.gameState.ravenPrevTarget) {
                sender.send(JSON.stringify({
                    type: 'error',
                    message: `不能连续两晚诅咒同一名玩家（${target}号）`,
                }));
                return;
            }
            room.gameState.ravenTarget = target;
        }
        else if (msg.roleKey === 'wolf_witch') {
            // 狼巫：查验一名玩家的具体身份（查验到咒狐，咒狐不出局）
            const wolfWitch = this.phasePlayers(room, 'wolf_witch')[0];
            if (!wolfWitch || wolfWitch.playerId !== msg.playerId)
                return;
            const checked = room.gameState.seats.find((s) => s.seat === target);
            if (!checked)
                return;
            room.gameState.wolfWitchCheck = {
                target: target,
                roleKey: checked.roleKey,
                name: checked.roleName,
            };
            // 结果私发狼巫本人，并同步到狼队聊天（狼队共享信息）
            this.sendToPlayer(room, wolfWitch.playerId, {
                type: 'wolfWitchResult',
                target,
                roleKey: checked.roleKey,
                roleName: checked.roleName,
            });
            room.wolfChat.push({
                playerId: wolfWitch.playerId,
                nickname: `${wolfWitch.seat}号·狼巫`,
                text: `狼巫查验 ${target} 号：${checked.roleName}`,
                ts: Date.now(),
            });
            this.broadcastToWolves(room, { type: 'wolfChat', playerId: wolfWitch.playerId, nickname: `${wolfWitch.seat}号·狼巫`, text: `狼巫查验 ${target} 号：${checked.roleName}`, ts: Date.now() });
        }
        else {
            return;
        }
        this.acceptNightAction(room, msg.playerId);
        this.advanceNightStep(room);
    }
    /** 丘比特首夜连接情侣：选两个不同玩家（不能选自己）；连接后整局固定 */
    handleCupidAction(room, msg, sender) {
        const gs = room.gameState;
        if (gs.phase !== 'night' || gs.currentPhase !== 'cupid') {
            sender.send(JSON.stringify({ type: 'error', message: '当前不是丘比特行动阶段' }));
            return;
        }
        const seat = gs.seats.find((s) => s.playerId === msg.playerId);
        if (!seat || seat.roleKey !== 'cupid') {
            sender.send(JSON.stringify({ type: 'error', message: '你不是丘比特' }));
            return;
        }
        if (gs.dayIndex !== 1 || gs.cupidTargets !== null) {
            sender.send(JSON.stringify({ type: 'error', message: '情侣已在首夜连接过' }));
            return;
        }
        const targets = msg.targets;
        if (!Array.isArray(targets) || targets.length !== 2) {
            sender.send(JSON.stringify({ type: 'error', message: '请选择两名玩家成为情侣' }));
            return;
        }
        const [a, b] = targets;
        if (!Number.isInteger(a) ||
            !Number.isInteger(b) ||
            a < 1 ||
            a > gs.playerCount ||
            b < 1 ||
            b > gs.playerCount) {
            sender.send(JSON.stringify({ type: 'error', message: '请选择有效的座位号' }));
            return;
        }
        if (a === b) {
            sender.send(JSON.stringify({ type: 'error', message: '不能选择同一名玩家两次' }));
            return;
        }
        if (a === seat.seat || b === seat.seat) {
            sender.send(JSON.stringify({ type: 'error', message: '丘比特不能选自己成为情侣' }));
            return;
        }
        gs.cupidTargets = [a, b];
        // 【隐私】连接结果绝不全场广播（否则所有人都知道情侣是谁）：
        //  - 丘比特本人收到 cupidConnected（确认连了哪两个号码）
        //  - 两位情侣各收到 loverInfo，只知道自己的情侣号码，不知道对方身份
        const aSeat = gs.seats.find((s) => s.seat === a);
        const bSeat = gs.seats.find((s) => s.seat === b);
        this.sendToPlayer(room, seat.playerId, {
            type: 'cupidConnected',
            targets: [a, b],
        });
        if (aSeat) {
            this.sendToPlayer(room, aSeat.playerId, { type: 'loverInfo', partner: b });
        }
        if (bSeat) {
            this.sendToPlayer(room, bSeat.playerId, { type: 'loverInfo', partner: a });
        }
        this.acceptNightAction(room, msg.playerId);
        this.advanceNightStep(room);
    }
    handleWitchAction(room, msg, sender) {
        if (room.gameState.phase !== 'night' || room.gameState.currentPhase !== 'witch') {
            sender.send(JSON.stringify({ type: 'error', message: '当前不是女巫行动阶段' }));
            return;
        }
        const seat = room.gameState.seats.find((s) => s.playerId === msg.playerId);
        if (!seat || seat.roleKey !== 'witch') {
            sender.send(JSON.stringify({ type: 'error', message: '你不是女巫' }));
            return;
        }
        // 噩梦之影恐惧女巫 -> 当晚不能用药
        if (room.gameState.nightmareTarget === seat.seat) {
            sender.send(JSON.stringify({
                type: 'error',
                message: '你被噩梦之影恐惧，今晚不能使用药水',
            }));
            return;
        }
        // 一晚只能行动一次（救/毒/不用药 三选一，已提交即锁定，禁止重复提交）
        if (room.witchChoice !== null) {
            sender.send(JSON.stringify({ type: 'error', message: '本晚已行动，不能重复使用药水' }));
            return;
        }
        const choice = msg.choice;
        if (choice !== 'save' && choice !== 'poison' && choice !== 'none') {
            sender.send(JSON.stringify({ type: 'error', message: '无效的药水操作' }));
            return;
        }
        // 自救限制：女巫被狼刀 -> 禁止使用解药
        if (choice === 'save' && room.gameState.wolfTarget === seat.seat) {
            sender.send(JSON.stringify({ type: 'error', message: '你被狼刀了，不能自救' }));
            return;
        }
        // 整局药水限制：解药 / 毒药整局各一瓶，用过永久失效
        if (choice === 'save' && room.gameState.witchSaved) {
            sender.send(JSON.stringify({ type: 'error', message: '解药已经用过了（整局仅一瓶）' }));
            return;
        }
        if (choice === 'poison' && room.gameState.witchPoisoned) {
            sender.send(JSON.stringify({ type: 'error', message: '毒药已经用过了（整局仅一瓶）' }));
            return;
        }
        if (choice === 'poison') {
            const target = msg.target !== undefined &&
                Number.isInteger(msg.target) &&
                msg.target >= 1 &&
                msg.target <= room.gameState.playerCount
                ? msg.target
                : null;
            if (target === null) {
                sender.send(JSON.stringify({ type: 'error', message: '请选择毒药目标' }));
                return;
            }
            // 防御：不能毒已出局的玩家
            if (room.gameState.deadSeats.includes(target)) {
                sender.send(JSON.stringify({ type: 'error', message: `${target}号已出局，不能选择该玩家` }));
                return;
            }
            room.gameState.witchPoison = target;
            room.gameState.witchPoisoned = true;
        }
        else if (choice === 'save') {
            room.gameState.witchSave = true;
            room.gameState.witchSaved = true;
        }
        // none 也标记为已行动，锁定本晚不能再改
        room.witchChoice = choice;
        this.acceptNightAction(room, msg.playerId);
        this.advanceNightStep(room);
    }
    /** 仅私发提交确认，客户端收起面板而不向全场暴露任何操作。 */
    acceptNightAction(room, playerId) {
        this.sendToPlayer(room, playerId, { type: 'nightActionAccepted' });
    }
    /** 丘比特首夜未完成连线时的服务端兜底；结果只通知相关三人。 */
    ensureCupidConnected(room) {
        const gs = room.gameState;
        if (gs.dayIndex !== 1 || gs.cupidTargets !== null)
            return;
        const cupid = gs.seats.find((s) => s.roleKey === 'cupid');
        if (!cupid || gs.deadSeats.includes(cupid.seat))
            return;
        const picks = shuffle(gs.seats.filter((s) => s.seat !== cupid.seat)).slice(0, 2);
        if (picks.length !== 2)
            return;
        gs.cupidTargets = [picks[0].seat, picks[1].seat];
        this.sendToPlayer(room, cupid.playerId, { type: 'cupidConnected', targets: gs.cupidTargets });
        this.sendToPlayer(room, picks[0].playerId, { type: 'loverInfo', partner: picks[1].seat });
        this.sendToPlayer(room, picks[1].playerId, { type: 'loverInfo', partner: picks[0].seat });
    }
    // ---- 阶段玩家与私发 ----
    /** 当前阶段需要操作面板的玩家（狼人 = 整个狼人阵营） */
    phasePlayers(room, roleKey) {
        const alive = room.gameState.seats.filter((s) => !room.gameState.deadSeats.includes(s.seat));
        if (roleKey === 'wolf') {
            return alive.filter((s) => s.camp === 'wolf');
        }
        // 神职已出局则不再参与夜晚行动（否则死预言家会卡住夜晚流程）
        return alive.filter((s) => s.roleKey === roleKey);
    }
    broadcastNightPhase(room) {
        const phase = NIGHT_PHASE_ORDER[room.gameState.nightStepIndex];
        if (!phase)
            return;
        // 【隐私】全场只收到不带角色身份的中性推进帧（仅用于刷新倒计时/闭眼提示），
        // 绝不广播"当前轮到谁睁眼"，避免好人通过 WS 帧推断神职身份或行动顺序。
        this.broadcastToRoom(room, {
            type: 'nightPhase',
            stepIndex: room.gameState.nightStepIndex,
            stepDeadline: room.gameState.stepDeadline ?? null,
        });
        // 【隐私】带 roleKey/label 的阶段信息只单播给当前需要行动的角色：
        // 狼人阶段发给所有存活狼人，其余阶段发给对应神职本人。
        const privatePayload = {
            type: 'nightPhase',
            stepIndex: room.gameState.nightStepIndex,
            roleKey: phase.roleKey,
            label: phase.label,
            requiredAction: phase.requiredAction,
            stepDeadline: room.gameState.stepDeadline ?? null,
            disabled: this.isNightmareTarget(room, phase.roleKey),
        };
        if (phase.roleKey === 'wolf') {
            for (const seat of this.phasePlayers(room, 'wolf')) {
                this.sendToPlayer(room, seat.playerId, privatePayload);
            }
        }
        else {
            for (const seat of this.phasePlayers(room, phase.roleKey)) {
                this.sendToPlayer(room, seat.playerId, privatePayload);
            }
        }
    }
    /** 阶段开始时向对应角色私发面板数据（狼人队友、女巫刀口） */
    sendPhasePrivateInfo(room, roleKey) {
        if (roleKey === 'wolf') {
            const wolves = this.phasePlayers(room, 'wolf');
            const wolfSeats = wolves.map((s) => s.seat);
            const payload = {
                type: 'wolfPanel',
                wolfSeats,
                wolfChat: room.wolfChat,
                wolfVotes: this.wolfVoteSummary(room),
                // 自带完整座位表，狼人面板的刀口按钮不依赖客户端其它消息
                seats: room.gameState.seats.map(({ seat, playerId, nickname }) => ({
                    seat,
                    playerId,
                    nickname,
                })),
            };
            this.broadcastToWolves(room, payload);
        }
        else if (roleKey === 'witch') {
            const witch = this.phasePlayers(room, 'witch')[0];
            if (witch) {
                this.sendToPlayer(room, witch.playerId, {
                    type: 'witchInfo',
                    target: room.gameState.wolfTarget,
                    saveUsed: room.gameState.witchSaved,
                    poisonUsed: room.gameState.witchPoisoned,
                });
            }
        }
    }
    wolfVoteSummary(room) {
        const tally = new Map();
        for (const target of room.wolfVotes.values()) {
            if (target === null)
                continue;
            tally.set(target, (tally.get(target) ?? 0) + 1);
        }
        return [...tally.entries()]
            .map(([seat, count]) => ({ seat, count }))
            .sort((a, b) => b.count - a.count);
    }
    broadcastWolfVotes(room) {
        this.broadcastToWolves(room, {
            type: 'wolfVotes',
            votes: this.wolfVoteSummary(room),
        });
    }
    /** 新连接恢复：补发中性夜晚阶段；仅当该连接本人是当前行动角色时，才补发带身份的阶段与其私密面板 */
    sendNightPhaseToConn(room, conn) {
        const playerId = room.connToPlayer.get(conn.id);
        if (!playerId)
            return;
        const seat = room.gameState.seats.find((s) => s.playerId === playerId);
        if (!seat)
            return;
        const phase = NIGHT_PHASE_ORDER[room.gameState.nightStepIndex];
        if (!phase)
            return;
        // 所有人都只收到中性帧
        conn.send(JSON.stringify({
            type: 'nightPhase',
            stepIndex: room.gameState.nightStepIndex,
        }));
        // 只有当前行动角色本人，才补发带 roleKey 的阶段帧 + 私密面板
        const isCurrentActor = (phase.roleKey === 'wolf' && seat.camp === 'wolf') ||
            (phase.roleKey !== 'wolf' && seat.roleKey === phase.roleKey);
        if (!isCurrentActor)
            return;
        conn.send(JSON.stringify({
            type: 'nightPhase',
            stepIndex: room.gameState.nightStepIndex,
            roleKey: phase.roleKey,
            label: phase.label,
            requiredAction: phase.requiredAction,
            disabled: this.isNightmareTarget(room, phase.roleKey),
        }));
        if (room.gameState.currentPhase === 'wolf' && seat.camp === 'wolf') {
            conn.send(JSON.stringify({
                type: 'wolfPanel',
                wolfSeats: this.phasePlayers(room, 'wolf').map((s) => s.seat),
                wolfChat: room.wolfChat,
                wolfVotes: this.wolfVoteSummary(room),
                seats: room.gameState.seats.map(({ seat: s, playerId: pid, nickname }) => ({
                    seat: s,
                    playerId: pid,
                    nickname,
                })),
            }));
        }
        else if (room.gameState.currentPhase === 'witch' && seat.roleKey === 'witch') {
            conn.send(JSON.stringify({
                type: 'witchInfo',
                target: room.gameState.wolfTarget,
                saveUsed: room.gameState.witchSaved,
                poisonUsed: room.gameState.witchPoisoned,
            }));
        }
    }
    // ---- 广播工具 ----
    sendToPlayer(room, playerId, msg) {
        const connId = room.playerConns.get(playerId);
        const conn = connId ? room.conns.get(connId) : undefined;
        if (conn)
            conn.send(JSON.stringify(msg));
    }
    broadcastToWolves(room, msg) {
        for (const seat of room.gameState.seats) {
            if (seat.camp === 'wolf') {
                // 首夜噩梦之影与其他狼人互不知身份：狼队列表只显示自己，票数隐藏
                if (room.gameState.dayIndex === 1 && seat.roleKey === 'nightmare') {
                    const m = msg;
                    this.sendToPlayer(room, seat.playerId, {
                        ...m,
                        wolfSeats: [seat.seat],
                        wolfVotes: [],
                    });
                    continue;
                }
                this.sendToPlayer(room, seat.playerId, msg);
            }
        }
    }
    snapshot(room) {
        return [...room.players.entries()].map(([playerId, info]) => ({
            playerId,
            nickname: info.nickname,
            ready: info.ready,
            seat: info.seat ?? null,
            avatarIdx: info.avatarIdx ?? null,
        }));
    }
    broadcastRoster(room) {
        this.broadcastToRoom(room, {
            type: 'roster',
            players: this.snapshot(room),
            hostPlayerId: room.hostPlayerId,
        });
    }
    publicGameStartedMessage(room) {
        return {
            type: 'gameStarted',
            boardName: room.gameState.boardName,
            playerCount: room.gameState.playerCount,
            seats: room.gameState.seats.map(({ seat, playerId, nickname }) => ({
                seat,
                playerId,
                nickname,
                avatarIdx: room.players.get(playerId)?.avatarIdx ?? null,
            })),
        };
    }
    /** 计算单个玩家的语音权限（纯函数，从当前游戏状态推导；仅单播给本人，不泄露他人身份）。
     *  白天顺序麦：只有 currentSpeaker 能解除静音，其他存活玩家强制闭麦。
     *  夜晚狼人刀人环节：
     *    - 存活狼人：自动开麦互听；听不到死亡频道。
     *    - 存活好人：强制闭麦；听不到任何狼人。
     *    - 死亡玩家：进入死亡频道，全程可开麦聊天，存活玩家绝对听不到。
     *    - 死狼：可单向听到活狼讨论，但死狼说话活狼听不到（防诈尸）。
     *    - 死好人：绝对不能听到活狼讨论，只能和死狼在死亡频道聊天。
     *  夜晚神职行动环节：所有存活玩家（含狼人）强制闭麦，只能点面板；死亡玩家继续死亡频道。 */
    computeVoicePerm(room, seat) {
        const gs = room.gameState;
        const dead = gs.deadSeats;
        const meDead = dead.includes(seat.seat);
        const isWolf = seat.camp === 'wolf';
        const wolfPhase = gs.phase === 'night' && gs.currentPhase === 'wolf';
        const dayTalk = gs.phase === 'day' &&
            (gs.dayStage === 'talk' || gs.dayStage === 'sheriffTalk');
        const others = gs.seats.filter((s) => s.playerId !== seat.playerId);
        const aliveWolves = others.filter((s) => s.camp === 'wolf' && !dead.includes(s.seat));
        const deadOthers = others.filter((s) => dead.includes(s.seat));
        const aliveOthers = others.filter((s) => !dead.includes(s.seat));
        // 大厅 / 游戏结束：全员自由麦（前端用"按住说话"PTT 控制本地开关；复盘交流全员互听）
        if (gs.phase === 'lobby' || gs.phase === 'over') {
            return {
                canSpeak: true,
                canHearWolves: false,
                isDeadChannel: false,
                hearUserIds: others.map((s) => s.playerId),
            };
        }
        if (meDead) {
            return {
                canSpeak: true,
                canHearWolves: isWolf && wolfPhase,
                isDeadChannel: true,
                hearUserIds: [
                    ...deadOthers.map((s) => s.playerId),
                    // 死狼单向收听活狼讨论（防诈尸：反过来活狼听不到死狼）
                    ...(isWolf && wolfPhase ? aliveWolves.map((s) => s.playerId) : []),
                ],
            };
        }
        // 存活
        if (wolfPhase) {
            return {
                canSpeak: isWolf,
                canHearWolves: isWolf,
                isDeadChannel: false,
                // 存活狼人只听其他存活狼人（绝听不到死亡频道）
                hearUserIds: isWolf ? aliveWolves.map((s) => s.playerId) : [],
            };
        }
        return {
            canSpeak: dayTalk ? seat.seat === (gs.speakerOrder[gs.speakerIndex] ?? null) : false,
            canHearWolves: false,
            isDeadChannel: false,
            // 白天存活玩家互听（谁能说话由 currentSpeaker 服务端控制）
            hearUserIds: aliveOthers.map((s) => s.playerId),
        };
    }
    /** 把最新语音权限单播给每个玩家（含死亡玩家），前端据此控制 TRTC 麦克风与远端静音 */
    updateVoicePermissions(room) {
        const gs = room.gameState;
        for (const seat of gs.seats) {
            const perm = this.computeVoicePerm(room, seat);
            gs.voicePerm[seat.playerId] = perm;
            this.sendToPlayer(room, seat.playerId, {
                type: 'voicePerm',
                phase: gs.phase,
                dayStage: gs.dayStage,
                currentPhase: gs.currentPhase,
                currentSpeaker: gs.speakerOrder[gs.speakerIndex] ?? null,
                ...perm,
            });
        }
        // 观战者：始终死亡频道，只听不说（参考已淘汰玩家听取语音）
        for (const [pid, info] of room.players.entries()) {
            if (!info.isSpectator) continue;
            this.sendToPlayer(room, pid, {
                type: 'voicePerm',
                phase: gs.phase,
                dayStage: gs.dayStage,
                currentPhase: gs.currentPhase,
                currentSpeaker: gs.speakerOrder[gs.speakerIndex] ?? null,
                canSpeak: false,
                canHearWolves: false,
                isDeadChannel: true,
                hearUserIds: gs.seats.filter((s) => gs.deadSeats.includes(s.seat)).map((s) => s.playerId),
            });
        }
    }
    /** 只向当前房间内的连接广播（dev 下 party 级 broadcast 会串房，必须按房间 conns 隔离） */
    broadcastToRoom(room, msg) {
        const json = JSON.stringify(msg);
        for (const conn of room.conns.values()) {
            conn.send(json);
        }
    }
    broadcastGameStarted(room) {
        this.broadcastToRoom(room, this.publicGameStartedMessage(room));
    }
}
