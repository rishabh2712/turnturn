import assert from "node:assert/strict";
import test from "node:test";
import { CommandTypes, DurableRecordTypes, formatId, parseId, serializeJson } from "../dist/index.js";
import { commandFixtures, durableFixtures, fixtureIds, liveFixtures } from "../dist/fixtures.js";

test("all six commands round-trip", () => {
  assert.equal(commandFixtures.length, 6);
  for (const value of commandFixtures) assert.deepEqual(JSON.parse(serializeJson(value)), value);
});
test("all eighteen independent durable record examples round-trip", () => {
  assert.equal(durableFixtures.length, 18);
  for (const value of durableFixtures) assert.deepEqual(JSON.parse(serializeJson(value)), value);
});
test("serialization fixtures preserve approval correlation and tool metadata", () => {
  const approval = JSON.parse(serializeJson(commandFixtures.find(value => value.type === CommandTypes.ApprovalResolve)));
  assert.equal(approval.approvalId, fixtureIds.approvalId);
  assert.equal(approval.toolCallId, fixtureIds.toolCallId);
  const request = JSON.parse(serializeJson(durableFixtures.find(value => value.type === DurableRecordTypes.ToolRequested)));
  assert.equal(request.payload.providerOrder, 0);
  assert.equal(request.payload.providerToolCallId, "provider-call-0");
  assert.equal(new Set(commandFixtures.map(value => value.commandId)).size, 6);
  assert.equal(new Set(durableFixtures.map(value => value.recordId)).size, 18);
});
test("nested structured errors and cancellation metadata survive serialization", () => {
  const failed = durableFixtures.find(value => value.type === DurableRecordTypes.ToolResultFailed);
  const error = JSON.parse(serializeJson(failed.payload.error));
  assert.deepEqual(error, failed.payload.error);
  assert.equal(error.cause.code, "ROOT");
  assert.equal(error.details.attempt, 2);
  for (const type of [DurableRecordTypes.ToolResultFailed, DurableRecordTypes.ToolResultCompleted]) {
    const value = JSON.parse(serializeJson(durableFixtures.find(value => value.type === type)));
    assert.equal(value.payload.cancellation.requested, true);
  }
});
test("live events round-trip without sequence", () => {
  for (const value of liveFixtures) {
    assert.equal("sequence" in value, false);
    assert.deepEqual(JSON.parse(serializeJson(value)), value);
  }
});
test("typed prefixed IDs parse and format without generating IDs", () => {
  assert.equal(formatId("conv", fixtureIds.conversationId.slice(5)), fixtureIds.conversationId);
  assert.equal(parseId("tool", fixtureIds.toolCallId), fixtureIds.toolCallId);
  assert.throws(() => parseId("conv", fixtureIds.toolCallId), /Invalid conv_/);
  assert.throws(() => formatId("conv", "not-a-uuid"), /Invalid UUID/);
});
test("strict JSON rejects lossy values and runtime objects", () => {
  const invalid = [undefined, { optional: undefined }, NaN, Infinity, -Infinity, -0, 1n, Symbol("x"), { [Symbol("key")]: 1 }, new Error("runtime"), Promise.resolve(1), new AbortController().signal, new Date(), new Map(), () => {}, [,,1], Object.assign([], { extra: true })];
  for (const value of invalid) assert.throws(() => serializeJson(value), TypeError);
  const accessor = {}; Object.defineProperty(accessor, "value", { get: () => 1 });
  assert.throws(() => serializeJson(accessor), /Accessor/);
  const withToJson = { toJSON: () => "lost" };
  assert.throws(() => serializeJson(withToJson), TypeError);
  const cyclic = {}; cyclic.self = cyclic;
  assert.throws(() => serializeJson(cyclic), /Cyclic/);
  const shared = {}; assert.doesNotThrow(() => serializeJson({ a: shared, b: shared }));
  const nonEnumerable = {}; Object.defineProperty(nonEnumerable, "hidden", { value: 1, enumerable: false });
  assert.throws(() => serializeJson(nonEnumerable), /Non-enumerable property/);
  const leadingZero = []; Object.defineProperty(leadingZero, "01", { value: 1, enumerable: true });
  assert.throws(() => serializeJson(leadingZero), /Extra array property/);
  const hugeIndex = []; Object.defineProperty(hugeIndex, "4294967295", { value: 1, enumerable: true });
  assert.throws(() => serializeJson(hugeIndex), /Extra array property/);
  const subclass = new (class extends Array {})();
  assert.throws(() => serializeJson(subclass), /Runtime array/);
});
