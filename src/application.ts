import type {
  Acknowledge, ClientToServerEvents, ConnectionData, Message, Participant,
  Room, ServerToClientEvents,
} from './protocol.js'
import type { ServerLog, ServerLogKind, ServerLogger } from './server-log.js'

interface MessageEmitter {
  emit<Event extends keyof ServerToClientEvents>(
    event: Event,
    ...args: Parameters<ServerToClientEvents[Event]>
  ): unknown
}

// Only the public Socket.IO-shaped methods actually used by this application.
// Both server bootstraps pass their real objects here without casting them.
interface ApplicationSocket extends MessageEmitter {
  readonly id: string
  readonly connected: boolean
  readonly handshake: { auth: Record<string, unknown> }
  readonly rooms: Set<string>
  data: ConnectionData
  join(room: string): void | Promise<void>
  leave(room: string): void | Promise<void>
  to(room: string): MessageEmitter
  disconnect(): unknown
  on(event: 'session:info', listener: ClientToServerEvents['session:info']): unknown
  on(event: 'rooms:list', listener: ClientToServerEvents['rooms:list']): unknown
  on(event: 'rooms:create', listener: ClientToServerEvents['rooms:create']): unknown
  on(event: 'rooms:join', listener: ClientToServerEvents['rooms:join']): unknown
  on(event: 'rooms:leave', listener: ClientToServerEvents['rooms:leave']): unknown
  on(event: 'message:send', listener: ClientToServerEvents['message:send']): unknown
  on(event: 'ack:check', listener: ClientToServerEvents['ack:check']): unknown
  on(event: 'diagnostics:marker', listener: ClientToServerEvents['diagnostics:marker']): unknown
  on(event: 'demo:reset', listener: ClientToServerEvents['demo:reset']): unknown
  on(event: 'disconnect', listener: (reason: string) => void): unknown
}

export interface ApplicationServer extends MessageEmitter {
  use(handler: (socket: ApplicationSocket, next: (error?: Error) => void) => void): unknown
  on(event: 'connection', handler: (socket: ApplicationSocket) => void): unknown
  to(room: string): MessageEmitter
}

type RoomDefinition = Omit<Room, 'participants'>
const membership = (roomId: string) => 'chat:' + roomId

function defaultRooms(): Map<string, RoomDefinition> {
  return new Map([
    ['general', { id: 'general', name: '기본 대화방', description: '가볍게 인사하고 대화를 나눠보세요.' }],
    ['development', { id: 'development', name: '개발 이야기', description: '개발하면서 나누고 싶은 이야기를 남겨보세요.' }],
  ])
}

