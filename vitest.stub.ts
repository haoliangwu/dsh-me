import React from 'react'
export const IconApiOutline14 = () => React.createElement('span')
export const IconRefreshOutline16 = () => React.createElement('span')
export const StateDot = () => React.createElement('span')
export const MarkdownText = ({ text }: { text: string }) => React.createElement('div', null, text.replace(/\*\*/g, ''))
export const Tooltip = ({ children }: { children?: React.ReactNode }) => React.createElement(React.Fragment, null, children)
export const Modal = ({ open, onClose, title, closeLabel, description, children }: {
  open: boolean
  onClose: () => void
  title?: string
  closeLabel?: string
  description?: string
  children?: React.ReactNode
}) => open
  ? React.createElement('div',
      { 'data-testid': 'shortcuts-modal' },
      title !== undefined ? React.createElement('div', null, title) : null,
      closeLabel !== undefined ? React.createElement('button', { onClick: onClose }, closeLabel) : null,
      description !== undefined ? React.createElement('div', null, description) : null,
      children,
    )
  : null