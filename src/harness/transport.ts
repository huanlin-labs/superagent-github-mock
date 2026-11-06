/**
 * Swaps the transport under the real `Commands` class, and nothing else.
 *
 * `Commands` is the object every GitHub reader in the prototype goes through:
 * `api()` builds `repos/<owner>/<name>/<path>` and refuses paths outside the configured repository,
 * `pages()` parses `--paginate --slurp` output, and `commandError()` turns a subprocess failure into a
 * `CliError` carrying GitHub's HTTP status. All of that is worth testing, so instead of replacing the
 * class this module subclasses it and overrides only `run()` — the one method that would spawn `gh` —
 * to answer from the local mock instead.
 *
 * `withSignal()` has to be overridden as well: the base implementation constructs a plain `Commands`,
 * which would fall back to spawning a real subprocess.
 */
import { installVendoredResolution, prototypeModule } from './hooks.ts'
import { ghApi } from '../shim/gh.ts'

/** The deployment shape the GitHub Source reads: the repository, and the agent's account. */
export interface MockDeployment {
  repository: string;
  github: { login: string; norereply?: string; noreply: string; cli: string };
}

installVendoredResolution()

/** Builds a `Commands` whose `run()` answers from `baseUrl` instead of a subprocess. */
export async function createCommands(
  deployment: MockDeployment,
  baseUrl: string,
  signal: AbortSignal = new AbortController().signal,
): Promise<unknown> {
  const { Commands, commandError } = await import(prototypeModule('infra/commands.ts')) as {
    commandError: (error: unknown, program?: string) => Error
    Commands: new (resolved: () => MockDeployment, environment: Record<string, string | undefined>, signal: AbortSignal) => {
      run(program: string, args: string[], cwd?: string): Promise<string>;
      withSignal(signal?: AbortSignal): unknown;
      api(schema: unknown, path: string, ...flags: string[]): Promise<unknown>;
      pages(item: unknown, path: string, tally?: { skipped: number }): Promise<unknown[]>;
      readonly deployment: MockDeployment;
      readonly repository: string;
    }
  }

  class MockCommands extends Commands {
    /** The agent CLI name the deployment names; any other program is a test mistake, not a mock concern. */
    readonly #cli = deployment.github.cli
    readonly #deployment = deployment
    readonly #environment: Record<string, string | undefined> = {}
    readonly #signal: AbortSignal

    constructor(resolved: () => MockDeployment, environment: Record<string, string | undefined>, abort: AbortSignal) {
      super(resolved, environment, abort)
      this.#signal = abort
    }

    override withSignal(signal?: AbortSignal): MockCommands {
      return signal
        ? new MockCommands(() => this.#deployment, this.#environment, AbortSignal.any([this.#signal, signal]))
        : this
    }

    /** Answers `gh <program> …` from the mock, with the stdout, stderr and exit code gh would produce. */
    override async run(program: string, args: string[]): Promise<string> {
      if (program !== this.#cli) throw new Error(`the mock answers only "${this.#cli}", not "${program}"`)
      const result = await ghApi(args, baseUrl)
      if (result.code !== 0) {
        // The base `run()` builds a `CliError` from the execFile rejection; answering from HTTP must
        // produce the same error, or a 410 and a 304 stop being distinguishable from a plain failure.
        throw commandError(Object.assign(new Error('the mock gh failed'), { code: result.code, stderr: result.stderr }), program)
      }
      return result.stdout
    }
  }

  return new MockCommands(() => deployment, {}, signal)
}
