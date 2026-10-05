import { describe, expect, it } from 'vitest'
import { originAllowed } from './rpc-channel.ts'

describe('originAllowed (channel cross-origin gate)', () => {
  it('accepts a missing Origin (non-browser clients; Host sanity already ran)', () => {
    expect(originAllowed(undefined, '127.0.0.1:19387')).toBe(true)
  })

  it('accepts an http(s) Origin matching the Host authority', () => {
    expect(originAllowed('http://127.0.0.1:19387', '127.0.0.1:19387')).toBe(true)
    expect(originAllowed('https://dsh.example', 'dsh.example')).toBe(true)
  })

  it('rejects an http(s) Origin from another site', () => {
    expect(originAllowed('https://evil.example', '127.0.0.1:19387')).toBe(false)
    expect(originAllowed('http://127.0.0.1:19387', '127.0.0.1:3080')).toBe(false)
  })

  it('accepts a custom-scheme Origin (Desktop surface dsh-*://)', () => {
    expect(originAllowed('dsh-app://app', '127.0.0.1:19387')).toBe(true)
    expect(originAllowed('dsh-web://app', '127.0.0.1:19387')).toBe(true)
  })

  it('rejects an unparseable Origin and an http Origin without a Host', () => {
    expect(originAllowed('not a url', '127.0.0.1:19387')).toBe(false)
    expect(originAllowed('http://127.0.0.1:19387', undefined)).toBe(false)
  })
})