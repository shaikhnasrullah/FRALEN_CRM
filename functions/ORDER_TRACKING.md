# Customer Order Tracking Portal

Customers open `https://www.fralencrm.in/track.html?t=<random token>` (no login) and see:
Order received -> Lens/frame processing -> Ready for collection -> Delivered, plus the estimated collection date.

## How it works
- **One source of truth:** the existing order fields in `users/{uid}/orders/{id}`:
  `orderStage` (`Pending` / `Processing` / `Ready` / `Delivered`; `Pending` is shown as "Order received"),
  `deliveryDate` (shown as "Estimated collection"), and new `stageTimes.<Stage>` (when each stage was reached).
  Changing the stage or date in **Sales History** is all that is needed: the tracking page reads the live order.
- **Link:** `createOrderTrackingLink` (login required, works only on the caller's own orders) stores a
  144-bit random token as `trackingToken` on the order and a pointer in `orderTracking/{token}`.
- **Public read:** `getOrderTracking({token})` (no login) returns only: order no., customer *first name*, stage,
  stage times, estimated date, order date, shop name and shop phone. Never mobile, address, email, amounts,
  items, notes or prescription. Any bad/unknown/revoked token gives the same "not valid" error.
- To revoke a link, change/remove `trackingToken` on the order.

## Deploy
```
cd functions && npm install && cd ..
firebase deploy --only functions:createOrderTrackingLink,functions:getOrderTracking --project loginpage1-16430
```
Then push the HTML/JS (`track.html`, `js/order-stages.js`, `sales-history.html`, `create-order.html`, `customer-history.html`).

## Firestore rules: please check (the rules file is not in this repo)
1. `orderTracking` must NOT be readable/writable by clients, or logged-in users could list tokens. Add:
   ```
   match /orderTracking/{token} { allow read, write: if false; }
   ```
   (and make sure no catch-all `match /{document=**}` rule allows it).
2. Shop owners must be able to update `orderStage`, `stageTimes` and `deliveryDate` on their own orders
   (Sales History already updates `orderStage`; if your rules whitelist fields, add the other two).
