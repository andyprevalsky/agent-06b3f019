"""Test-only Linux x86_64 scheduler; no fabricated read result or data.
Attach only through TRACEME in a freshly created fixture root. Never attach an
existing process. Deschedule after the kernel returned the expected newline,
so read's unchanged .1-second deadline expires before userspace observes it.
"""
import ctypes
import os
import platform
import signal
import subprocess
import time

SUPPORTED = platform.system() == 'Linux' and platform.machine() == 'x86_64'
libc = ctypes.CDLL(None, use_errno=True)
if SUPPORTED:
    libc.ptrace.restype = ctypes.c_long

class Registers(ctypes.Structure):
    _fields_ = [(name, ctypes.c_ulonglong) for name in
                'r15 r14 r13 r12 rbp rbx r11 r10 r9 r8 rax rcx rdx rsi rdi orig_rax rip cs eflags rsp ss fs_base gs_base ds es fs gs'.split()]

def ptrace(request, pid, address=0, data=0):
    ctypes.set_errno(0)
    value = libc.ptrace(request, pid, ctypes.c_void_p(address), ctypes.c_void_p(data))
    if value == -1 and ctypes.get_errno():
        raise OSError(ctypes.get_errno(), os.strerror(ctypes.get_errno()))
    return value

class CompletionReadSchedule:
    def __init__(self, expected_frame=b'0\n', hold_seconds=.15):
        assert SUPPORTED, 'native syscall schedule requires Linux x86_64'
        self.expected_frame = expected_frame
        self.hold_seconds = hold_seconds
        self.triggered = False
        self.reads = []

    @staticmethod
    def trace_me():
        ptrace(0, 0)

    def launch(self, *args, **kwargs):
        # A ptrace stop is not termination. Ordinary Popen.poll() caches stops
        # as negative return codes, so protect the child before returning it to
        # any fallible metadata writer or the existing fixture tree cleanup.
        process = subprocess.Popen(*args, preexec_fn=self.trace_me, **kwargs)
        try:
            process.poll = lambda: process.returncode
            process._internal_poll = lambda *args, **kwargs: process.returncode
            process.wait = lambda timeout=None: self.reap_terminal(process, timeout)
        except BaseException as error:
            try:
                try:
                    os.kill(process.pid, signal.SIGKILL)
                except ProcessLookupError:
                    pass
                self.reap_terminal(process, 2)
            except BaseException as cleanup_error:
                error.add_note(f"Traced launch cleanup failed: {cleanup_error!r}")
                raise error from cleanup_error
            raise
        return process

    def reap_terminal(self, process, timeout):
        if process.returncode is not None:
            return process.returncode
        deadline = time.monotonic() + (60 if timeout is None else timeout)
        while True:
            waited, status = os.waitpid(process.pid, os.WNOHANG)
            if waited:
                if os.WIFEXITED(status) or os.WIFSIGNALED(status):
                    process.returncode = os.waitstatus_to_exitcode(status)
                    return process.returncode
                if os.WIFSTOPPED(status):
                    # This path is the existing fixture's error teardown; it
                    # has already decided to stop this exact-owned root.
                    try:
                        ptrace(7, process.pid, 0, signal.SIGKILL)
                    except ProcessLookupError:
                        # Concurrent SIGKILL can win; require its terminal wait.
                        pass
            if time.monotonic() >= deadline:
                raise subprocess.TimeoutExpired(process.args, timeout)
            time.sleep(.0002)

    def wait(self, process, timeout):
        deadline = time.monotonic() + timeout
        entering = True
        next_signal = 0
        per_fd = {}
        def observe():
            while True:
                waited, status = os.waitpid(process.pid, os.WNOHANG)
                if waited:
                    return status
                if time.monotonic() >= deadline:
                    raise subprocess.TimeoutExpired(process.args, timeout)
                time.sleep(.0002)
        status = observe()
        if os.WIFEXITED(status) or os.WIFSIGNALED(status):
            process.returncode = os.waitstatus_to_exitcode(status)
            return process.returncode
        assert os.WIFSTOPPED(status), f'no native exec stop: {status}'
        ptrace(0x4200, process.pid, 0, 1) # TRACESYSGOOD, no fork tracing
        while True:
            ptrace(24, process.pid, 0, next_signal)
            next_signal = 0
            status = observe()
            if os.WIFEXITED(status) or os.WIFSIGNALED(status):
                process.returncode = os.waitstatus_to_exitcode(status)
                return process.returncode
            stop_signal = os.WSTOPSIG(status)
            if stop_signal == (signal.SIGTRAP | 0x80):
                registers = Registers()
                ptrace(12, process.pid, 0, ctypes.addressof(registers))
                if not entering and registers.orig_rax == 0 and registers.rdx == 1:
                    result = ctypes.c_longlong(registers.rax).value
                    byte = ptrace(2, process.pid, registers.rsi) & 255 if result == 1 else None
                    try:
                        descriptor = os.readlink(f'/proc/{process.pid}/fd/{registers.rdi}')
                    except OSError:
                        descriptor = ''
                    if descriptor.startswith('pipe:'):
                        self.reads.append({'fd': registers.rdi, 'descriptor': descriptor,
                                           'return': result, 'byte': byte})
                        if byte is not None:
                            previous = per_fd.get(registers.rdi, b'')
                            current = (previous + bytes([byte]))[-len(self.expected_frame):]
                            per_fd[registers.rdi] = current
                            if not self.triggered and current == self.expected_frame:
                                self.triggered = True
                                time.sleep(self.hold_seconds)
                entering = not entering
            elif stop_signal != signal.SIGTRAP:
                next_signal = stop_signal
