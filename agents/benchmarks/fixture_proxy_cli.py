"""Executable-only Fly proxy double for extracted controller tests."""

from pathlib import Path
import shlex
import shutil


def install_proxy_cli(directory: Path, arguments: list[str], hold_seconds: int) -> Path:
    """Keep exec/PID lifetime real, while refusing every unlisted native command."""
    if len(arguments) != 8 or arguments[0] != "proxy" or type(hold_seconds) is not int or hold_seconds < 1:
        raise ValueError("expected one exact proxy command and positive lifetime")
    bash = shutil.which("bash")
    if not bash:
        raise RuntimeError("bash is required for the controller fixture")
    directory = directory.resolve()
    binary_dir = directory / "proxy-bin"
    binary_dir.mkdir()
    expected = " ".join(shlex.quote(value) for value in arguments)
    script = f"""#!{bash}
set -eu
expected=({expected})
[ "$#" = "${{#expected[@]}}" ] || exit 97
invocation="$*"
for value in "${{expected[@]}}"; do
    [ "$1" = "$value" ] || exit 97
    shift
done
printf '%s\\n' "$invocation" >> {shlex.quote(str(directory / 'proxy.commands'))}
printf '%s\\n' "$BASHPID" > {shlex.quote(str(directory / 'proxy.pid'))}
printf '%s\\n' "$BASHPID" >> {shlex.quote(str(directory / 'proxy.pids'))}
exec sleep {hold_seconds}
"""
    binary = binary_dir / "flyctl"
    binary.write_text(script)
    binary.chmod(0o755)
    return binary_dir
