/**
 * The reason payload of a durable `turn/end` event (structural). One shape
 * shared by every consumer that folds turn endings (notification chime/title
 * mapping, session-messenger reply policy); previously duplicated per plugin.
 */
export interface TurnEndReasonShape {
  readonly kind: string
  /** Internal cause carried by `aborted` reasons (user/parent/hook/disposed/legacy). */
  readonly reason?: { readonly kind?: string }
  /** LlmFailure fields; `code` present on error reasons. */
  readonly error?: { readonly message?: string; readonly code?: string }
}