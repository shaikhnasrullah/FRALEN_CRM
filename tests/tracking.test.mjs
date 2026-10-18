import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join, dirname } from "node:path";
import * as stages from "../js/order-stages.js";

const require = createRequire(import.meta.url);
const core = require("../functions/orderTracking.js");
const { makeDb } = require("./helpers/fake-firestore.cjs");
const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (f) => readFileSync(join(root, f), "utf8");

class HttpsError extends Error { constructor(code, message) { super(message); this.code = code; } }

const SECRET = {
  mobile: "9876543210", email: "rahul.secret@example.com", address: "221B Hidden Street",
  notes: "internal note xyz", gstin: "GSTIN-SECRET",
};
function seedOrder(extra = {}) {
  return {
    orderNo: "FLN42", customerName: "Rahul Kumar Khan", ...SECRET,
    orderDate: "2026-10-18", deliveryDate: "2026-10-22T18:00", createdAt: "2026-10-18T09:00:00.000Z",
    orderStage: "Pending", stageTimes: { Pending: "2026-10-18T09:00:00.000Z" },
    totals: { payable: 4999, advance: 1000, pending: 3999 },
    products: [{ name: "Ray-Ban Aviator", price: 4999 }],
    prescription: { re: { sph: "-1.25" }, remarks: "rx-secret" },
    ...extra,
  };
}
const PROFILE = { shopName: "Fralen Optical", phone: "+91 93044 77821", ownerName: "Owner Secret", email: "owner@secret.test" };
function world() {
  return makeDb({ "users/ownerA": PROFILE, "users/ownerA/orders/o1": seedOrder(), "users/ownerB": { shopName: "Other" }, "users/ownerB/orders/o9": seedOrder({ orderNo: "B9" }) });
}
const create = (db, uid, orderId, opts = {}) => core.createTrackingLink({ db, uid, orderId, HttpsError, ...opts });
const lookup = (db, token) => core.getTracking({ db, token, HttpsError });
const rejects = (p, code) => assert.rejects(p, (e) => e instanceof HttpsError && e.code === code);

test("tokens are random, url-safe and at least 128 bits", () => {
  const seen = new Set();
  for (let i = 0; i < 500; i++) {
    const t = core.generateToken();
    assert.match(t, /^[A-Za-z0-9_-]{24}$/);
    assert.ok(core.isValidToken(t));
    seen.add(t);
  }
  assert.equal(seen.size, 500);
  for (const bad of ["", "short", "a".repeat(21), "a".repeat(65), "has space aaaaaaaaaaaaaaaaaaaa", "../etc/passwd/aaaaaaaaaaaa", null, undefined, 123, {}]) assert.equal(core.isValidToken(bad), false, String(bad));
});

test("createTrackingLink: issues a token, stores pointer + trackingToken on the order", async () => {
  const db = world();
  const { token } = await create(db, "ownerA", "o1");
  assert.ok(core.isValidToken(token));
  assert.equal(db.store.get("users/ownerA/orders/o1").trackingToken, token);
  const pointer = db.store.get("orderTracking/" + token);
  assert.equal(pointer.uid, "ownerA");
  assert.equal(pointer.orderId, "o1");
});

test("createTrackingLink is idempotent (same link every time)", async () => {
  const db = world();
  const a = await create(db, "ownerA", "o1");
  const b = await create(db, "ownerA", "o1");
  assert.equal(a.token, b.token);
  assert.equal([...db.store.keys()].filter((k) => k.startsWith("orderTracking/")).length, 1);
});

test("createTrackingLink repairs a missing pointer without changing the link", async () => {
  const db = world();
  const { token } = await create(db, "ownerA", "o1");
  db.store.delete("orderTracking/" + token);
  const again = await create(db, "ownerA", "o1");
  assert.equal(again.token, token);
  assert.ok(db.store.has("orderTracking/" + token));
});

