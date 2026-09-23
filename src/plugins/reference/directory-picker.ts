/**
 * Host-side native directory picker for the References settings page: spawns
 * the platform's system folder dialog and returns the chosen POSIX path.
 * The pure decision core (command selection per platform, output
 * normalization, completion semantics) sits beside the spawn I/O so vitest
 * covers every branch without ever launching a dialog.
 *
 * Cancel semantics: a completed run WITHOUT a path (non-zero exit or empty
 * output) is the user's cancel — an answer, not an error. Only a spawn
 * failure (missing binary) is an error, and only then does the Linux chain
 * fall through to its next candidate.
 */
import { spawn } from 'node:child_process'

/** One picker invocation: the binary plus its argument vector. */
export type PickerInvocation = readonly [binary: string, ...args: string[]]

/** The picker's settled outcome: a completed run, or a spawn failure. */
export type PickerRunOutcome =
  | { readonly kind: 'completed'; readonly code: number; readonly stdout: string }
  | { readonly kind: 'spawn-error'; readonly message: string }

/** The browser-facing picker answer. */
export interface PickDirectoryResult {
  /** True when the user dismissed the dialog without choosing. */
  readonly canceled: boolean
  /** The chosen absolute path; absent when canceled. */
  readonly path?: string
}

/**
 * The native-picker command list for one platform, in fallback order. Only a
 * spawn failure falls through; a canceled dialog is an answer, never a signal
 * to try the next picker.
 * @param platform - `process.platform` ('darwin' | 'linux' | 'win32' | ...).
 * @param home - the user's home directory (the kdialog starting point).
 * @returns the ordered candidate invocations.
 */
export function pickerCommandsFor(platform: string, home: string): readonly PickerInvocation[] {
  switch (platform) {
    case 'darwin':
      // osascript's choose folder prints the POSIX path; cancel exits with a
      // non-zero code and no output.
      return [['osascript', '-e', 'POSIX path of (choose folder)']]
    case 'linux':
      return [
        ['zenity', '--file-selection', '--directory'],
        ['kdialog', '--getexistingdirectory', home],
      ]
    case 'win32':
      return [[
        'powershell',
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        'Add-Type -AssemblyName System.Windows.Forms; $f = New-Object System.Windows.Forms.FolderBrowserDialog; '
          + 'if ($f.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) { Write-Output $f.SelectedPath }',
      ]]
    default:
      return []
  }
}

/**
 * Normalize one picker stdout blob into an absolute path: first line, trimmed,
 * trailing separators stripped; an empty result means no path was chosen. The
 * trailing-separator strip makes every platform's answer uniform for the
 * settings table.
 * @param stdout - the picker's captured stdout.
 * @returns the chosen path, or undefined when the output carried none.
 */
export function normalizePickerPath(stdout: string): string | undefined {
  const line = stdout.split(/\r?\n/, 1)[0]?.trim() ?? ''
  if (line === '') return undefined
  return line.replace(/[\\/]+$/, '')
}

/**
 * Run the platform's native directory picker and settle the authoritative
 * answer. A completed run without a path is a canceled dialog; a spawn
 * failure on every candidate rejects (the caller turns that into an RPC
 * error).
 * @param home - the user's home directory.
 * @returns the picker answer.
 * @throws when no picker can spawn on this platform.
 */
export async function pickDirectoryOnHost(home: string): Promise<PickDirectoryResult> {
  for (const invocation of pickerCommandsFor(process.platform, home)) {
    const outcome = await runPicker(invocation)
    if (outcome.kind === 'spawn-error') continue
    const path = normalizePickerPath(outcome.stdout)
    if (outcome.code === 0 && path !== undefined) return { canceled: false, path }
    return { canceled: true }
  }
  throw new Error(`no directory picker available on ${process.platform}`)
}

/** Spawn one picker and collect its code and stdout; never rejects. */
async function runPicker(invocation: PickerInvocation): Promise<PickerRunOutcome> {
  return new Promise((resolve) => {
    const [binary, ...args] = invocation
    const child = spawn(binary, args, { stdio: ['ignore', 'pipe', 'ignore'] })
    let stdout = ''
    child.stdout.on('data', (chunk) => { stdout += String(chunk) })
    // The 'error' and 'close' pair both fire on a spawn failure; the second
    // resolve is a no-op and the spawn-error answer wins.
    child.on('error', (error) => { resolve({ kind: 'spawn-error', message: error.message }) })
    child.on('close', (code) => { resolve({ kind: 'completed', code: code ?? 1, stdout }) })
  })
}