# 1.0.38-rc.1 — Release readiness

- Fix packaged updater discovery, disable automatic installation on exit, guard active carts/shifts and create pre-update backups.
- Add durable daily backups, visible backup status, safe port-conflict startup, and privacy-conscious support reports.
- Add recovery/scanner/receipt regression tests, package/signature checks, a draft-release workflow and customer/hardware/support documentation.
- This is an unsigned candidate; physical hardware acceptance and seller/signing setup remain outstanding.

# 1.0.37 — Local convenience-store setup

- Remove Google Sheets integration, credential discovery, sync controls and the Google API dependency. Products and sales persist locally without an account or Internet connection.
- Start new stores with an empty catalog; preserve existing store databases and support CSV import and database backup/restore.
- Add local marketing-image management and safe second-monitor startup. Marketing images survive app updates.
- Apply store branding to customer displays and daily reports; fix local report dates, Settings product counts, failed product-save feedback, large backup uploads, and end-of-day print retries.
- Remove external font loading and stale release metadata.

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
