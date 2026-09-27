/**
 * Pseudonymizer, extracted from redact.ts so the benchmark can measure token
 * minting without importing the canvas/WebGPU surface. The implementation is
 * byte-identical to the one in redact.ts — keep them in sync.
 *
 * If you change this, change that one too, and re-run bench/measure_client_cpu.ts.
 */
import type { PiiClass } from '../lib/schema'

export interface PseudoEntry {
  token: string
  cls: PiiClass
}

export class Pseudonymizer {
  private map = new Map<string, PseudoEntry>()
  private counters = new Map<string, number>()
  private salt: string

  constructor(sessionId: string) {
    this.salt = `${sessionId}:${Math.random().toString(36).slice(2)}`
  }

  private hash(s: string): string {
    let h = 0x811c9dc5
    const input = this.salt + s.toLowerCase().replace(/\s+/g, ' ').trim()
    for (let i = 0; i < input.length; i++) {
      h ^= input.charCodeAt(i)
      h = Math.imul(h, 0x01000193) >>> 0
    }
    return h.toString(16).padStart(8, '0')
  }

  tokenFor(value: string, cls: PiiClass): PseudoEntry {
    const key = `${cls}:${this.hash(value)}`
    const found = this.map.get(key)
    if (found) return found
    if (cls === 'PASSWORD') {
      const t: PseudoEntry = { token: '[PASSWORD]', cls }
      this.map.set(key, t)
      return t
    }
    const n = (this.counters.get(cls) ?? 0) + 1
    this.counters.set(cls, n)
    const t: PseudoEntry = { token: `[${cls}_${n}]`, cls }
    this.map.set(key, t)
    return t
  }

  issued(): string[] {
    return [...this.map.values()].map((v) => v.token)
  }
}
