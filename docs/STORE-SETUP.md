# Store installation and first shift

This build is a release candidate for pilot testing, not a certified universal-hardware product. Read HARDWARE-SUPPORT.md first.

1. Download the installer from the seller's release page. Confirm the version and SHA256 against SHA256SUMS.txt. A customer release must show the expected publisher in Windows file properties → Digital Signatures. An unsigned pilot is only for your controlled test PC.
2. Install under the Windows account that will operate the register. No Node.js, Google account, spreadsheet or cloud credentials are needed. Keep using this account after upgrades: different Windows profiles have separate databases.
3. Create the owner with a unique 6–12 digit PIN. In Settings, enter store name, phone, receipt footer and tax rate. Create an individual account for each employee. Owner/manager roles can change products, settings, users and perform returns/voids; cashier accounts handle checkout.
4. Add products, or import CSV with barcode, name and price headers. Preserve barcodes as text, including leading zeros. Set cost, starting stock, reorder point, taxable/EBT flags and age restrictions for each product. Products supports price search and a low-stock filter.
5. Install the printer's Windows driver, choose it under Settings → Hardware, and print a test. Connect a keyboard/HID scanner with an Enter suffix. Test the drawer independently. Do not begin live trading until the physical acceptance checklist passes.
6. Connect the customer monitor in Windows Extend mode. Settings lets a manager add/remove promotional images and open the customer screen. Images are local and survive application upgrades.
7. Choose an existing external-drive backup folder in Settings. Run Backup Now and verify the resulting file exists. The app also attempts one daily backup at startup and hourly while open. An unavailable drive is retried later; it is not a successful backup. Keep multiple dated backups.
8. Open a shift with counted starting cash. Make a test sale, print/reprint it, refund it, and reconcile stock and totals. At closing, count cash, close the shift, print the daily report and confirm the backup.

## Data and transfers

The database is normally `%APPDATA%/sal-pos/sal-pos.db`; the application status shows the actual path. Save the database backup and the `marketing-images` folder beside it. A database backup contains accounts, settings, products, inventory, sales, returns and shifts. Marketing files are separate.

To move a store, close the source app, copy a verified database backup and marketing-images folder, install on the target PC, use Settings → Restore Full Database, sign in again, copy marketing images while the app is closed, and select/test that PC's printer. Keep the original PC unchanged until the transfer is checked. Do not trade on both copies expecting synchronization.

## Receipts and payments

Recent receipts appear in Reports → Sales History; older receipts can be retrieved by ID. Reprints use original sale amounts/date and current store branding. Reprinting does not repeat the sale or open the drawer.

Card and EBT tender buttons record a payment taken on an external terminal. This app does not authorize or transfer funds. Refund the external payment separately and reconcile it with the POS return. Store Credit is a recorded tender, not a customer balance ledger. Split-tender return limitations and legacy unallocated tenders are described in README.md.

## Updates

Finish checkout, clear the cart and close the shift before updating. The release-candidate update flow creates a local pre-update backup and does not install automatically when Windows shuts down. A failed or unavailable Internet update check must not prevent local sales. Older 1.0.37 installations may require manually running the newer installer because their packaged update discovery was defective. Use the same Windows account and retain store data.
