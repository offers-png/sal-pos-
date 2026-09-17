# Physical pilot results — NOT YET EXECUTED

Build/version and installer SHA256:

Tester / date / store or test site:

| Hardware | Exact model and configuration |
|---|---|
| PC and CPU architecture | |
| Windows edition/build | |
| Scanner and mode | |
| Printer, driver version, connection and paper width | |
| Drawer and connection | |
| Customer display and resolution | |
| External payment terminal (recording only) | |

For each check, use PASS / FAIL / NOT RUN and attach the actual result. Expected steps are in HARDWARE-SUPPORT.md.

| Check | Status | Evidence / actual result |
|---|---|---|
| Clean install, no developer tools | NOT RUN | |
| Upgrade preserving existing store data | NOT RUN | |
| 100 scans / leading zeros / sleep-wake | NOT RUN | |
| Receipt printer and disconnected retry | NOT RUN | |
| Cash drawer opens once, no reprint opening | NOT RUN | |
| Dual screen / marketing / reconnect | NOT RUN | |
| Offline shift | NOT RUN | |
| Sales / refunds / voids / reconciliation | NOT RUN | |
| Backup and restore on another profile | NOT RUN | |

Defects and retest evidence:

Commercial acceptance decision and person responsible:

After passing, add a record in release-readiness.json with tester, testedAt, windowsVersion, pcModel, scannerModel, printerModel, drawerModel, reportFile (repository-relative path to this completed report), and checks named cleanInstall, upgrade, scanner, receiptPrinter, cashDrawer, dualScreen, offlineSale, refund, backupRestore, each with value "pass".
