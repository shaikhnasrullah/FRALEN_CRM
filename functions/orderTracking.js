"use strict";
/*
 * Customer Order Tracking: backend logic.
 *
 * Model
 *   users/{uid}/orders/{orderId}   the real order (owner-only via Firestore rules). Gains `trackingToken`.
 *   orderTracking/{token}          pointer only: { uid, orderId, createdAt }. Clients never touch it.
 *
 * The public page calls getOrderTracking({ token }). The function resolves the pointer, reads the
 * LIVE order (so Sales History updates show up instantly, nothing to sync) and returns ONLY the
 * whitelisted fields built by buildPublicView(). No mobile, address, email, amounts, items, notes
 * or prescription ever leave the server.
 *
 * Kept free of firebase-functions imports (HttpsError is injected) so it is unit-testable.
 */
const crypto = require("crypto");

// Keep in sync with js/order-stages.js (a test enforces this).
const STAGES = ["Pending", "Processing", "Ready", "Delivered"];
const TOKEN_RE = /^[A-Za-z0-9_-]{22,64}$/;
const NOT_FOUND_MESSAGE = "This tracking link is not valid.";

/** 18 random bytes = 144 bits, 24 url-safe characters. */
function generateToken() {
  return crypto.randomBytes(18).toString("base64url");
}

function isValidToken(token) {
  return typeof token === "string" && TOKEN_RE.test(token);
}

function normalizeStage(stage) {
  return STAGES.includes(stage) ? stage : "Pending";
}

function cleanString(value, max) {
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}

function firstName(name) {
  return cleanString(name, 60).split(/\s+/)[0] || "";
}

function cleanDate(value) {
  if (typeof value !== "string") return null;
  const m = /^(\d{4}-\d{2}-\d{2})/.exec(value.trim());
  return m ? m[1] : null;
}

function cleanTimestamp(value) {
  if (typeof value !== "string") return null;
  const t = Date.parse(value);
  return Number.isNaN(t) ? null : new Date(t).toISOString();
}

/** The ONLY shape that is ever returned to an unauthenticated caller. */
function buildPublicView(order, profile) {
  const o = order || {};
  const p = profile || {};
  const stageTimes = {};
  const raw = o.stageTimes && typeof o.stageTimes === "object" ? o.stageTimes : {};
  for (const stage of STAGES) {
    const iso = cleanTimestamp(raw[stage]);
    if (iso) stageTimes[stage] = iso;
  }
  if (!stageTimes.Pending) {
    const created = cleanTimestamp(o.createdAt);
    if (created) stageTimes.Pending = created;
  }
  return {
    orderNo: cleanString(o.orderNo, 40),
    customerFirstName: firstName(o.customerName),
    stage: normalizeStage(o.orderStage),
    stageTimes,
    estimatedCollectionDate: cleanDate(o.deliveryDate),
    orderDate: cleanDate(o.orderDate) || cleanDate(o.createdAt),
    shopName: cleanString(p.shopName, 80),
    shopPhone: cleanString(p.phone, 20),
  };
}

function ordersRef(db, uid) {
  return db.collection("users").doc(uid).collection("orders");
}

/**
 * Idempotently gives an order (owned by `uid`) a tracking token and pointer.
 * `uid` must come from request.auth, never from client data.
 */
async function createTrackingLink({
  db, uid, orderId, HttpsError, now = () => new Date().toISOString(), makeToken = generateToken,
}) {
  if (!uid) throw new HttpsError("unauthenticated", "Please sign in.");
  if (typeof orderId !== "string" || !orderId || orderId.length > 200 || orderId.includes("/")) {
    throw new HttpsError("invalid-argument", "A valid orderId is required.");
  }
  const orderRef = ordersRef(db, uid).doc(orderId);

  return db.runTransaction(async (tx) => {
    const orderSnap = await tx.get(orderRef);
    if (!orderSnap.exists) throw new HttpsError("not-found", "Order not found.");

    const existing = (orderSnap.data() || {}).trackingToken;
    if (isValidToken(existing)) {
      const pointerRef = db.collection("orderTracking").doc(existing);
      const pointerSnap = await tx.get(pointerRef);
      if (!pointerSnap.exists) {
        tx.set(pointerRef, { uid, orderId, createdAt: now() });
        return { success: true, token: existing };
      }
      const p = pointerSnap.data() || {};
      if (p.uid === uid && p.orderId === orderId) return { success: true, token: existing };
      // A token that points elsewhere must never be reused: fall through and issue a fresh one.
    }

    for (let attempt = 0; attempt < 5; attempt++) {
      const token = makeToken();
      const pointerRef = db.collection("orderTracking").doc(token);
      const pointerSnap = await tx.get(pointerRef);
      if (pointerSnap.exists) continue;
      tx.set(pointerRef, { uid, orderId, createdAt: now() });
      tx.update(orderRef, { trackingToken: token });
      return { success: true, token };
    }
    throw new HttpsError("internal", "Could not create a tracking link. Please try again.");
  });
}

/** Public lookup. Every failure is the same "not valid" error so tokens cannot be probed. */
async function getTracking({ db, token, HttpsError }) {
  const notFound = () => new HttpsError("not-found", NOT_FOUND_MESSAGE);
  if (!isValidToken(token)) throw notFound();

  const pointerSnap = await db.collection("orderTracking").doc(token).get();
  if (!pointerSnap.exists) throw notFound();
  const { uid, orderId } = pointerSnap.data() || {};
  if (typeof uid !== "string" || !uid || typeof orderId !== "string" || !orderId) throw notFound();

  const [orderSnap, profileSnap] = await Promise.all([
    ordersRef(db, uid).doc(orderId).get(),
    db.collection("users").doc(uid).get(),
  ]);
  if (!orderSnap.exists) throw notFound();
  const order = orderSnap.data() || {};
  // Token on the order is the source of truth: replacing it revokes the old link.
  if (order.trackingToken !== token) throw notFound();

  return { success: true, tracking: buildPublicView(order, profileSnap.exists ? profileSnap.data() : {}) };
}

module.exports = {
  STAGES, TOKEN_RE, NOT_FOUND_MESSAGE,
  generateToken, isValidToken, normalizeStage, buildPublicView, createTrackingLink, getTracking,
};