/** Both projects keep this handler body and protocol.ts in sync. */
export function registerMessageApplication(io: ApplicationServer, writeLog: ServerLogger): void {
  const sockets = new Map<string, ApplicationSocket>()
  let rooms = defaultRooms()
  let nextRoom = 1
  let nextMarker = 1

  type LogWriter = (kind: ServerLogKind, caseId: string, summary: string, details?: Record<string, unknown>) => void

  function startLogBlock(caseId: string, title: string) {
    const entries: ServerLog[] = []
    let finished = false
    const log: LogWriter = (kind, itemCaseId, summary, details = {}) => {
      entries.push({ kind, caseId: itemCaseId, summary, details: JSON.parse(JSON.stringify(details)) as Record<string, unknown> })
    }
    return {
      log,
      finish(finalCaseId = caseId, finalTitle = title) {
        if (finished) return
        finished = true
        if (entries.length) writeLog({ caseId: finalCaseId, title: finalTitle, entries })
      },
    }
  }

  function withLogBlock<T>(caseId: string, title: string, action: (log: LogWriter) => T): T {
    const block = startLogBlock(caseId, title)
    try { return action(block.log) } finally { block.finish() }
  }

  const admissionLogs = new WeakMap<ApplicationSocket, ReturnType<typeof startLogBlock>>()

  function roomLabel(roomId: string) {
    return '‘' + (rooms.get(roomId)?.name ?? roomId) + '’'
  }

  function messagePreview(text: string) {
    const singleLine = text.replace(/\s+/g, ' ')
    return '“' + singleLine.slice(0, 60) + (singleLine.length > 60 ? '…' : '') + '”'
  }

  function participant(socket: ApplicationSocket): Participant {
    return { id: socket.id, name: socket.data.name }
  }

  function roomSnapshot(room: RoomDefinition): Room {
    return {
      ...room,
      participants: [...sockets.values()]
        .filter((socket) => socket.connected && socket.rooms.has(membership(room.id)))
        .map(participant),
    }
  }

  function listRooms(): Room[] {
    return [...rooms.values()].map(roomSnapshot)
  }

  function publishRooms(caseId: string, log: LogWriter) {
    const snapshot = listRooms()
    io.emit('rooms:changed', snapshot)
    log('UPDATE', caseId, '방 목록 갱신 | ' + snapshot.length + '개 방 | 접속자 ' + [...sockets.values()].filter((socket) => socket.connected).length + '명', { rooms: snapshot })
  }

  function publishUsers() {
    io.emit('users:changed', [...sockets.values()].filter((socket) => socket.connected).map(participant))
  }

  io.use((socket, next) => {
    const name = typeof socket.handshake.auth.name === 'string' ? socket.handshake.auth.name.trim() : ''
    const token = socket.handshake.auth.token
    const block = startLogBlock('A-01', '접속 | ' + (name || '이름 없음'))
    const log = block.log
    log('REQUEST', 'A-02', (name || '이름 없음') + '의 접속 요청', { connectionId: socket.id, name, token })
    if (!name || name.length > 24) {
      log('REJECT', 'A-03', '접속 거절 | 이름은 1~24자로 입력해주세요.', { connectionId: socket.id, name, reason: '이름은 1~24자로 입력해주세요.' })
      next(new Error('이름은 1~24자로 입력해주세요.'))
      block.finish('A-03', '접속 거절 | ' + (name || '이름 없음'))
      return
    }
    if (token !== 'demo-token') {
      log('REJECT', 'A-03', name + ' 접속 거절 | 테스트용 토큰이 올바르지 않습니다.', { connectionId: socket.id, name, reason: '테스트용 토큰이 올바르지 않습니다.' })
      next(new Error('테스트용 토큰이 올바르지 않습니다.'))
      block.finish('A-03', '접속 거절 | ' + (name || '이름 없음'))
      return
    }
    socket.data.name = name
    admissionLogs.set(socket, block)
    next()
  })

  io.on('connection', (socket) => {
    const startupLog = admissionLogs.get(socket) ?? startLogBlock('A-01', '접속 | ' + socket.data.name)
    admissionLogs.delete(socket)
    const log = startupLog.log
    sockets.set(socket.id, socket)
    log('CONNECT', 'A-01', socket.data.name + ' 접속 수락', { participant: participant(socket), rooms: [...socket.rooms] })

    // Join/leave operations are serialized by the app so rapid requests cannot
    // complete against a different room from the one the UI is showing.
    let operations = Promise.resolve()
    function enqueue<T>(caseId: string, title: string, ack: Acknowledge<T>, action: (log: LogWriter) => Promise<void>) {
      operations = operations.then(async () => {
        if (!socket.connected) return
        const block = startLogBlock(caseId, title)
        const log = block.log
        log('REQUEST', caseId, socket.data.name + '의 ' + title.split(' | ')[0] + ' 요청')
        try {
          await action(log)
        } catch (error) {
          const message = error instanceof Error ? error.message : '요청을 처리하지 못했습니다.'
          log('ERROR', 'APP', socket.data.name + ' 요청 처리 실패 | ' + message, { connectionId: socket.id, error: message })
          if (socket.connected) ack({ ok: false, error: message })
        } finally {
          block.finish()
        }
      })
    }

    async function leaveCurrentRoom(caseId: string, log: LogWriter): Promise<string | null> {
      const oldRoomId = socket.data.roomId ?? null
      if (oldRoomId) {
        await socket.leave(membership(oldRoomId))
        delete socket.data.roomId
        log('LEAVE', caseId, socket.data.name + ' → ' + roomLabel(oldRoomId) + ' 방 퇴장', { connectionId: socket.id, roomId: oldRoomId, rooms: [...socket.rooms] })
      }
      return oldRoomId
    }

    socket.on('session:info', (ack) => {
      withLogBlock('A-02', '사용자 정보 | ' + socket.data.name, (log) => {
        ack({ ok: true, data: participant(socket) })
        log('ACK', 'A-02', socket.data.name + '에게 사용자 정보 응답', { participant: participant(socket) })
      })
    })

    socket.on('rooms:list', (ack) => {
      withLogBlock('B-01', '방 목록 | ' + socket.data.name, (log) => {
        const snapshot = listRooms()
        ack({ ok: true, data: snapshot })
        log('ACK', 'B-01', socket.data.name + '에게 방 목록 응답 | ' + snapshot.length + '개 방', { connectionId: socket.id, rooms: snapshot })
      })
    })

    socket.on('rooms:create', (request, ack) => {
      enqueue('B-05', '새 방 생성 | ' + socket.data.name, ack, async (log) => {
        const name = typeof request?.name === 'string' ? request.name.trim() : ''
        if (!name || name.length > 32) {
          log('REJECT', 'B-05', socket.data.name + ' 요청 거절 | 방 이름은 1~32자로 입력해주세요.', { connectionId: socket.id, reason: '방 이름은 1~32자로 입력해주세요.' })
          ack({ ok: false, error: '방 이름은 1~32자로 입력해주세요.' })
          return
        }
        await leaveCurrentRoom('B-05', log)
        if (!socket.connected) return
        const room: RoomDefinition = { id: 'room-' + nextRoom++, name, description: '새로 만든 대화방이에요.' }
        rooms.set(room.id, room)
        await socket.join(membership(room.id))
        if (!socket.connected) return
        socket.data.roomId = room.id
        log('CREATE', 'B-05', socket.data.name + ' → ' + roomLabel(room.id) + ' 방 생성 및 입장', { connectionId: socket.id, room })
        publishRooms('B-05', log)
        ack({ ok: true, data: roomSnapshot(room) })
        log('ACK', 'B-05', socket.data.name + '에게 방 생성 응답', { connectionId: socket.id, roomId: room.id })
      })
    })

    socket.on('rooms:join', (request, ack) => {
      enqueue('B-02', '방 입장 | ' + socket.data.name, ack, async (log) => {
        const room = rooms.get(request?.roomId)
        if (!room) {
          log('REJECT', 'B-02', socket.data.name + ' 요청 거절 | 찾을 수 없는 대화방입니다. 목록을 새로고침해주세요.', { connectionId: socket.id, reason: '찾을 수 없는 대화방입니다. 목록을 새로고침해주세요.' })
          ack({ ok: false, error: '찾을 수 없는 대화방입니다. 목록을 새로고침해주세요.' })
          return
        }
        await leaveCurrentRoom('B-02', log)
        if (!socket.connected) return
        await socket.join(membership(room.id))
        if (!socket.connected) return
        socket.data.roomId = room.id
        log('JOIN', 'B-02', socket.data.name + ' → ' + roomLabel(room.id) + ' 방 입장 | 참가자 ' + roomSnapshot(room).participants.length + '명', { connectionId: socket.id, roomId: room.id, rooms: [...socket.rooms] })
        publishRooms('B-03', log)
        ack({ ok: true, data: roomSnapshot(room) })
        log('ACK', 'B-02', socket.data.name + '에게 방 입장 응답', { connectionId: socket.id, roomId: room.id })
      })
    })

    socket.on('rooms:leave', (ack) => {
      enqueue('C-08', '방 퇴장 | ' + socket.data.name, ack, async (log) => {
        const roomId = await leaveCurrentRoom('C-08', log)
        if (!socket.connected) return
        publishRooms('B-03', log)
        ack({ ok: true, data: { roomId } })
      })
    })

    socket.on('message:send', (request, ack) => {
      const cases: Record<string, string> = { room: 'C-01', others: 'C-02', private: 'C-03', notice: 'C-04' }
      const titles: Record<string, string> = { room: '방 메시지 전달', others: '송신자 제외', private: '개인 메시지', notice: '전체 공지' }
      const caseId = cases[request?.delivery] ?? 'C-05'
      const title = titles[request?.delivery] ?? '메시지 요청'
      withLogBlock(caseId, title + ' | ' + socket.data.name, (log) => {
        const text = typeof request?.text === 'string' ? request.text.trim() : ''
        if (!text || text.length > 2000 || typeof request?.requestId !== 'string' || !request.requestId || request.requestId.length > 80) {
          log('REJECT', 'C-05', socket.data.name + ' 요청 거절 | 메시지는 1~2000자로 입력해주세요.', { connectionId: socket.id, reason: '메시지는 1~2000자로 입력해주세요.' })
          ack({ ok: false, error: '메시지는 1~2000자로 입력해주세요.' })
          return
        }
        if (!['room', 'others', 'private', 'notice'].includes(request.delivery)) {
          log('REJECT', 'C-05', socket.data.name + ' 요청 거절 | 지원하지 않는 전달 방식입니다.', { connectionId: socket.id, reason: '지원하지 않는 전달 방식입니다.' })
          ack({ ok: false, error: '지원하지 않는 전달 방식입니다.' })
          return
        }
        const roomId = socket.data.roomId ?? null
        if (!roomId || !rooms.has(roomId) || !socket.rooms.has(membership(roomId))) {
          log('REJECT', 'C-05', socket.data.name + ' 요청 거절 | 먼저 대화방에 입장해주세요.', { connectionId: socket.id, reason: '먼저 대화방에 입장해주세요.' })
          ack({ ok: false, error: '먼저 대화방에 입장해주세요.' })
          return
        }
        const recipient = request.delivery === 'private' ? sockets.get(request.recipientId ?? '') : undefined
        if (request.delivery === 'private' && (!recipient?.connected || recipient.id === socket.id)) {
          log('REJECT', 'C-03', socket.data.name + ' 요청 거절 | 접속 중인 다른 수신자를 선택해주세요.', { connectionId: socket.id, reason: '접속 중인 다른 수신자를 선택해주세요.' })
          ack({ ok: false, error: '접속 중인 다른 수신자를 선택해주세요.' })
          return
        }
        const message: Message = {
          id: socket.id + ':' + request.requestId,
          requestId: request.requestId,
          sender: participant(socket),
          text,
          sentAt: new Date().toISOString(),
          delivery: request.delivery,
          roomId,
          ...(recipient ? { recipient: participant(recipient) } : {}),
        }
        log('REQUEST', caseId, socket.data.name + '의 메시지 전송 요청', { connectionId: socket.id, message })
        if (request.delivery === 'room') io.to(membership(roomId)).emit('message:received', message)
        if (request.delivery === 'others') socket.to(membership(roomId)).emit('message:received', message)
        if (request.delivery === 'private' && recipient) io.to(recipient.id).emit('message:received', message)
        if (request.delivery === 'notice') io.emit('message:received', message)
        const destination = request.delivery === 'notice' ? '전체 공지' : request.delivery === 'private' ? (recipient?.data.name ?? '수신자') + '에게 개인 메시지' : roomLabel(roomId) + ' 방 ' + (request.delivery === 'others' ? '송신자 제외' : '전체')
        log('SEND', caseId, socket.data.name + ' → ' + destination + ' 전송 | ' + messagePreview(text), { messageId: message.id, roomId, delivery: request.delivery, recipientId: recipient?.id })
        ack({ ok: true, data: message })
        log('ACK', 'C-05', socket.data.name + '에게 메시지 전송 응답', { connectionId: socket.id, messageId: message.id })
      })
    })

    socket.on('ack:check', (request, ack) => {
      withLogBlock('C-05', '서버 응답 확인 | ' + socket.data.name, (log) => {
        const value = typeof request?.value === 'string' ? request.value : ''
        const data = { value, connectionId: socket.id }
        log('REQUEST', 'C-05', socket.data.name + '의 ACK 확인 요청', data)
        ack({ ok: true, data })
        log('ACK', 'C-05', socket.data.name + '에게 ACK 확인 응답', data)
      })
    })

    socket.on('diagnostics:marker', (ack) => {
      withLogBlock('', '후속 확인 이벤트 | ' + socket.data.name, (log) => {
        const marker = { id: 'marker-' + nextMarker++, sentAt: new Date().toISOString() }
        for (const target of sockets.values()) {
          if (target.connected) target.emit('diagnostics:marker', marker)
        }
        log('MARKER', '', marker.id + ' → 사용자 ' + [...sockets.values()].filter((target) => target.connected).length + '명에게 전송', { marker, recipients: [...sockets.keys()] })
        ack({ ok: true, data: marker })
      })
    })

    socket.on('demo:reset', (ack) => {
      const block = startLogBlock('', '전체 초기화 | ' + socket.data.name)
      const log = block.log
      const targets = [...sockets.values()]
      // Acknowledge and notify before tearing down each connection.
      ack({ ok: true, data: { reset: true } })
      io.emit('demo:reset')
      rooms = defaultRooms()
      nextRoom = 1
      nextMarker = 1
      log('RESET', '', '기본 방과 기록 초기화 | 사용자 ' + targets.length + '명 접속 종료', { recipients: targets.map((target) => target.id) })
      block.finish()
      for (const target of targets) target.disconnect()
    })

    socket.on('disconnect', (reason) => {
      withLogBlock('B-04', '접속 종료 | ' + socket.data.name, (log) => {
        const previousRoomId = socket.data.roomId ?? null
        sockets.delete(socket.id)
        delete socket.data.roomId
        log('CLOSE', 'B-04', socket.data.name + ' 접속 종료 | 방 멤버십 정리', { connectionId: socket.id, previousRoomId, reason, rooms: [...socket.rooms] })
        publishRooms('B-04', log)
        publishUsers()
      })
    })

    socket.emit('session:ready', participant(socket))
    publishRooms('B-01', log)
    publishUsers()
    startupLog.finish()
  })
}
