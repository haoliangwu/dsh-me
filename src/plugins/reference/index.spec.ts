import { describe, expect, it } from 'vitest'
import { Config, Schema } from './index.ts'

describe('Config schema', () => {
  it('defaults to an empty object', () => {
    expect(Config({})).toEqual({})
  })
})

describe('reference-table schema (settings namespace)', () => {
  it('defaults to an empty table', () => {
    expect(Schema({})).toEqual({})
    expect(Schema(undefined)).toEqual({})
  })

  it('accepts a legal entry (path required, description/hidden optional)', () => {
    expect(Schema({ docs: { path: '/Users/u/docs' } })).toEqual({ docs: { path: '/Users/u/docs' } })
    expect(Schema({ docs: { path: '~/docs', description: '产品文档库', hidden: true } })).toEqual({
      docs: { path: '~/docs', description: '产品文档库', hidden: true },
    })
  })

  it('rejects an invalid alias', () => {
    expect(() => Schema({ 'bad/alias': { path: '/x' } })).toThrow(/alias「bad\/alias」不能包含/)
    expect(() => Schema({ '': { path: '/x' } })).toThrow(/alias「」不能为空/)
  })

  it('rejects a relative path', () => {
    expect(() => Schema({ docs: { path: 'docs/x' } })).toThrow(/必须用绝对路径或 ~\/ 开头/)
  })

  it('rejects an entry without a path', () => {
    expect(() => Schema({ docs: { description: 'd' } })).toThrow(/缺少 path/)
  })

  it('rejects an entry with a non-string path', () => {
    expect(() => Schema({ docs: { path: 7 } })).toThrow()
  })

  it('rejects a non-object entry', () => {
    expect(() => Schema({ docs: '/plain-string' })).toThrow(/expected object/)
  })

  it('rejects a non-string description', () => {
    expect(() => Schema({ docs: { path: '/x', description: 7 } })).toThrow(/expected string/)
  })

  it('rejects a non-boolean hidden', () => {
    expect(() => Schema({ docs: { path: '/x', hidden: 'yes' } })).toThrow(/expected boolean/)
  })
})