import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { handler } from "../src/handler.js";
import { hospitalKey } from "../src/hospital-key.js";

test("218 current facilities retain all 212 historical identities and seven unrated additions", async () => {
  const root = new URL("../../", import.meta.url);
  const result = await handler({ rawPath: "/api/hospitals", requestContext: { http: { method: "GET" } } });
  assert.equal(result.statusCode, 200);
  const { features, historical_features } = JSON.parse(result.body);
  const html = await readFile(new URL("maps/index.html", root), "utf8");
  const embedded = html.match(/<script type="application\/json" id="facilities">(.*?)<\/script>/s);
  const all=[...features,...historical_features];
  for(const original of JSON.parse(embedded[1]).features){
    const updated=all.find(f=>f.id===original.id);
    const {current_directory,...properties}=updated.properties;
    assert.deepEqual({...updated,properties},original);
  }
  assert.equal(features.length, 218);
  assert.equal(new Set(all.map(f => f.id)).size, 219);
  assert.deepEqual(historical_features.map(f=>f.id),['t2p-0001']);
  assert.equal(features.filter(f=>f.properties.grade===null).length,7);
  const reconciliation=JSON.parse(await readFile(new URL('data/maps/directory-reconciliation.json',root),'utf8'));
  assert.equal(reconciliation.entries.length,218);
  assert.deepEqual(new Set(reconciliation.entries.map(e=>e.hospital_key)),new Set(features.map(f=>f.id)));
  const {facilityFor}=await import('../audit/roster-inventory.js');
  for(const source of reconciliation.facility_sources){
    const f=features.find(f=>f.id===source.record.fac_id);
    assert.deepEqual(f.geometry.coordinates,[Number(source.record.longitude),Number(source.record.latitude)]);
    assert.equal(f.properties.assistance_parent_pfi,source.record.main_site_facid);
    assert.equal(f.properties.grade,null);assert.equal(f.properties.stars,null);
    assert.equal(f.properties.audit_url,null);assert.equal(f.properties.application_posted,null);
    assert.ok(facilityFor(f.id));
  }
  for (const { id, properties } of all.filter(f=>f.properties.record_path)) {
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