test("a shop cannot create links for another shop's order", async () => {
  const db = world();
  await rejects(create(db, "ownerA", "o9"), "not-found"); // o9 belongs to ownerB
  assert.equal(db.store.get("users/ownerB/orders/o9").trackingToken, undefined);
});

test("createTrackingLink validates input and auth", async () => {
  const db = world();
  await rejects(create(db, "", "o1"), "unauthenticated");
  await rejects(create(db, undefined, "o1"), "unauthenticated");
  for (const bad of [undefined, null, "", 5, "a/b", "x".repeat(201), {}]) await rejects(create(db, "ownerA", bad), "invalid-argument");
  await rejects(create(db, "ownerA", "nope"), "not-found");
});

test("token collisions are retried; a token pointing elsewhere is never reused", async () => {
  const db = world();
  db.store.set("orderTracking/" + "A".repeat(24), { uid: "ownerB", orderId: "o9" });
  const seq = ["A".repeat(24), "B".repeat(24)];
  const { token } = await create(db, "ownerA", "o1", { makeToken: () => seq.shift() });
  assert.equal(token, "B".repeat(24));
  assert.deepEqual(db.store.get("orderTracking/" + "A".repeat(24)), { uid: "ownerB", orderId: "o9" });

  const db2 = world();
  db2.store.set("users/ownerA/orders/o1", seedOrder({ trackingToken: "C".repeat(24) }));
  db2.store.set("orderTracking/" + "C".repeat(24), { uid: "ownerB", orderId: "o9" }); // hijack attempt
  const res = await create(db2, "ownerA", "o1");
  assert.notEqual(res.token, "C".repeat(24));
});

test("gives up with an error if tokens keep colliding", async () => {
  const db = world();
  db.store.set("orderTracking/" + "A".repeat(24), { uid: "x", orderId: "y" });
  await rejects(create(db, "ownerA", "o1", { makeToken: () => "A".repeat(24) }), "internal");
});

test("getOrderTracking returns the whitelisted view and nothing else", async () => {
  const db = world();
  const { token } = await create(db, "ownerA", "o1");
  const res = await lookup(db, token);
  assert.equal(res.success, true);
  assert.deepEqual(Object.keys(res.tracking).sort(), ["customerFirstName", "estimatedCollectionDate", "orderDate", "orderNo", "shopName", "shopPhone", "stage", "stageTimes"]);
  assert.equal(res.tracking.customerFirstName, "Rahul");
  assert.equal(res.tracking.orderNo, "FLN42");
  assert.equal(res.tracking.stage, "Pending");
  assert.equal(res.tracking.estimatedCollectionDate, "2026-10-22");
  assert.equal(res.tracking.shopName, "Fralen Optical");
  assert.equal(res.tracking.shopPhone, "+91 93044 77821");
});

test("PRIVACY: no personal, financial or internal data is ever returned", async () => {
  const db = world();
  const { token } = await create(db, "ownerA", "o1");
  const json = JSON.stringify(await lookup(db, token));
  for (const secret of [...Object.values(SECRET), "Khan", "Kumar", "4999", "3999", "Aviator", "rx-secret", "Owner Secret", "owner@secret.test", "ownerA", "o1", "users/", token]) {
    assert.ok(!json.includes(secret), `leaked: ${secret}`);
  }
});

test("Sales History stage/ETA changes show up immediately (live order is read, no sync step)", async () => {
  const db = world();
  const { token } = await create(db, "ownerA", "o1");
  assert.equal((await lookup(db, token)).tracking.stage, "Pending");
  // what sales-history.html's updateOrderStage / updateEta write
  await db.doc("users/ownerA/orders/o1").update({ orderStage: "Processing", stageTimes: { Pending: "2026-10-18T09:00:00.000Z", Processing: "2026-10-18T11:30:00.000Z" } });
  let t = (await lookup(db, token)).tracking;
  assert.equal(t.stage, "Processing");
  assert.equal(t.stageTimes.Processing, "2026-10-18T11:30:00.000Z");
  await db.doc("users/ownerA/orders/o1").update({ orderStage: "Ready", deliveryDate: "2026-10-25" });
  t = (await lookup(db, token)).tracking;
  assert.equal(t.stage, "Ready");
  assert.equal(t.estimatedCollectionDate, "2026-10-25");
  await db.doc("users/ownerA/orders/o1").update({ orderStage: "Delivered" });
  assert.equal((await lookup(db, token)).tracking.stage, "Delivered");
});

