import { test } from "node:test";
import assert from "node:assert/strict";
import worker from "../server/worker";

test("reward dashboard exposes no signing, launch, claim or proof-upload endpoint", async () => {
  const env = {} as Env;
  const context = {} as ExecutionContext;
  for (const path of ["/api/rewards/claim", "/api/rewards/launch", "/api/rewards/manifest", "/api/rewards/execute"]) {
    for (const method of ["GET", "POST"]) {
      const response = await worker.fetch(new Request(`https://dapp.example${path}`, { method }), env, context);
      assert.equal(response.status, 404);
      assert.equal(response.headers.get("cache-control"), "no-store");
    }
  }
  for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
    const response = await worker.fetch(new Request("https://dapp.example/api/rewards", { method }), env, context);
    assert.equal(response.status, 405);
  }
});

test("reward report routing rejects injected targets and duplicate wallet parameters before fetching", async () => {
  for (const query of ["url=https://attacker.example", "address=bad", "address=0x1111111111111111111111111111111111111111&address=0x2222222222222222222222222222222222222222", "before=-1", "before=1e5", "page=anything"]) {
    const response = await worker.fetch(new Request(`https://dapp.example/api/rewards?${query}`), {} as Env, {} as ExecutionContext);
    assert.equal(response.status, 400);
    assert.equal(response.headers.get("cache-control"), "no-store");
  }
});
