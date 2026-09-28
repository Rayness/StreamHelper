param(
  [string]$Repository = 'Rayness/StreamHelper-Releases',
  [string]$OutputDirectory = '',
  [string]$NotesFile = '',
  [switch]$ValidateOnly,
  [switch]$AllowUnsigned
)

$ErrorActionPreference = 'Stop'
$project = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')).Path
$version = (Get-Content -LiteralPath (Join-Path $project 'package.json') -Raw | ConvertFrom-Json).version
if (-not $OutputDirectory) { $OutputDirectory = Join-Path $project "dist/$version" }
$output = (Resolve-Path -LiteralPath $OutputDirectory).Path
$setup = Join-Path $output "StreamHelper-Setup-$version.exe"
$blockmap = "$setup.blockmap"
$manifest = Join-Path $output 'latest.yml'
$checksums = Join-Path $output 'SHA256SUMS.txt'
foreach ($file in @($setup, $blockmap, $manifest)) {
  if (-not (Test-Path -LiteralPath $file -PathType Leaf)) { throw "Missing release file: $file" }
}
if ((Get-Item -LiteralPath $setup).VersionInfo.ProductVersion -ne $version) { throw 'Installer version does not match package.json' }
if (-not (Select-String -LiteralPath $manifest -Pattern "^version: $([regex]::Escape($version))$" -Quiet)) { throw 'latest.yml version does not match package.json' }
if (Test-Path -LiteralPath $checksums -PathType Leaf) {
  $expectedLine = "$(Get-FileHash -LiteralPath $setup -Algorithm SHA256 | ForEach-Object { $_.Hash.ToLowerInvariant() })  $(Split-Path -Leaf $setup)"
  if ((Get-Content -LiteralPath $checksums -TotalCount 1) -ne $expectedLine) { throw 'SHA256SUMS.txt does not match installer' }
}
$signature = Get-AuthenticodeSignature -LiteralPath $setup
if ($signature.Status -ne 'Valid') {
  if (-not $AllowUnsigned) { throw "Installer must have a trusted code-signing signature before publication (status: $($signature.Status))" }
  Write-Warning "Unsigned installer explicitly allowed for this release (status: $($signature.Status))"
}
if ($NotesFile) { $NotesFile = (Resolve-Path -LiteralPath $NotesFile).Path }
if ($ValidateOnly) {
  Write-Output "Release files for $version are valid in $output"
  return
}

$repo = & gh repo view $Repository --json isPrivate,url,defaultBranchRef | ConvertFrom-Json
if ($LASTEXITCODE -ne 0) { throw "Cannot access release repository $Repository" }
if ($repo.isPrivate) { throw 'Update repository must be public for users to download updates without a token' }
if (-not $repo.defaultBranchRef.name) { throw 'Release repository needs a default branch' }

$assets = @($setup, $blockmap, $manifest)
if (Test-Path -LiteralPath $checksums -PathType Leaf) { $assets += $checksums }
if ($NotesFile) {
  & gh release create "v$version" @assets -R $Repository --target $repo.defaultBranchRef.name --title "StreamHelper $version" --notes-file $NotesFile --latest
} else {
  & gh release create "v$version" @assets -R $Repository --target $repo.defaultBranchRef.name --title "StreamHelper $version" --notes "Windows release $version. Install manually once; future updates are downloaded in StreamHelper." --latest
}
if ($LASTEXITCODE -ne 0) { throw 'Release publication failed' }
