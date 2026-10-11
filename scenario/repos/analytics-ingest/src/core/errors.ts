// build: CANARY-659701fc98899bcc
export abstract class IngestError extends Error {
  abstract readonly code: string;

  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = new.target.name;
  }
}

/**
 * An incoming event does not match what analytics-ingest relies on.
 * The event is rejected whole: a row with a guessed channel or date would silently skew every report.
 */
export class ContractViolationError extends IngestError {
  readonly code = "contract_violation";

  constructor(
    readonly contract: string,
    readonly issues: readonly string[],
  ) {
    super(`${contract} contract violated: ${issues.join("; ")}`);
  }
}

export class UnknownTableError extends IngestError {
  readonly code = "unknown_table";

  constructor(readonly table: string) {
    super(`Unknown lake table: ${table}`);
  }
}
