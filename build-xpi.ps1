# SPDX-License-Identifier: MPL-2.0
$ErrorActionPreference = 'Stop'
$projectRoot = $PSScriptRoot
Push-Location -LiteralPath $projectRoot
try {
    & node scripts/check-release.js
    if ($LASTEXITCODE -ne 0) { throw 'Release checks failed.' }
    & node --test background.test.js
    if ($LASTEXITCODE -ne 0) { throw 'Regression tests failed.' }

    $manifest = Get-Content -Raw -LiteralPath 'manifest.json' | ConvertFrom-Json
    $runtimeFiles = @(Get-Content -Raw -LiteralPath 'release-files.json' | ConvertFrom-Json)
    $sourceFiles = @($runtimeFiles) + @(
        '.gitattributes', '.gitignore', 'CHANGELOG.md', 'README.md', 'background.test.js',
        'build-xpi.ps1', 'package.json', 'release-files.json', 'scripts/check-release.js',
        'docs/PRIVACY.en.md', 'docs/PRIVACY.ja.md', 'docs/ATN-LISTING.en.md',
        'docs/ATN-LISTING.ja.md', 'docs/REVIEWER-NOTES.md', 'docs/RELEASE-CHECKLIST.md'
    )
    $distDirectory = Join-Path $projectRoot 'dist'
    New-Item -ItemType Directory -Path $distDirectory -Force | Out-Null
    Add-Type -AssemblyName System.IO.Compression
    Add-Type -AssemblyName System.IO.Compression.FileSystem

    function Write-ReleaseArchive([string]$archivePath, [string[]]$files) {
        $temporaryPath = Join-Path $distDirectory ('.' + [guid]::NewGuid().ToString('N') + '.zip')
        $stream = [System.IO.File]::Open($temporaryPath, [System.IO.FileMode]::CreateNew)
        $archive = [System.IO.Compression.ZipArchive]::new($stream, [System.IO.Compression.ZipArchiveMode]::Create)
        try {
            foreach ($file in ($files | Sort-Object -Unique)) {
                $sourcePath = [System.IO.Path]::GetFullPath((Join-Path $projectRoot $file))
                if (-not $sourcePath.StartsWith($projectRoot + [System.IO.Path]::DirectorySeparatorChar, [System.StringComparison]::OrdinalIgnoreCase)) { throw 'Release file outside project.' }
                $entry = $archive.CreateEntry($file.Replace('\', '/'), [System.IO.Compression.CompressionLevel]::Optimal)
                $entry.LastWriteTime = [System.DateTimeOffset]::new(2000, 1, 1, 0, 0, 0, [System.TimeSpan]::Zero)
                $entryStream = $entry.Open()
                try {
                    $bytes = [System.IO.File]::ReadAllBytes($sourcePath)
                    $entryStream.Write($bytes, 0, $bytes.Length)
                } finally { $entryStream.Dispose() }
            }
        } finally { $archive.Dispose(); $stream.Dispose() }
        Move-Item -LiteralPath $temporaryPath -Destination $archivePath -Force
    }

    $baseName = 'thunderbird-mailstate-sync-' + $manifest.version
    $xpiPath = Join-Path $distDirectory ($baseName + '.xpi')
    $sourcePath = Join-Path $distDirectory ($baseName + '-source.zip')
    Write-ReleaseArchive $xpiPath $runtimeFiles
    Write-ReleaseArchive $sourcePath $sourceFiles

    $archive = [System.IO.Compression.ZipFile]::OpenRead($xpiPath)
    try {
        if ($archive.Entries.Count -ne $runtimeFiles.Count) { throw 'Unexpected XPI entries.' }
        foreach ($file in $runtimeFiles) {
            $entry = $archive.GetEntry($file)
            if ($null -eq $entry) { throw ('Missing packaged file: ' + $file) }
            $entryStream = $entry.Open()
            $sha = [System.Security.Cryptography.SHA256]::Create()
            try { $entryHash = [System.BitConverter]::ToString($sha.ComputeHash($entryStream)).Replace('-', '') }
            finally { $sha.Dispose(); $entryStream.Dispose() }
            if ($entryHash -ne (Get-FileHash -LiteralPath (Join-Path $projectRoot $file) -Algorithm SHA256).Hash) { throw ('Packaged file differs: ' + $file) }
        }
    } finally { $archive.Dispose() }

    $hashLines = @($xpiPath, $sourcePath) | ForEach-Object {
        (Get-FileHash -LiteralPath $_ -Algorithm SHA256).Hash.ToLowerInvariant() + '  ' + [System.IO.Path]::GetFileName($_)
    }
    [System.IO.File]::WriteAllLines((Join-Path $distDirectory ($baseName + '-SHA256SUMS.txt')), $hashLines, [System.Text.UTF8Encoding]::new($false))
    Write-Output $xpiPath
    Write-Output $sourcePath
} finally { Pop-Location }
