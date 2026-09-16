# 1.0.36

- Await saved sales before clearing the cart; preserve retry IDs across reloads and show receipt IDs/tenders.
- Calculate prices, discounts, tax, and refunds in cents; enforce quantity and original-payment limits.
- Commit sales, inventory, returns, voids, and the sales export queue atomically; use durable file replacement and validated live restore.
- Store split tenders and include refunds in reconciliation. Flag legacy unallocated splits.
- Add sessions, role checks, owner setup, default-PIN replacement, PIN throttling, loopback binding, restricted static serving, CSP, sanitization, and authenticated IPC.
- Preserve product fields during Sheets sync; respect explicit EBT overrides and taxable flags.
- Secure printer-name handling, restore Electron sandboxing, and serve marketing images from the local app.
- Remove unused ESC/POS dependencies, update runtime/build dependencies, correct the GitHub update repository, and exclude shop data/credentials from installers.
- Add regression tests, Windows CI, and operating/upgrade documentation.
