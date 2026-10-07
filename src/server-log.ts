import { inspect } from 'node:util'

export type ServerLogKind = 'REQUEST' | 'CONNECT' | 'CREATE' | 'JOIN' | 'LEAVE' | 'CLOSE' | 'UPDATE' | 'SEND' | 'ACK' | 'MARKER' | 'RESET' | 'REJECT' | 'ERROR' | 'READY' | 'INFO'
export interface ServerLog {
  kind: ServerLogKind
  caseId: string
  summary: string
  details: Record<string, unknown>
}
export interface ServerLogBlock {
  caseId: string
  title: string
  entries: ServerLog[]
}
export type ServerLogOutput = ServerLog | ServerLogBlock
export type ServerLogger = (output: ServerLogOutput) => void

const backgrounds: Record<ServerLogKind, number> = {
  REQUEST: 44, CONNECT: 42, CREATE: 42, JOIN: 42, LEAVE: 100, CLOSE: 100,
  UPDATE: 44, SEND: 44, ACK: 42, MARKER: 44, RESET: 45, REJECT: 43,
  ERROR: 41, READY: 42, INFO: 100,
}

export function createTerminalLogger(): ServerLogger {
  const useColor = process.env.NO_COLOR === undefined
    && (Boolean(process.stdout.isTTY) || (process.env.FORCE_COLOR !== undefined && process.env.FORCE_COLOR !== '0'))
  const showDetails = process.env.SERVER_LOG_DETAILS === '1'
  const paint = (text: string, style: string) => useColor ? '\x1b[' + style + 'm' + text + '\x1b[0m' : text

  function entryLines(entry: ServerLog, grouped: boolean): string[] {
    const badge = paint(' ' + entry.kind.padEnd(7) + ' ', '1;37;' + backgrounds[entry.kind])
    const code = grouped ? '' : paint(entry.caseId.padEnd(6), '36') + ' '
    const summary = entry.summary.replace(/[\r\n\t]/g, ' ')
    const lines = [(grouped ? '  ' : '') + badge + ' ' + code + summary]
    if (showDetails && Object.keys(entry.details).length) {
      const details = inspect(entry.details, { depth: null, colors: useColor, compact: false })
      lines.push('    상세 정보', ...details.split('\n').map((line) => '      ' + line))
    }
    return lines
  }

  return (output) => {
    if ('entries' in output) {
      const heading = [output.caseId, output.title].filter(Boolean).join(' ').replace(/[\r\n\t]/g, ' ')
      const lines = [paint('── ' + heading + ' ──', '36')]
      for (const entry of output.entries) lines.push(...entryLines(entry, true))
      lines.push('')
      const write = output.entries.some((entry) => entry.kind === 'ERROR') ? console.error : console.info
      // Write the complete block at once so concurrent operations cannot mix rows.
      write(lines.join('\n'))
    } else {
      const write = output.kind === 'ERROR' ? console.error : console.info
      write(entryLines(output, false).join('\n'))
    }
  }
}
