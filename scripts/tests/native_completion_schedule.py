"""Test-only Linux x86_64 scheduler; no fabricated read result or data.
Attach only through TRACEME in a freshly created fixture root. Never attach an
existing process. Deschedule after the kernel returned the expected newline,
so read's unchanged .1-second deadline expires before userspace observes it.
"""
import ctypes
import os
from pathlib import Path
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

    def wait(self, process, timeout):
        deadline = time.monotonic() + timeout
        entering = True
        next_signal = 0
        stopped = False
        per_fd = {}
        def observe():
            while True:
                waited, status = os.waitpid(process.pid, os.WNOHANG)
                if waited:
                    return status
                if time.monotonic() >= deadline:
                    raise subprocess.TimeoutExpired(process.args, timeout)
                time.sleep(.0002)
        try:
            status = observe()
            assert os.WIFSTOPPED(status), f'no native exec stop: {status}'
            stopped = True
            ptrace(0x4200, process.pid, 0, 1) # TRACESYSGOOD, no fork tracing
            while True:
                ptrace(24, process.pid, 0, next_signal)
                stopped = False
                next_signal = 0
                status = observe()
                if os.WIFEXITED(status) or os.WIFSIGNALED(status):
                    process.returncode = os.waitstatus_to_exitcode(status)
                    return process.returncode
                stopped = True
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
        finally:
            if process.returncode is None:
                # Give the existing fixture's ownership-aware error cleanup a
                # running root. Never leave it frozen under the tracer.
                if not stopped:
                    os.kill(process.pid, signal.SIGSTOP)
                    detach_deadline = time.monotonic() + 1
                    while time.monotonic() < detach_deadline:
                        waited, status = os.waitpid(process.pid, os.WNOHANG)
                        if waited:
                            stopped = os.WIFSTOPPED(status)
                            if not stopped:
                                process.returncode = os.waitstatus_to_exitcode(status)
                            break
                        time.sleep(.001)
                if stopped:
                    ptrace(17, process.pid, 0, signal.SIGCONT)
