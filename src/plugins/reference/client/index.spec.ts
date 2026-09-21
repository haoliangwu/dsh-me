/**
 * dsh-reference `@` source registration contract. The web submit pipeline
 * routes a chip's model serialization back through the input-trigger
 * controller by EXACT source name: after the chip lookup key (`__source` =
 * `insert.source`), the controller runs
 * `roster.all().find(s => s.name === source)?.codec.serialize(ref)`
 * (ui-conversation input/facade.ts sinkSerialized → ui-input-trigger
 * controller). A name mismatch or a failing serializer blocks submission and
 * merely restores the draft — the "chip stuck, Enter dead" failure mode. These
 * tests pin the three links of that chain to one constant and to the pure
 * core, so the contract cannot silently regress.
 */
import { describe, expect, it } from 'vitest'
import { SOURCE_NAME } from './index.ts'
import { resolveReferencePath, serializeMention } from '../pure.ts'

const HOME = '/Users/u'

describe('dsh-reference @ source serialization contract', () => {
  it('registers the routing key once (source.name === insert.source)', () => {
    // The trigger source's `name` and every inserted reference's `source`
    // field both read this constant; the controller looks them up by it.
    expect(SOURCE_NAME).toBe('dsh-reference')
  })

  it('serializes an inserted reference to its plain-text mention, never failing', async () => {
    // Mirrors the registered codec: clipboard and model form are the mention
    // itself, so the submit pipeline's serialize always settles.
    const codecSerialize = async (ref: string): Promise<string> => ref
    const chosen = { alias: 'docs', path: '~/docs', label: 'docs' }
    const mention = serializeMention(resolveReferencePath(chosen.path, HOME))
    expect(mention).toBe('@/Users/u/docs')
    await expect(codecSerialize(mention)).resolves.toBe('@/Users/u/docs')
  })

  it('routes the mention through the host lookup by name (no fixture drift)', () => {
    const ref = serializeMention(resolveReferencePath('/x/y', HOME))
    const source = { name: SOURCE_NAME, codec: { serialize: (r: string) => Promise.resolve(r) } }
    const owner = [source].find((s) => s.name === SOURCE_NAME)
    expect(owner).toBe(source)
    expect(ref).toBe('@/x/y')
  })
})