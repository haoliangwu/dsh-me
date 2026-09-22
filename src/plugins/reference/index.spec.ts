import { describe, expect, it } from 'vitest'
import { Config, Schema } from './index.ts'

describe('Config schema', () => {
  it('defaults the refresh policy to missing-only without cacheDir', () => {
    expect(Config({})).toEqual({ refresh: 'missing-only' })
  })

  it('passes cacheDir and an explicit refresh through', () => {
    expect(Config({ cacheDir: '/var/cache/refs' })).toEqual({ cacheDir: '/var/cache/refs', refresh: 'missing-only' })
    expect(Config({ cacheDir: '~/refs', refresh: 'always' })).toEqual({ cacheDir: '~/refs', refresh: 'always' })
  })

  it('rejects a refresh outside the const-union', () => {
    expect(() => Config({ refresh: 'sometimes' })).toThrow()
  })
})

describe('reference-table schema (settings namespace)', () => {
  it('defaults to an empty table', () => {
    expect(Schema({})).toEqual({})
    expect(Schema(undefined)).toEqual({})
  })

  it('accepts a legal local entry (path + optional description/hidden)', () => {
    expect(Schema({ docs: { path: '/Users/u/docs' } })).toEqual({ docs: { path: '/Users/u/docs' } })
    expect(Schema({ docs: { path: '~/docs', description: '产品文档库', hidden: true } })).toEqual({
      docs: { path: '~/docs', description: '产品文档库', hidden: true },
    })
  })

  it('accepts a legal git entry (repository + optional branch/refresh)', () => {
    expect(Schema({ repo: { repository: 'https://x/y.git' } })).toEqual({ repo: { repository: 'https://x/y.git' } })
    expect(Schema({ repo: { repository: 'https://x/y.git', branch: 'main', refresh: 'always', description: 'Y', hidden: true } })).toEqual({
      repo: { repository: 'https://x/y.git', branch: 'main', refresh: 'always', description: 'Y', hidden: true },
    })
  })

  it('rejects an invalid alias', () => {
    expect(() => Schema({ 'bad/alias': { path: '/x' } })).toThrow(/alias「bad\/alias」不能包含/)
    expect(() => Schema({ '': { path: '/x' } })).toThrow(/alias「」不能为空/)
  })

  it('rejects a relative path', () => {
    expect(() => Schema({ docs: { path: 'docs/x' } })).toThrow(/必须用绝对路径或 ~\/ 开头/)
  })

  it('rejects an entry with neither form (no path, no repository)', () => {
    expect(() => Schema({ docs: { description: 'd' } })).toThrow(/必须二选一/)
  })

  it('rejects an entry mixing both forms', () => {
    expect(() => Schema({ docs: { path: '/x', repository: 'https://x/y.git' } })).toThrow(/必须二选一/)
  })

  it('rejects a file:// repository', () => {
    expect(() => Schema({ repo: { repository: 'file:///tmp/r' } })).toThrow(/file:\/\//)
  })

  it('rejects a non-string branch', () => {
    expect(() => Schema({ repo: { repository: 'https://x/y.git', branch: 7 } })).toThrow(/branch/)
  })

  it('rejects a non-object entry', () => {
    expect(() => Schema({ docs: '/plain-string' })).toThrow(/expected object/)
  })

  it('rejects a non-string path', () => {
    expect(() => Schema({ docs: { path: 7 } })).toThrow(/expected string/)
  })

  it('rejects a non-string description', () => {
    expect(() => Schema({ docs: { path: '/x', description: 7 } })).toThrow(/expected string/)
  })

  it('rejects a non-boolean hidden', () => {
    expect(() => Schema({ docs: { path: '/x', hidden: 'yes' } })).toThrow(/expected boolean/)
  })
})