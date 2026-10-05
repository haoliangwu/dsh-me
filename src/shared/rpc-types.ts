/**
 * Shared Connection-RPC type aliases for the profile plugin tree. Every
 * channel page imports these from one home instead of repeating the alias
 * dance against @deepseek-ai/dsh-client-connection per file.
 */
export type {
  ConnectionRpcFailure as RpcError,
  ConnectionRpcResult as RpcResult,
} from '@deepseek-ai/dsh-client-connection'