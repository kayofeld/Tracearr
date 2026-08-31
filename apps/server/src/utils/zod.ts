import type { z } from 'zod';

// safeParse errors serialize as a JSON issue array; surface the first issue
// as a sentence the editor can show directly.
export function firstIssueMessage(error: z.ZodError): string {
  const issue = error.issues[0];
  if (!issue) return 'validation failed';
  const path = issue.path.join('.');
  return path ? `${path}: ${issue.message}` : issue.message;
}
