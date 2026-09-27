param(
  [string]$Repository = 'Rayness/StreamHelper-Releases',
  [string]$OutputDirectory = '',
  [switch]$ValidateOnly
)

$ErrorActionPreference = 'Stop'
$project = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')).Path
$version = (Get-Content -LiteralPath (Join-Path $project 'package.json') -Raw | ConvertFrom-Json).version
if (-not $OutputDirectory) { $OutputDirectory = Join-Path $project "dist/$version" }
$output = (Resolve-Path -LiteralPath $OutputDirectory).Path
$setup = Join-Path $output "StreamHelper-Setup-$version.exe"
$blockmap = "$setup.blockmap"
$manifest = Join-Path $output 'latest.yml'
foreach ($file in @($setup, $blockmap, $manifest)) {
  if (-not (Test-Path -LiteralPath $file -PathType Leaf)) { throw "Missing release file: $file" }
}
if ((Get-Item -LiteralPath $setup).VersionInfo.ProductVersion -ne $version) { throw 'Installer version does not match package.json' }
if (-not (Select-String -LiteralPath $manifest -Pattern "^version: $([regex]::Escape($version))$" -Quiet)) { throw 'latest.yml version does not match package.json' }
$signature = Get-AuthenticodeSignature -LiteralPath $setup
if ($signature.Status -ne 'Valid') { throw "Installer must have a trusted code-signing signature before publication (status: $($signature.Status))" }
if ($ValidateOnly) {
  Write-Output "Release files for $version are valid in $output"
  return
}

$repo = & gh repo view $Repository --json isPrivate,url,defaultBranchRef | ConvertFrom-Json
if ($LASTEXITCODE -ne 0) { throw "Cannot access release repository $Repository" }
if ($repo.isPrivate) { throw 'Update repository must be public for users to download updates without a token' }
if (-not $repo.defaultBranchRef.name) { throw 'Release repository needs a default branch' }

& gh release create "v$version" $setup $blockmap $manifest -R $Repository --target $repo.defaultBranchRef.name --title "StreamHelper $version" --notes "Windows release $version. Install manually once; future updates are downloaded in StreamHelper." --latest
if ($LASTEXITCODE -ne 0) { throw 'Release publication failed' }
