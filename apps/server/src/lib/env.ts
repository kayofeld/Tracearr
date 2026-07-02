export function requireBetterAuthSecret(): string {
  const secret = process.env.BETTER_AUTH_SECRET;
  if (!secret) {
    throw new Error(
      'BETTER_AUTH_SECRET environment variable is required. Generate one with: openssl rand -hex 32'
    );
  }
  return secret;
}