test("existing orders without a stage are 'Pending'; unknown stages cannot leak", () => {
  assert.equal(core.buildPublicView({}, {}).stage, "Pending");
  assert.equal(core.buildPublicView({ orderStage: "<script>" }, {}).stage, "Pending");
  for (const s of core.STAGES) assert.equal(core.buildPublicView({ orderStage: s }, {}).stage, s);
});

test("getOrderTracking: every failure looks identical (no token probing)", async () => {
  const db = world();
  const { token } = await create(db, "ownerA", "o1");
  const messages = new Set();
  const attempts = [undefined, null, "", "short", 5, "x".repeat(24), core.generateToken(), "../users/ownerA/orders/o1ab"];
  for (const t of attempts) {
    await assert.rejects(lookup(db, t), (e) => { messages.add(e.code + "|" + e.message); return e.code === "not-found"; });
  }
  db.store.delete("users/ownerA/orders/o1"); // order deleted
  await assert.rejects(lookup(db, token), (e) => { messages.add(e.code + "|" + e.message); return e.code === "not-found"; });
  assert.equal(messages.size, 1);
});

test("replacing the token on the order revokes the old link", async () => {
  const db = world();
  const { token } = await create(db, "ownerA", "o1");
  await db.doc("users/ownerA/orders/o1").update({ trackingToken: "R".repeat(24) });
  await rejects(lookup(db, token), "not-found");
});

test("a malformed pointer is treated as not found", async () => {
  const db = world();
  db.store.set("orderTracking/" + "P".repeat(24), { uid: 5 });
  await rejects(lookup(db, "P".repeat(24)), "not-found");
});

test("view fields are sanitised and capped", () => {
  const v = core.buildPublicView({ orderNo: "N".repeat(100), customerName: "  Ana   Maria ", deliveryDate: "garbage", orderDate: 5, stageTimes: { Pending: "nope", Ready: "2026-10-19T10:00:00Z", Evil: "x" } }, { shopName: "S".repeat(200), phone: 12345 });
  assert.equal(v.orderNo.length, 40);
  assert.equal(v.customerFirstName, "Ana");
  assert.equal(v.estimatedCollectionDate, null);
  assert.equal(v.orderDate, null);
  assert.deepEqual(Object.keys(v.stageTimes), ["Ready"]);
  assert.equal(v.shopName.length, 80);
  assert.equal(v.shopPhone, "");
});

// ---------------- front-end wiring ----------------
test("stage keys match between the browser module and the Cloud Function", () => {
  assert.deepEqual(stages.STAGES.map((s) => s.key), core.STAGES);
  assert.deepEqual(stages.STAGES.map((s) => s.label), ["Order received", "Lens/frame processing", "Ready for collection", "Delivered"]);
  assert.equal(stages.normalizeStage("Ready"), "Ready");
  assert.equal(stages.normalizeStage(undefined), "Pending");
  assert.equal(stages.stageIndex("Delivered"), 3);
});

test("tracking URL and WhatsApp message", () => {
  const token = core.generateToken();
  assert.equal(stages.trackingUrl(token), `https://www.fralencrm.in/track.html?t=${token}`);
  const msg = stages.trackingMessage({ customerName: "Rahul Khan", shopName: "Fralen Optical", orderNo: "FLN42", url: "U" });
  assert.equal(msg, "Namaste Rahul, aapka order FLN42 (Fralen Optical) ka status yahan dekhein (login ki zaroorat nahi):\nU");
  assert.equal(stages.trackingMessage({ url: "U" }), "Namaste, aapka order ka status yahan dekhein (login ki zaroorat nahi):\nU");
  assert.equal(stages.whatsappUrl("98765 43210", "hi there").startsWith("https://wa.me/919876543210?text=hi%20there"), true);
  assert.equal(stages.whatsappUrl("+91 98765-43210", "x").startsWith("https://wa.me/919876543210?"), true);
  assert.equal(stages.whatsappUrl("", "x").startsWith("https://wa.me/?"), true);
});

