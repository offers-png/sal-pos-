# Hardware support and pilot acceptance

Status: release candidate. **No physical hardware combination has been certified yet.** Automated tests simulate device interfaces; they do not prove that a specific scanner, printer or drawer works.

| Component | Intended supported configuration | Not currently supported or claimed |
|---|---|---|
| Register PC | Windows 10/11, x64 Intel/AMD, writable user profile | Windows 7/8, 32-bit Windows, native ARM64 build, Android, iPad, macOS/Linux releases |
| Scanner | USB keyboard/HID mode with Enter suffix | Serial/vendor SDK scanner integration |
| Receipt printer | Windows-installed driver; select and test in Settings | Every printer brand/model, raw USB printing without a driver |
| Receipt paper | Current receipt layout targets 80 mm thermal rolls | 58 mm formatting without a device-specific layout test |
| Cash drawer | Drawer connected to a compatible receipt printer accepting ESC/POS drawer pulse | Independent serial/USB drawers or vendor-specific protocols |
| Customer screen | Second Windows monitor in Extend mode; local image rotation | Android/iPad companion screens, video playback, shared network displays |
| Payments | Record cash and payments completed on an external terminal | Direct card authorization, card-number collection, integrated terminal reconciliation |
| Store layout | One local database per Windows user/profile on each PC | Shared inventory across registers or stores |

Windows runtime baseline: [Electron Windows support](https://www.electronjs.org/blog/windows-7-to-8-1-deprecation-notice). This is an intended compatibility boundary, not a list of tested devices.

## Required physical pilot

Record exact PC model, Windows edition/build, scanner model/mode, printer model/driver/version/connection, paper width, drawer model/connection, monitor resolution and external payment-terminal model. Use test transactions and a test database.

1. **Clean install:** install under a normal Windows account without Node.js or developer tools. Create an owner; configure branding/tax; verify an empty catalog. Launch after reboot with Internet disconnected.
2. **Scanner:** scan at least 100 items, including leading-zero barcodes, unknown products, rapid repeated scans, scans after typing into a form, and scans after sleep/wake. Verify quantities and that Enter never repeats checkout.
3. **Printer:** print configured name/phone/footer, long names, discounts, tax, split tender, a refund record and an old receipt. Check widths, clipping, paper cut, original receipt date, and legibility. Disconnect printer, attempt printing, reconnect, and retry without recording another sale.
4. **Drawer:** cash checkout opens once. Reprinting never opens it. Check cashier no-sale behavior and error feedback while disconnected. Verify card-only checkout does not open it unless the store intentionally requires that behavior.
5. **Dual screen:** Windows Extend mode, monitor positioned left/right of register, cart updates, store branding, image upload/remove/rotation, reboot. Disconnect monitor and confirm cashier operation continues; reopen the display after reconnecting.
6. **Full shift:** owner creates cashier; cashier signs in; manager restrictions hold. Starting cash → sales with each tender → discounted/taxed sale → partial refund → void → count drawer → close shift. Independently reconcile cents, stock, net tax and each tender with expected results.
7. **Recovery:** save backup to external drive; disconnect drive and confirm clear failure; restore backup to another isolated Windows profile. Verify employees, PIN login, settings, products, stock, sales and returns. Copy marketing-images separately. Terminate the app during an uncertain sale, restart, and verify retry creates at most one sale.
8. **Upgrade:** install the new build over the previous pilot under the same Windows account. Verify data, printer choice and marketing images survive. Check update denial with an open cart or shift. Check the pre-update backup. Test uninstall/reinstall without selecting any data-removal option.
9. **Offline:** disconnect Internet for a full shift, then reconnect. Sales, returns, inventory, receipt lookup and local backups must continue. A failed update check must not interrupt checkout.

Fill in `PILOT-RESULTS-TEMPLATE.md`, attach evidence, record any failure and retest the exact fix. Only add a combination to the sold-as-supported list once every applicable check passes. Do not mark simulated tests as physical-device evidence.
