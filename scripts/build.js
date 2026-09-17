const path = require('path');
const { build, Platform } = require('electron-builder');
const release = process.argv.includes('--release');
const config = {};
if (process.env.ELECTRON_CACHE) config.electronDownload = { cache: path.resolve(process.env.ELECTRON_CACHE) };
if (release) {
  if (!process.env.SAL_SIGNING_PUBLISHER || !(process.env.CSC_LINK || process.env.WIN_CSC_LINK || process.env.SAL_CERTIFICATE_SHA1)) {
    console.error('Signed build requires SAL_SIGNING_PUBLISHER and a configured signing certificate. See docs/RELEASING.md.');
    process.exit(1);
  }
  config.forceCodeSigning = true;
  config.win = { signtoolOptions: {
    publisherName: process.env.SAL_SIGNING_PUBLISHER,
    ...(process.env.SAL_CERTIFICATE_SHA1 ? { certificateSha1: process.env.SAL_CERTIFICATE_SHA1 } : {})
  } };
} else {
  // Pilot builds are never published by this script and must not masquerade as signed releases.
  process.env.CSC_IDENTITY_AUTO_DISCOVERY = 'false';
}
build({ targets: Platform.WINDOWS.createTarget('nsis'), publish: 'never', config }).catch(error => { console.error(error.message); process.exitCode = 1; });
