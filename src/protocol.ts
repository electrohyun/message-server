export interface Participant {
  id: string
  name: string
}

export interface Room {
  id: string
  name: string
  description: string
  participants: Participant[]
}

export type Delivery = 'room' | 'others' | 'private' | 'notice'

export interface Message {
  id: string
  requestId: string
  sender: Participant
  text: string
  sentAt: string
  delivery: Delivery
  roomId: string | null
  recipient?: Participant
}

export interface SendMessage {
  requestId: string
  text: string
  delivery: Delivery
  recipientId?: string
}

export interface Marker {
  id: string
  sentAt: string
}

export type AckResult<T> = { ok: true; data: T } | { ok: false; error: string }
export type Acknowledge<T> = (result: AckResult<T>) => void
export interface AckCheck {
  value: string
  connectionId: string
}

export interface ClientToServerEvents {
  'session:info': (ack: Acknowledge<Participant>) => void
  'rooms:list': (ack: Acknowledge<Room[]>) => void
  'rooms:create': (request: { name: string }, ack: Acknowledge<Room>) => void
  'rooms:join': (request: { roomId: string }, ack: Acknowledge<Room>) => void
  'rooms:leave': (ack: Acknowledge<{ roomId: string | null }>) => void
  'message:send': (request: SendMessage, ack: Acknowledge<Message>) => void
  'ack:check': (request: { value: string }, ack: Acknowledge<AckCheck>) => void
  'diagnostics:marker': (ack: Acknowledge<Marker>) => void
  'demo:reset': (ack: Acknowledge<{ reset: true }>) => void
}

export interface ServerToClientEvents {
  'session:ready': (participant: Participant) => void
  'rooms:changed': (rooms: Room[]) => void
  'users:changed': (users: Participant[]) => void
  'message:received': (message: Message) => void
  'diagnostics:marker': (marker: Marker) => void
  'demo:reset': () => void
}

export interface ConnectionData {
  name: string
  roomId?: string
}
