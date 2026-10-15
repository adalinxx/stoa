import assert from "node:assert/strict";
import { test } from "node:test";
import { cardName } from "./moniker.mjs";

const cards = (values) => ({ get: async (key) => values[key] });

test("a name is read from the Moniker card, untrusted", async () => {
  const state = cards({
    "user/alice/profile": JSON.stringify({ name: "  Alice  ", description: "hi", handle: "alice" }),
    "user/bob/profile": "not json",
    "user/carol/profile": JSON.stringify({ name: 7 }),
    "user/dave/profile": JSON.stringify({ name: "x".repeat(60) }),
    "user/erin/profile": JSON.stringify({ name: "   " }),
  });
  assert.equal(await cardName(state, "alice"), "Alice");
  assert.equal(await cardName(state, "bob"), undefined);
  assert.equal(await cardName(state, "carol"), undefined);
  assert.equal(await cardName(state, "dave"), "x".repeat(40));
  assert.equal(await cardName(state, "erin"), undefined);
  assert.equal(await cardName(state, "nobody"), undefined);
  await assert.rejects(cardName({ get: async () => { throw new Error("volume not served"); } }, "alice"), /volume not served/, "a failed read is not \"no card\"");
});
