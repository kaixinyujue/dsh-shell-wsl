/** Container names must match Docker's [a-zA-Z0-9][a-zA-Z0-9_.-]* and stay short. */
export declare function sanitizeContainerPrefix(prefix: string): string;
/**
 * Deterministic unique container name: <prefix>-<pid>-<seq>.
 * Total length is capped at 63 (the strictest common limit); on overflow the
 * prefix head is truncated at a hyphen boundary so the name still starts with
 * an alphanumeric character and never ends with a hyphen.
 */
export declare function makeContainerName(prefix: string, pid: number, seq: number): string;
