$ErrorActionPreference = 'Stop'
if (-not $env:SAL_SIGNING_PUBLISHER) { throw 'SAL_SIGNING_PUBLISHER is required.' }
$projectDir = Split-Path -Parent $PSScriptRoot
$package = Get-Content -LiteralPath (Join-Path $projectDir 'package.json') -Raw | ConvertFrom-Json
$artifacts = @((Join-Path $projectDir 'dist/win-unpacked/Sal POS.exe'), (Join-Path $projectDir ("dist/Sal POS Setup " + $package.version + '.exe')))
foreach ($artifact in $artifacts) {
  $signature = Get-AuthenticodeSignature -LiteralPath $artifact
  if ($signature.Status -ne 'Valid') { throw "Invalid or missing signature: $artifact" }
  $publisher = $signature.SignerCertificate.GetNameInfo([System.Security.Cryptography.X509Certificates.X509NameType]::SimpleName, $false)
  if ($publisher -ne $env:SAL_SIGNING_PUBLISHER) { throw "Unexpected publisher: $artifact" }
  if (-not $signature.TimeStamperCertificate) { throw "Missing timestamp: $artifact" }
}
Write-Output 'Installer and application have valid, timestamped signatures from the expected publisher.'
