# Sal POS 1.0.38 release candidate

- Fix installed-app update discovery and prevent silent update installation during Windows exit.
- Require a cleared cart and closed shift before update installation; create a local pre-update backup.
- Add durable, uniquely named daily backups with retry when the external drive is unavailable.
- Fail safely on a blocked local-server port instead of opening another service.
- Add a technical support-report export without employee or receipt contents.
- Add crash/recovery regression tests, package verification, signing verification, a draft-release workflow, and hardware acceptance/setup/support guides.

No Google Sheets or cloud account is required for store data. This is a pilot release candidate. Physical hardware acceptance and code signing remain unverified until recorded in the release evidence.
