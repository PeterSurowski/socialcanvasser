import { EventEmitter } from 'events'

type Payload = { type: string; text: string; url?: string; meta?: any }

const emitter = new EventEmitter()

export function sendUserEvent(userId: number, payload: Payload) {
  emitter.emit(String(userId), payload)
}

export function subscribe(userId: number, handler: (p: Payload) => void) {
  const key = String(userId)
  const fn = (p: Payload) => handler(p)
  emitter.on(key, fn)
  return () => emitter.off(key, fn)
}

export default emitter
