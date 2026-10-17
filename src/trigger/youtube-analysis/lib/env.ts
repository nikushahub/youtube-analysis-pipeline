/**
 * Reads a required environment variable.
 * Throws a clear error naming the missing variable — never logs or returns anything about its value.
 */
export function requireEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is not set`);
  return value;
}

/** Reads an optional environment variable, falling back to a default. */
export function optionalEnv(name: string, fallback: string): string {
  const value = process.env[name]?.trim();
  return value ? value : fallback;
}

/** Turns an unknown thrown value (or a failed child-run error) into a readable message. */
export function describeError(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (error && typeof error === "object" && "message" in error) {
    return String((error as { message: unknown }).message);
  }
  return String(error);
}
