import { spawnSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { keccak256 } from "viem";

// Compiles local code only. This script has no RPC, wallet, signing, or broadcast path.
const result = spawnSync("forge", ["build", "--root", "contracts", "--sizes"], { stdio: "inherit" });
if (result.error) throw new Error("Foundry is required to compile the vault. Install forge, then run this script again.", { cause: result.error });
if (result.status !== 0) process.exit(result.status ?? 1);
const artifactPath = "contracts/out/SpreadlineVault.sol/SpreadlineVault.json";
const artifact = JSON.parse(await readFile(artifactPath, "utf8"));
const manifest = {
  contract: "SpreadlineVault",
  source: "contracts/src/SpreadlineVault.sol",
  artifactPath,
  compilerVersion: artifact.metadata.compiler.version,
  creationCodeHash: keccak256(artifact.bytecode.object),
  runtimeTemplateHash: keccak256(artifact.deployedBytecode.object),
  immutableReferences: artifact.deployedBytecode.immutableReferences,
  note: "Runtime template hash is NOT a deployed-code identity: settlement/router immutables are patched at deployment. Verify the deployed constructor values and exact patched runtime before configuring the app's vault code hash.",
  deployed: false,
};
await writeFile("contracts/out/desk-build-manifest.json", `${JSON.stringify(manifest, null, 2)}\n`);
console.log("Compiled vault and wrote contracts/out/desk-build-manifest.json. No deployment or transaction was sent.");
