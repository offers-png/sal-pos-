# Support and recovery guide

The seller's support contact has not been supplied. Before customer sales, set sellerName/supportEmail in release-readiness.json and include those details with the sale. Do not advertise an invented support address or support response time.

## Information to collect

In Settings, choose **Save support report**. The JSON contains version, OS/runtime, display dimensions, selected printer label, database health and record counts. It excludes PINs, employee account details, receipt contents and database files. Review before sharing. The app does not upload it automatically.

Also record what happened, the displayed error, time, app version, hardware models, whether it happens offline, and steps to reproduce. Do not send customer payment details or database backups unless an appropriate private support process is arranged.

## Common problems

| Symptom | Action |
|---|---|
| Scanner does not add products | Check USB keyboard/HID mode and Enter suffix. Test typing in a plain text field; return focus to the register. Confirm the barcode exists and leading zeros are preserved. |
| Wrong or missing printer | Check Windows can print a test page, then select the correct printer in Settings → Hardware. Check paper/connection and retry the receipt, not the sale. |
| Cash drawer does not open | Check printer connection and drawer cable/pulse compatibility. A successful receipt print does not guarantee drawer support. |
| Blank customer screen | Confirm Windows Extend mode, upload local images, and choose Open customer screen. Reconnect and reopen if a monitor was unplugged. |
| Port 5000 is already in use | Close another Sal POS instance or the application using that port. The app stops safely rather than connecting to an unknown service. |
| Database cannot open | Preserve the original database and backups. Do not delete the database or start selling against a new empty store. Restore a verified backup in an isolated installation and reconcile any transactions since the backup. |
| Backup drive unavailable | Connect it and confirm its path/drive letter. Choose the folder again if changed; run Backup Now. A backup on the same drive does not protect against drive failure. |
| Uncertain checkout after interruption | Reopen the register and retry its saved pending transaction. Do not clear browser storage or create a fresh charge until the original receipt/terminal payment is reconciled. |
| Update refused | Finish/clear the cart and close the shift. Confirm the local backup folder is writable. An unsigned pilot should not be used as a production auto-update release. |

## Store-data incident

Stop writes if data appears wrong. Preserve the live database, `.pre-<version>.db` migration copy, emergency restore copy and external backups. Record last known good sale and any external-terminal transactions. Validate the backup on a separate Windows profile before replacing live data. Restore invalidates sessions; sign in again and verify accounts, stock, receipts and shifts. Keep the damaged/original files until reconciliation is complete.

## Support scope to publish with the product

State supported hardware combinations, Windows versions, installation assistance, backup responsibilities, contact channel/hours and how fixes are delivered. This repository does not establish a service-level agreement, warranty, payment processing service or multi-register synchronization service.
