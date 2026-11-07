import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { handler } from "../src/handler.js";
import { hospitalKey } from "../src/hospital-key.js";

test("the API and offline roster retain 212 distinct identities across display-name changes", async () => {
  const root = new URL("../../", import.meta.url);
  const result = await handler({ rawPath: "/api/hospitals", requestContext: { http: { method: "GET" } } });
  assert.equal(result.statusCode, 200);
  const { features } = JSON.parse(result.body);
  const html = await readFile(new URL("maps/index.html", root), "utf8");
  const embedded = html.match(/<script type="application\/json" id="facilities">(.*?)<\/script>/s);
  assert.deepEqual(JSON.parse(embedded[1]).features, features);
  assert.equal(features.length, 212);
  assert.equal(new Set(features.map(f => f.id)).size, 212);
  for (const { id, properties } of features) {
    const record = JSON.parse(await readFile(new URL(properties.record_path, root), "utf8"));
    assert.equal(hospitalKey(record), id);
    record.hospital.name = "Renamed campus";
    assert.equal(hospitalKey(record), id);
    assert.equal(id, properties.pfi ?? "t2p-0001");
  }
});

test("unregistered rows without a PFI require an explicit assignment", () => {
  assert.throws(() => hospitalKey({hospital: {name: "Unknown"}, source: {row_url: "new-row"}}), /Assign a stable local key/);
});
