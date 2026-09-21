import { describe, expect, it } from 'vitest'
import { normalizePickerPath, pickerCommandsFor } from './directory-picker.ts'

const HOME = '/Users/u'

describe('pickerCommandsFor', () => {
  it('chooses osascript on darwin', () => {
    expect(pickerCommandsFor('darwin', HOME)).toEqual([['osascript', '-e', 'POSIX path of (choose folder)']])
  })

  it('prefers zenity and falls back to kdialog on linux', () => {
    expect(pickerCommandsFor('linux', HOME)).toEqual([
      ['zenity', '--file-selection', '--directory'],
      ['kdialog', '--getexistingdirectory', HOME],
    ])
  })

  it('uses the PowerShell FolderBrowserDialog on win32', () => {
    const commands = pickerCommandsFor('win32', HOME)
    expect(commands).toHaveLength(1)
    expect(commands[0][0]).toBe('powershell')
    expect(commands[0].join(' ')).toContain('FolderBrowserDialog')
  })

  it('answers no command on an unknown platform', () => {
    expect(pickerCommandsFor('sunos', HOME)).toEqual([])
  })
})

describe('normalizePickerPath', () => {
  it('returns the first trimmed line for a plain POSIX path', () => {
    expect(normalizePickerPath('/Users/u/docs\n')).toBe('/Users/u/docs')
  })

  it('strips a trailing slash', () => {
    expect(normalizePickerPath('/Users/u/docs/')).toBe('/Users/u/docs')
    expect(normalizePickerPath('C:\\Users\\u\\docs\\')).toBe('C:\\Users\\u\\docs')
  })

  it('returns undefined for empty or whitespace output', () => {
    expect(normalizePickerPath('')).toBeUndefined()
    expect(normalizePickerPath('  \n')).toBeUndefined()
  })
})