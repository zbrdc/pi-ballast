/**
 * The parsers, against real output.
 *
 * These fixtures are verbatim from the machine Ballast was written on, at the
 * moment it was holding 5.2 GB of swap while `memory_pressure` claimed 61%
 * free. That disagreement is the reason this module exists, so it is the case
 * the tests pin.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { platform } from "node:os";
import {
  parseKernelPressure,
  parseMeminfo,
  parseSwapUsage,
  parseVmStat,
  sampleMemory,
} from "../src/lib/memory.ts";

const VM_STAT = `Mach Virtual Memory Statistics: (page size of 16384 bytes)
Pages free:                                    11887.
Pages active:                                 467336.
Pages inactive:                               363803.
Pages speculative:                            102040.
Pages throttled:                                   0.
Pages wired down:                             196995.
Pages purgeable:                                1044.
"Translation faults":                     1179544352.
File-backed pages:                            264584.
Anonymous pages:                              668595.
Pages stored in compressor:                  1236954.
Pages occupied by compressor:                  388325.
Swapins:                                     1499821.
Swapouts:                                     2314393.
`;

test("parseVmStat reads the page size and every counter", () => {
  const { pageSize, pages } = parseVmStat(VM_STAT);
  assert.equal(pageSize, 16384);
  assert.equal(pages.get("pages free"), 11887);
  assert.equal(pages.get("pages wired down"), 196995);
  assert.equal(pages.get("pages occupied by compressor"), 388325);
  assert.equal(pages.get("anonymous pages"), 668595);
  // The quoted key must survive — it is quoted in real output.
  assert.equal(pages.get("translation faults"), 1179544352);
});

test("the derived numbers agree with what top reported at the same instant", () => {
  const { pageSize, pages } = parseVmStat(VM_STAT);
  const gib = (key) => (pages.get(key) * pageSize) / 1024 ** 3;
  // top said: 3069M wired, 6029M compressor.
  assert.ok(Math.abs(gib("pages wired down") - 3069 / 1024) < 0.05);
  assert.ok(Math.abs(gib("pages occupied by compressor") - 6029 / 1024) < 0.05);
});

test("parseSwapUsage handles the sysctl format and its units", () => {
  const swap = parseSwapUsage("total = 6144.00M  used = 5192.50M  free = 951.50M  (encrypted)");
  assert.equal(swap.totalBytes, 6144 * 1024 ** 2);
  assert.equal(swap.usedBytes, 5192.5 * 1024 ** 2);

  const big = parseSwapUsage("total = 16.00G  used = 2.50G  free = 13.50G");
  assert.equal(big.totalBytes, 16 * 1024 ** 3);
  assert.equal(big.usedBytes, 2.5 * 1024 ** 3);
});

test("parseKernelPressure maps the sysctl ladder, and refuses to guess", () => {
  assert.equal(parseKernelPressure("kern.memorystatus_vm_pressure_level: 1"), "normal");
  assert.equal(parseKernelPressure("kern.memorystatus_vm_pressure_level: 2"), "warn");
  assert.equal(parseKernelPressure("kern.memorystatus_vm_pressure_level: 4"), "critical");
  assert.equal(parseKernelPressure(""), null);
  assert.equal(parseKernelPressure("unknown oid"), null);
});

test("parseMeminfo converts kB to bytes", () => {
  const info = parseMeminfo(`MemTotal:       16384000 kB
MemFree:          524288 kB
MemAvailable:    4194304 kB
Cached:          2097152 kB
`);
  assert.equal(info.get("memtotal"), 16384000 * 1024);
  assert.equal(info.get("memavailable"), 4194304 * 1024);
});

/**
 * The live sampler, against this machine's own /proc.
 *
 * The parsers above are pinned to recorded output. This runs the real
 * function, so the assertions are about the numbers agreeing with each other
 * rather than about any particular value — the machine's state is whatever it
 * happens to be. Skipped on macOS, where the same call shells out to vm_stat
 * and would need a recorded fixture rather than a live read; the darwin
 * sampler's ceiling is stated rather than papered over.
 */
const onLinux = platform() === "linux";
const skip = onLinux ? false : "the live sampler is only readable on linux";

test("the live reading is internally consistent", { skip }, async () => {
  const { sample, cursor } = await sampleMemory(null);
  assert.ok(sample.totalBytes > 0, "the machine has memory");
  assert.ok(sample.usedBytes > 0 && sample.usedBytes <= sample.totalBytes, "used is inside total");
  assert.ok(sample.headroomBytes > 0, "something is available");
  assert.ok(sample.headroomBytes <= sample.totalBytes, "headroom is inside total");
  assert.ok(sample.swapUsedBytes <= sample.swapTotalBytes, "swap used is inside swap total");
  assert.equal(cursor.pageSize, 4096, "linux pages are 4 KiB");
  assert.equal(sample.swapInRate, 0, "a first sample has no interval to report a rate over");
  assert.equal(sample.compressionRatio, 1, "no compressor to grade");
});

test("a second sample turns the counters into rates, never negatives", { skip }, async () => {
  const first = await sampleMemory(null);
  await new Promise((resolve) => setTimeout(resolve, 20));
  const { sample } = await sampleMemory(first.cursor);
  assert.ok(Number.isFinite(sample.swapInRate), "a finite rate");
  assert.ok(sample.swapInRate >= 0 && sample.swapOutRate >= 0, "never negative");
});

/** A cursor from the future must produce silence, not a spike. */
test("a counter that went backwards reports nothing", { skip }, async () => {
  const { cursor } = await sampleMemory(null);
  const { sample } = await sampleMemory({
    ...cursor,
    atMs: cursor.atMs + 60_000,
    swapInPages: cursor.swapInPages + 9999,
  });
  assert.equal(sample.swapInRate, 0, "an impossible interval yields no rate");
});
