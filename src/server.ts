import express from 'express'
import { createServer } from 'node:http'
import { Server } from 'socket.io'
import { registerMessageApplication } from './application.js'
import { createTerminalLogger } from './server-log.js'
import type { ClientToServerEvents, ConnectionData, ServerToClientEvents } from './protocol.js'

const port = Number(process.env.PORT ?? 3001)
const host = process.env.HOST ?? '127.0.0.1'
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT must be an integer from 1 to 65535.')

const app = express()
const httpServer = createServer(app)
const allowedOrigins = [
  'http://127.0.0.1:5173',
  'http://localhost:5173',
  ...(process.env.CLIENT_ORIGIN ? process.env.CLIENT_ORIGIN.split(',').map((origin) => origin.trim()) : []),
]
const io = new Server<ClientToServerEvents, ServerToClientEvents, Record<string, never>, ConnectionData>(httpServer, {
  cors: { origin: allowedOrigins },
})

const log = createTerminalLogger()
registerMessageApplication(io, log)
app.get('/health', (_request, response) => response.json({ ok: true, mode: 'real' }))

httpServer.listen(port, host, () => {
  log({ kind: 'READY', caseId: '', summary: '메시지 서버: http://' + host + ':' + port, details: {} })
  log({ kind: 'INFO', caseId: '', summary: '테스트용 토큰: demo-token', details: {} })
})

httpServer.on('error', (error) => {
  log({ kind: 'ERROR', caseId: '', summary: '서버를 시작하지 못했습니다. | ' + error.message, details: {} })
  process.exitCode = 1
})

function shutdown() {
  log({ kind: 'CLOSE', caseId: '', summary: '서버 종료', details: {} })
  io.close()
}
process.once('SIGINT', shutdown)
process.once('SIGTERM', shutdown)
