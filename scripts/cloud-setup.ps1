param(
 [ValidateSet('Check','LinkDatabase','Migrate')][string]$Action='Check',
 [string]$ProjectRef
)
$ErrorActionPreference='Stop'
Set-Location -LiteralPath (Split-Path -Parent $PSScriptRoot)
function Invoke-Checked {param([string[]]$Arguments) & npx.cmd @Arguments; if($LASTEXITCODE -ne 0){throw "CLI failed: $($Arguments[0])"}}
switch($Action){
 'Check' {
  & npm.cmd run typecheck; if($LASTEXITCODE -ne 0){throw 'Typecheck failed'}
  & npm.cmd test; if($LASTEXITCODE -ne 0){throw 'Tests failed'}
  & npm.cmd run build; if($LASTEXITCODE -ne 0){throw 'Build failed'}
 }
 'LinkDatabase' {
  if($ProjectRef -notmatch '^[a-z]{20}$'){throw 'Use the project ref of your NEW IdeaDock-only Supabase project.'}
  if(-not(Test-Path -LiteralPath 'supabase/config.toml')){Invoke-Checked -Arguments @('supabase','init')}
  Invoke-Checked -Arguments @('supabase','login')
  Invoke-Checked -Arguments @('supabase','link','--project-ref',$ProjectRef)
 }
 'Migrate' {
  if(-not(Test-Path -LiteralPath 'supabase/.temp/project-ref')){throw 'LinkDatabase must run first.'}
  $linked=(Get-Content -LiteralPath 'supabase/.temp/project-ref' -Raw).Trim()
  if(-not $ProjectRef -or $linked -ne $ProjectRef){throw 'Pass -ProjectRef matching your dedicated IdeaDock project.'}
  Invoke-Checked -Arguments @('supabase','db','push','--dry-run')
  Invoke-Checked -Arguments @('supabase','db','push')
 }
}
