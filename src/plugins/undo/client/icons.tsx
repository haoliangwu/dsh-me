/**
 * Local undo/redo arrows — mirror images so the two actions read apart at a
 * glance (the host primitives only ship one refresh icon). Lucide-style
 * outline strokes match the primitives' outline set visually.
 */
import type { ReactNode } from 'react'

const BASE = 16

function arrowIcon(paths: ReactNode): (props: { size?: number; className?: string }) => ReactNode {
  return function Arrow({ size = BASE, className }: { size?: number; className?: string }) {
    return (
      <svg
        width={size}
        height={size}
        className={className}
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
      >
        {paths}
      </svg>
    )
  }
}

/** The undo arrow: curving counter-clockwise to the left. */
export const UndoArrow = arrowIcon(
  <>
    <path d="M9 14 4 9l5-5" />
    <path d="M4 9h10.5a5.5 5.5 0 0 1 0 11H11" />
  </>,
)

/** The redo arrow: the undo arrow mirrored to the right. */
export const RedoArrow = arrowIcon(
  <>
    <path d="m15 14 5-5-5-5" />
    <path d="M20 9H9.5a5.5 5.5 0 0 0 0 11H13" />
  </>,
)
