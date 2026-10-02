/**
 * `/ballast config` and `/ballast exempt` — editing settings without opening
 * the sqlite file. Pure: it takes the current config and returns the next one,
 * so the parsing and validation are testable and the command handler only
 * persists what comes back.
 */
import { AUTO_RELIEVE, THROTTLE_MODES, type Config } from "./contract";
import { parseLines } from "./policy";

export type ConfigCommand =
  /** No subcommand: the caller keeps its existing behaviour. */
  | { kind: "none" }
  | { kind: "show"; message: string }
  | { kind: "error"; message: string }
  | { kind: "set"; config: Config; message: string };

const USAGE = "usage: /ballast config [<key> <value>] | /ballast exempt <pattern>";

const ENUMS: Readonly<Record<string, readonly string[]>> = {
  autoRelieve: AUTO_RELIEVE,
  throttle: THROTTLE_MODES,
};

/** JSON when it parses, else the raw text, so `steer false` is a boolean and
 *  `autoRelieve safe` needs no quotes. */
function parseValue(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

/** Coerce to the type of the default, or explain why it cannot be. */
function coerce(path: string, raw: string, fallback: unknown): { value: unknown } | { error: string } {
  const parsed = parseValue(raw);
  // A string setting holding digits ("3000") parses as a number; the user
  // meant the text.
  const value = typeof fallback === "string" && typeof parsed !== "string" ? raw : parsed;
  if (typeof value !== typeof fallback || (typeof value === "number" && !Number.isFinite(value))) {
    return { error: `${path} expects a ${typeof fallback}, got ${JSON.stringify(parsed)}` };
  }
  // Own-property reads only: "constructor" or "__proto__" must not reach Object.prototype.
  const allowed = Object.hasOwn(ENUMS, path) ? ENUMS[path] : undefined;
  if (allowed !== undefined && !allowed.includes(value as string)) {
    return { error: `${path} must be one of: ${allowed.join(", ")}` };
  }
  return { value };
}

function setKey(config: Config, defaults: Config, key: string, raw: string): ConfigCommand {
  const unknown: ConfigCommand = { kind: "error", message: `unknown config key: ${key}` };
  const parts = key.split(".");
  // `thresholds` itself is an object; only its members are settable.
  if (parts.length === 2 && parts[0] === "thresholds") {
    const leaf = parts[1] as keyof Config["thresholds"];
    if (!Object.hasOwn(defaults.thresholds, leaf)) return unknown;
    const checked = coerce(key, raw, defaults.thresholds[leaf]);
    if ("error" in checked) return { kind: "error", message: checked.error };
    const next = { ...config, thresholds: { ...config.thresholds, [leaf]: checked.value } };
    return { kind: "set", config: next, message: `${key} = ${JSON.stringify(checked.value)}` };
  }
  if (parts.length !== 1 || key === "thresholds" || !Object.hasOwn(defaults, key)) return unknown;
  const checked = coerce(key, raw, defaults[key as keyof Config]);
  if ("error" in checked) return { kind: "error", message: checked.error };
  return { kind: "set", config: { ...config, [key]: checked.value }, message: `${key} = ${JSON.stringify(checked.value)}` };
}

function addExempt(config: Config, pattern: string): ConfigCommand {
  if (pattern === "") return { kind: "error", message: USAGE };
  const lines = parseLines(config.exemptPatterns);
  if (lines.includes(pattern)) return { kind: "error", message: `already exempt: ${pattern}` };
  // Append to the raw text: rebuilding from parseLines would drop the user's # comments and blank lines.
  const raw = config.exemptPatterns.replace(/\n*$/, "");
  const next = { ...config, exemptPatterns: (raw.trim() ? `${raw}\n` : "") + pattern };
  return { kind: "set", config: next, message: `exempt: ${pattern}` };
}

export function parseConfigCommand(args: string, config: Config, defaults: Config): ConfigCommand {
  const text = args.trim();
  if (text === "") return { kind: "none" };
  const [sub = "", ...rest] = text.split(/\s+/);
  const tail = text.slice(sub.length).trim();
  if (sub === "exempt") return addExempt(config, tail);
  if (sub !== "config") return { kind: "error", message: USAGE };
  if (rest.length === 0) return { kind: "show", message: JSON.stringify(config, null, 2) };
  const key = rest[0] as string;
  const raw = tail.slice(key.length).trim();
  if (raw === "") return { kind: "error", message: `${key} needs a value. ${USAGE}` };
  return setKey(config, defaults, key, raw);
}
