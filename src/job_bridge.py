"""Windows process owner. The non-inheritable job handle lives only in this bridge."""
import _winapi
import ctypes
from ctypes import wintypes as w
import json
import os
import shutil
import subprocess
import sys


class BasicLimits(ctypes.Structure):
    _fields_ = [("PerProcessUserTimeLimit", ctypes.c_int64),
                ("PerJobUserTimeLimit", ctypes.c_int64), ("LimitFlags", w.DWORD),
                ("MinimumWorkingSetSize", ctypes.c_size_t), ("MaximumWorkingSetSize", ctypes.c_size_t),
                ("ActiveProcessLimit", w.DWORD), ("Affinity", ctypes.c_size_t),
                ("PriorityClass", w.DWORD), ("SchedulingClass", w.DWORD)]


class ExtendedLimits(ctypes.Structure):
    _fields_ = [("BasicLimitInformation", BasicLimits), ("IoInfo", ctypes.c_uint64 * 6),
                ("ProcessMemoryLimit", ctypes.c_size_t), ("JobMemoryLimit", ctypes.c_size_t),
                ("PeakProcessMemoryUsed", ctypes.c_size_t), ("PeakJobMemoryUsed", ctypes.c_size_t)]


def api(name, result, *args):
    fn = getattr(kernel, name)
    fn.restype = result
    fn.argtypes = args
    return fn


kernel = ctypes.WinDLL("kernel32", use_last_error=True)
create_job = api("CreateJobObjectW", w.HANDLE, w.LPVOID, w.LPCWSTR)
set_job_info = api("SetInformationJobObject", w.BOOL, w.HANDLE, ctypes.c_int, w.LPVOID, w.DWORD)
assign_job = api("AssignProcessToJobObject", w.BOOL, w.HANDLE, w.HANDLE)
current_process = api("GetCurrentProcess", w.HANDLE)


def checked(value):
    if not value:
        raise ctypes.WinError(ctypes.get_last_error())
    return value


def emit(kind, **fields):
    os.write(3, (json.dumps({"kind": kind, **fields}) + "\n").encode("ascii"))


def main():
    try:
        if sys.version_info < (3, 12):
            raise ValueError("Python 3.12 or newer is required")
        owner = _winapi.OpenProcess(0x00100000, False, int(sys.argv[1]))  # SYNCHRONIZE
        job = checked(create_job(None, None))
        limits = ExtendedLimits()
        limits.BasicLimitInformation.LimitFlags = 0x2000  # JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
        checked(set_job_info(job, 9, ctypes.byref(limits), ctypes.sizeof(limits)))
        # Assign ourselves *before* launching. Children enter the job at creation; no race
        # between spawn and assignment, and no breakaway flags are allowed by this job.
        checked(assign_job(job, current_process()))
        executable = shutil.which(sys.argv[2], path=os.environ.get("PATH", ""))
        if not executable or not executable.lower().endswith(".exe"):
            raise ValueError("Expected an executable .exe (batch files and shell shims are not supported)")
        child = subprocess.Popen([executable, *sys.argv[3:]], executable=executable, close_fds=True,
                                 stdin=sys.stdin, stdout=sys.stdout, stderr=sys.stderr,
                                 creationflags=subprocess.CREATE_NO_WINDOW)
    except (OSError, ValueError) as error:
        emit("launch", message=str(error)[:600])
        return
    emit("ready")
    # Keep the only job handle open until the command or Worq exits. The OS closes it even
    # if this bridge is force-terminated. Never explicitly close it before sending status.
    if _winapi.WaitForMultipleObjects([owner, child._handle], False, _winapi.INFINITE) == _winapi.WAIT_OBJECT_0 + 1:
        emit("exit", code=child.wait())


if __name__ == "__main__":
    main()
    os._exit(0)