test("Cloud Functions are exported: login required to create, public to read", () => {
  const src = read("functions/index.js");
  assert.match(src, /exports\.createOrderTrackingLink = onCall\(\s*\{ region: "asia-south1" \}/);
  assert.match(src, /exports\.getOrderTracking = onCall\(\s*\{ region: "asia-south1"/);
  const create = src.slice(src.indexOf("exports.createOrderTrackingLink"), src.indexOf("exports.getOrderTracking"));
  assert.match(create, /if \(!request\.auth\)/);
  assert.match(create, /uid: request\.auth\.uid/);
  assert.ok(!/request\.data\.uid|data\.uid/.test(create), "uid must never come from client data");
});

test("sales-history: 4 stages, ETA, tracking link, and stage timestamps", () => {
  const h = read("sales-history.html");
  assert.match(h, /import \{ STAGES, normalizeStage, trackingUrl, trackingMessage, whatsappUrl \} from "\.\/js\/order-stages\.js"/);
  assert.match(h, /"createOrderTrackingLink"/);
  assert.match(h, /STAGES\.map\(st => `<option value="\$\{st\.key\}"/);
  assert.match(h, /orderStage: newStage, \['stageTimes\.' \+ newStage\]: now/);
  assert.match(h, /window\.updateEta = /);
  assert.match(h, /deliveryDate: newValue/);
  assert.match(h, /window\.copyTrackingLink = /);
  assert.match(h, /window\.sendTrackingOnWhatsApp = /);
  assert.match(h, /\.stage-select\.stage-Processing/);
  const headerCols = (h.match(/<tr>\s*<th>Order No\.[\s\S]*?<\/tr>/)[0].match(/<th>/g) || []).length;
  assert.equal(headerCols, 11);
  assert.match(h, /<th>Est\. Collection<\/th>/);
  assert.ok(!h.includes('colspan="10"'), "colspan must match the 11 columns");
});

test("create-order: starts at Pending with a timestamp, creates the link after saving", () => {
  const h = read("create-order.html");
  assert.match(h, /orderStage: 'Pending',\s*\n\s*\/\/[^\n]*\n\s*stageTimes: \{ Pending: new Date\(\)\.toISOString\(\) \}/);
  assert.match(h, /createOrderTrackingLink/);
  assert.match(h, /id="track-wa-btn"/);
  assert.match(h, /window\.sendSavedTracking = /);
  // link creation sits after the order is saved and inside its own try/catch, so it cannot block the save
  const saveIdx = h.indexOf("const savedRef = await addDoc");
  const tryIdx = h.indexOf("try {", saveIdx + 10);
  assert.ok(saveIdx > 0 && tryIdx > saveIdx && h.indexOf("Tracking link not created") > tryIdx);
});

test("customer-history knows the new stage", () => {
  assert.match(read("customer-history.html"), /'Processing': \['#EDE9FE'/);
});

test("track.html: private, no data injection, uses only the public function", () => {
  const h = read("track.html");
  assert.match(h, /<meta name="robots" content="noindex, nofollow">/);
  assert.match(h, /<meta name="referrer" content="no-referrer">/);
  assert.match(h, /"getOrderTracking"/);
  assert.ok(!/innerHTML|outerHTML|insertAdjacentHTML|document\.write/.test(h), "must render with textContent only");
  assert.ok(!/import[^;]*?(firebase-firestore|firebase-auth|firebase-config)/.test(h), "public page must not import Firestore/Auth/config");
  assert.match(h, /import \{ STAGES, stageIndex \} from "\.\/js\/order-stages\.js"/);
});
