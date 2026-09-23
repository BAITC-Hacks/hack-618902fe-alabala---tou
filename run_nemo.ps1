# Process recordings with CUDA in WSL2, inside a network namespace with no network.
# Run setup_nemo_wsl.sh once before using this launcher. Arguments go to test.py.
# Native progress/warnings use stderr; they must not terminate a redirected run.
$ErrorActionPreference = 'Continue'
& wsl.exe -d Ubuntu-24.04 -u root --cd $PSScriptRoot --exec `
    unshare --net /opt/qorit-nemo/bin/python test.py --diarize @args
exit $LASTEXITCODE
