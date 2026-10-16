// Arguments for the Claude Code process `dietcode claude` launches.

export const PROXY_AUTOCOMPACT_PCT = "95";

// `env` in settings.json overrides the environment Claude Code is started with,
// and setup writes CLAUDE_AUTOCOMPACT_PCT_OVERRIDE=50 there, so the env var
// alone loses. --settings outranks the settings files. Left alone if the user
// passes their own --settings.
export function withAutocompactSettings(args: string[]): string[] {
  if (args.some((a) => a === "--settings" || a.startsWith("--settings="))) return args;
  const settings = { env: { CLAUDE_AUTOCOMPACT_PCT_OVERRIDE: PROXY_AUTOCOMPACT_PCT } };
  return ["--settings", JSON.stringify(settings), ...args];
}
