import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { toEventSelector, toFunctionSelector, type AbiEvent, type AbiFunction } from "viem";
import { deskVaultAbi } from "../src/lib/desk-contract";

test("vault EVM invariants and client ABI agree with compiled Solidity", { timeout: 120_000 }, (t) => {
  const version = spawnSync("forge", ["--version"], { encoding: "utf8" });
  if (version.error && "code" in version.error && version.error.code === "ENOENT") {
    t.skip("Foundry is not installed. Run forge test --root contracts before releasing vault changes.");
    return;
  }
  const result = spawnSync("forge", ["test", "--root", "contracts", "--offline"], { encoding: "utf8", timeout: 110_000, maxBuffer: 2_000_000 });
  assert.equal(result.status, 0, `Solidity invariant suite failed:\n${result.stdout}\n${result.stderr}`);
  const compiled = JSON.parse(readFileSync("contracts/out/SpreadlineVault.sol/SpreadlineVault.json", "utf8")) as { abi: (AbiFunction | AbiEvent | { type: string })[] };
  const functions = (abi: typeof compiled.abi) => abi.filter((entry): entry is AbiFunction => entry.type === "function").map(toFunctionSelector).sort();
  const events = (abi: typeof compiled.abi) => abi.filter((entry): entry is AbiEvent => entry.type === "event").map(toEventSelector).sort();
  assert.deepEqual(functions([...deskVaultAbi]), functions(compiled.abi), "wallet and worker must use every compiled function's actual selector");
  assert.deepEqual(events([...deskVaultAbi]), events(compiled.abi), "ledger must decode actual contract events");
});
