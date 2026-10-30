/**
 * Test helpers: action-environment sandboxing (INPUT_* variables, the
 * GITHUB_OUTPUT file) and stdout capture for the core log lines.
 */

import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'

export interface EnvSandbox {
  restore(): void
  /** The parsed GITHUB_OUTPUT key=value pairs written so far. */
  outputs(): Record<string, string>
  outputFile: string
}

/**
 * Sets INPUT_* env vars plus GITHUB_OUTPUT; restores everything on
 * restore().
 */
export function withActionEnv(
  inputs: Record<string, string>,
  extraEnv: Record<string, string | undefined> = {}
): EnvSandbox {
  const saved = new Map<string, string | undefined>()
  const set = (key: string, value: string | undefined): void => {
    saved.set(key, process.env[key])
    if (value === undefined) {
      delete process.env[key]
    } else {
      process.env[key] = value
    }
  }
  const outputFile = path.join(
    fs.mkdtempSync(path.join(os.tmpdir(), 'bmc-actions-')),
    'github-output'
  )
  fs.writeFileSync(outputFile, '')
  for (const [key, value] of Object.entries(extraEnv)) {
    set(key, value)
  }
  // Inputs go LAST: an explicit test input must beat an env default
  // (e.g. the boolean defaults) for the same variable.
  for (const [name, value] of Object.entries(inputs)) {
    set(`INPUT_${name.replace(/ /g, '_').toUpperCase()}`, value)
  }
  set('GITHUB_OUTPUT', outputFile)
  return {
    outputFile,
    restore: () => {
      for (const [key, value] of saved) {
        if (value === undefined) {
          delete process.env[key]
        } else {
          process.env[key] = value
        }
      }
    },
    outputs: () => {
      // @actions/core writes the GITHUB_OUTPUT file-command format:
      //   key=value            (single line)
      //   key<<delim           (heredoc, the default for setOutput)
      //   value
      //   delim
      const text = fs.readFileSync(outputFile, 'utf8')
      const result: Record<string, string> = {}
      const lines = text.split('\n')
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i] ?? ''
        const heredoc = line.match(/^(.+?)<<(.+)$/)
        if (heredoc !== null) {
          const key = heredoc[1] ?? ''
          const delim = heredoc[2] ?? ''
          const valueLines: string[] = []
          i++
          while (i < lines.length && lines[i] !== delim) {
            valueLines.push(lines[i] ?? '')
            i++
          }
          result[key] = valueLines.join('\n')
          continue
        }
        const eq = line.indexOf('=')
        if (eq > 0) {
          result[line.slice(0, eq)] = line.slice(eq + 1)
        }
      }
      return result
    }
  }
}

/** Captures stdout (core.info/warning write the workflow-log protocol there). */
export async function captureStdout(fn: () => Promise<void>): Promise<string> {
  const parts: string[] = []
  const original = process.stdout.write.bind(process.stdout)
  const override = ((chunk: string | Uint8Array): boolean => {
    parts.push(
      typeof chunk === 'string' ? chunk : new TextDecoder().decode(chunk)
    )
    return true
  }) as typeof process.stdout.write
  process.stdout.write = override
  try {
    await fn()
  } finally {
    process.stdout.write = original
  }
  return parts.join('')
}

/** A deterministic test signing key (the fake server's HMAC key). */
export const TEST_SIGNING_KEY = Buffer.from(
  'bmc-actions-test-signing-key-0000000000',
  'utf8'
)

export const TEST_TOKEN = 'test-runtime-token-abcdefghijklmnop'
export const TEST_RUN_ID = 310

/**
 * The boolean input defaults GitHub materializes from the action.yml
 * (getBooleanInput throws on an absent input, exactly like upstream).
 */
export const BOOLEAN_INPUT_DEFAULTS: Record<string, string> = {
  INPUT_OVERWRITE: 'false',
  'INPUT_INCLUDE-HIDDEN-FILES': 'false',
  'INPUT_MERGE-MULTIPLE': 'false'
}
