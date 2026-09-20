// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { render } from '@testing-library/react'
import { BtwCommandCard } from './BtwCommandCard.tsx'

const t = (key: string): string => ({ 'copy': 'Copy', 'copied': 'Copied', 'running': 'btw command running…' })[key] ?? key

function node(outcome: unknown) {
  return { kind: 'command', seq: 1, time: 1, commandId: 'c1', name: 'btw', args: null, outcome }
}

describe('BtwCommandCard', () => {
  it('renders the settled answer as markdown', () => {
    const { getByText } = render(
      <BtwCommandCard node={node({ kind: 'success', text: '**2+2=4**' })} t={t} />,
    )
    expect(getByText('btw')).toBeDefined()
    expect(getByText('2+2=4')).toBeDefined()
  })

  it('shows running summary while unsettled', () => {
    const { getByText } = render(<BtwCommandCard node={node(null)} t={t} />)
    expect(getByText('btw command running…')).toBeDefined()
  })

  it('shows the error text on failure', () => {
    const { getByText } = render(
      <BtwCommandCard node={node({ kind: 'error', text: 'no answer' })} t={t} />,
    )
    expect(getByText('no answer')).toBeDefined()
  })
})
