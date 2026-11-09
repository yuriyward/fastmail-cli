/** One stable code per failure; `recovery` is the exact next command when one exists. */
export class CliError extends Error {
  readonly code: string;
  readonly exitCode: number;
  readonly recovery: string | undefined;
  readonly details: Record<string, unknown> | undefined;
  constructor(
    code: string,
    message: string,
    options: { exitCode?: number; recovery?: string; details?: Record<string, unknown> } = {},
  ) {
    super(message);
    this.code = code;
    this.exitCode = options.exitCode ?? 1;
    this.recovery = options.recovery;
    this.details = options.details;
  }
}
export const usage = (message: string, recovery = "fastmail-cli --help") =>
  new CliError("usage", message, { exitCode: 2, recovery });
