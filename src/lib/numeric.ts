// Numeric input validation for CLI flags and MCP fall-throughs.
//
// Used by callers that take a string-typed numeric (commander option values,
// MCP tools that accept `id` as a string-or-label union). Bare parseInt
// silently returns NaN on invalid input which then propagates as NaN through
// slice/limit/find calls and produces empty or unbounded results — surfacing
// as "the tool returned nothing" with no diagnostic.
export function parsePositiveInt(
  raw: string | undefined,
  flagName: string,
  opts: { min?: number; max?: number; allowZero?: boolean } = {},
): number {
  if (raw === undefined || raw === '') {
    throw new Error(`${flagName}: missing value`);
  }
  if (!/^-?\d+$/.test(raw)) {
    throw new Error(`${flagName}: not an integer (got ${JSON.stringify(raw)})`);
  }
  const n = parseInt(raw, 10);
  const min = opts.min ?? (opts.allowZero ? 0 : 1);
  if (n < min) {
    throw new Error(`${flagName}: must be >= ${min} (got ${n})`);
  }
  if (opts.max !== undefined && n > opts.max) {
    throw new Error(`${flagName}: must be <= ${opts.max} (got ${n})`);
  }
  return n;
}
