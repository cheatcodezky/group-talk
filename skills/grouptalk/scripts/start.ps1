$ErrorActionPreference = 'Stop'
$cli = Join-Path $PSScriptRoot '../server/cli.mjs'
$checkNode = Join-Path $PSScriptRoot 'check-node.cjs'

function Test-Node($Binary) {
    if (!$Binary -or !(Test-Path -LiteralPath $Binary -PathType Leaf)) { return $false }
    $ErrorActionPreference = 'SilentlyContinue'
    $PSNativeCommandUseErrorActionPreference = $false
    & $Binary --no-warnings $checkNode *> $null
    return $LASTEXITCODE -eq 0
}

$node = (Get-Command node.exe -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1).Source
if (Test-Node $node) {
    & $node $cli @args
    exit $LASTEXITCODE
}

$platform = if ($env:PROCESSOR_ARCHITEW6432) { $env:PROCESSOR_ARCHITEW6432 } else { $env:PROCESSOR_ARCHITECTURE }
$arch = switch ($platform) {
    'AMD64' { 'x64' }
    'ARM64' { 'arm64' }
    default { throw 'Install Node.js 22.13 or later with SQLite support and make node.exe available on PATH for this architecture.' }
}
$manifest = Get-Content -LiteralPath (Join-Path $PSScriptRoot 'node-release.txt')
$version = $manifest[0]
$runtimeRoot = if ($env:GROUPTALK_RUNTIME_DIR) { $env:GROUPTALK_RUNTIME_DIR } else { Join-Path $HOME '.grouptalk/runtime' }
$binaryDir = Join-Path (Join-Path $runtimeRoot $version) "win-$arch"
$node = Join-Path $binaryDir 'node.exe'

if (!(Test-Node $node)) {
    $artifact = "win-$arch/node.exe"
    $expected = $manifest | ForEach-Object {
        $fields = $_ -split '\s+'
        if ($fields.Length -eq 2 -and $fields[1] -eq $artifact) { $fields[0] }
    }
    if (!$expected) { throw "Missing the pinned SHA-256 for $artifact." }
    New-Item -Force -ItemType Directory -Path $binaryDir | Out-Null
    $temp = New-Item -ItemType Directory -Path (Join-Path $binaryDir ('.download.' + [guid]::NewGuid()))
    $stagedNode = Join-Path $temp.FullName 'node.exe'
    try {
        [Console]::Error.WriteLine("GroupTalk: Installing Node.js $version in $binaryDir")
        Invoke-WebRequest -UseBasicParsing -TimeoutSec 180 -Uri "https://nodejs.org/dist/$version/$artifact" -OutFile $stagedNode
        if ((Get-FileHash -LiteralPath $stagedNode -Algorithm SHA256).Hash -ne $expected) {
            throw "Node.js download $artifact failed SHA-256 verification."
        }
        if (!(Test-Node $stagedNode)) { throw 'The downloaded Node.js cannot run on this system.' }
        try { Move-Item -Force -LiteralPath $stagedNode -Destination $node }
        catch { if (!(Test-Node $node)) { throw } }
    } finally {
        Remove-Item -Recurse -Force -LiteralPath $temp.FullName
    }
}

& $node $cli @args
exit $LASTEXITCODE
