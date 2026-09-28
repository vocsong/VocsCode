export function validateE2eReport(
  reportText: string | undefined,
  files: string[],
  childStatus: number | null,
  cwd?: string
): { passed: number; failed: number; skipped: number; problems: string[] };
