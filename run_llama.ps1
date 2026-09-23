# Serve the downloaded Gemma 4 12B IT Q6_K GGUF. No automatic model download.
param(
    [string]$ModelPath = (Join-Path $PSScriptRoot 'models/llm/gemma-4-12b-it-Q6_K.gguf'),
    [string]$LlamaServer = 'llama-server.exe',
    [string]$ListenAddress = '127.0.0.1',
    [ValidateRange(1, 65535)]
    [int]$Port = 8080,
    [ValidateRange(0, 999)]
    [int]$GpuLayers = 0
)

if (-not (Test-Path -LiteralPath $ModelPath -PathType Leaf)) {
    throw "Q6_K model not found: $ModelPath. Copy gemma-4-12b-it-Q6_K.gguf there or pass -ModelPath."
}
$resolvedModel = (Get-Item -LiteralPath $ModelPath -ErrorAction Stop).FullName
if ((Get-Item -LiteralPath $resolvedModel).Length -eq 0) {
    throw "Model file is empty: $resolvedModel"
}
if ([IO.Path]::GetFileName($resolvedModel) -ne 'gemma-4-12b-it-Q6_K.gguf') {
    throw 'Select the downloaded gemma-4-12b-it-Q6_K.gguf file for this launcher.'
}
$serverCommand = Get-Command $LlamaServer -CommandType Application -ErrorAction Stop
$serverArgs = @(
    '-m', $resolvedModel,
    '--alias', 'gemma-4-12b-it-Q6_K',
    '--host', $ListenAddress, '--port', $Port,
    '--jinja', '-c', '8192', '-np', '1', '-ngl', $GpuLayers
)
# Native llama.cpp logs use stderr; preserve the native exit code.
$ErrorActionPreference = 'Continue'
& $serverCommand.Source @serverArgs
exit $LASTEXITCODE
