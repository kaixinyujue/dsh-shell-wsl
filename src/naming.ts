/** Container names must match Docker's [a-zA-Z0-9][a-zA-Z0-9_.-]* and stay short. */
export function sanitizeContainerPrefix(prefix: string): string {
  return prefix
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+/, "")
    .replace(/-+$/, "");
}

/**
 * Deterministic unique container name: <prefix>-<pid>-<seq>.
 * Total length is capped at 63 (the strictest common limit); on overflow the
 * prefix head is truncated at a hyphen boundary so the name still starts with
 * an alphanumeric character and never ends with a hyphen.
 */
export function makeContainerName(prefix: string, pid: number, seq: number): string {
  const clean = sanitizeContainerPrefix(prefix) || "dsh-exec";
  const suffix = `-${pid}-${seq}`;
  const maxLength = 63;
  const room = maxLength - suffix.length;
  if (room <= 0) return suffix.slice(1);
  const head = clean.length > room ? clean.slice(0, room).replace(/-+$/, "") : clean;
  return head + suffix;
}
