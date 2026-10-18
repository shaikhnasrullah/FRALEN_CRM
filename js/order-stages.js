// Order stages shared by Sales History, Create Order and the public tracking page.
// Stored values keep the original names (Pending / Ready / Delivered) so existing orders and
// reports keep working; "Processing" is new. Keep keys in sync with functions/orderTracking.js.
export const STAGES = [
  { key: "Pending",    label: "Order received",        icon: "📝", shopLabel: "⏳ Order received" },
  { key: "Processing", label: "Lens/frame processing", icon: "🔧", shopLabel: "🔧 Lens/frame processing" },
  { key: "Ready",      label: "Ready for collection",  icon: "📦", shopLabel: "📦 Ready for collection" },
  { key: "Delivered",  label: "Delivered",             icon: "✅", shopLabel: "✅ Delivered" },
];

export const TRACKING_BASE = "https://www.fralencrm.in";

export function normalizeStage(stage) {
  return STAGES.some((s) => s.key === stage) ? stage : "Pending";
}

export function stageIndex(stage) {
  return STAGES.findIndex((s) => s.key === normalizeStage(stage));
}

export function trackingUrl(token, base = TRACKING_BASE) {
  return `${base}/track.html?t=${encodeURIComponent(token)}`;
}

export function trackingMessage({ customerName, shopName, orderNo, url }) {
  const name = (customerName || "").trim().split(/\s+/)[0];
  const hello = name ? `Namaste ${name},` : "Namaste,";
  const shop = (shopName || "").trim();
  const order = [orderNo ? `order ${orderNo}` : "order", shop ? `(${shop})` : ""].filter(Boolean).join(" ");
  return `${hello} aapka ${order} ka status yahan dekhein (login ki zaroorat nahi):\n${url}`;
}

/** wa.me link; 10-digit Indian numbers get the 91 prefix. Returns a number-less link if no mobile. */
export function whatsappUrl(mobile, text) {
  const digits = String(mobile || "").replace(/\D/g, "");
  const wa = digits.length === 10 ? "91" + digits : digits;
  return `https://wa.me/${wa}?text=${encodeURIComponent(text)}`;
}
