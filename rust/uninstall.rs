#![cfg_attr(windows, windows_subsystem = "windows")]

#[cfg(windows)]
fn main() -> std::process::ExitCode {
    use std::{env, io, process::Command};
    use windows_sys::Win32::UI::WindowsAndMessaging::{MB_ICONERROR, MB_OK, MessageBoxW};

    let spawn = || -> io::Result<()> {
        let executable = env::current_exe()?;
        let root = executable.parent().ok_or(io::ErrorKind::NotFound)?;
        let uninstaller = root.join("runtime").join("uninstall");
        Command::new(uninstaller.join("unins000.exe"))
            .args(env::args_os().skip(1))
            .current_dir(uninstaller)
            .spawn()?;
        Ok(())
    };

    if spawn().is_ok() {
        return std::process::ExitCode::SUCCESS;
    }

    let message: Vec<_> = "无法启动卸载程序。请检查安装文件。\0"
        .encode_utf16()
        .collect();
    let title: Vec<_> = "LDFCL\0".encode_utf16().collect();
    // Both strings are NUL-terminated and live through the call.
    unsafe {
        MessageBoxW(
            std::ptr::null_mut(),
            message.as_ptr(),
            title.as_ptr(),
            MB_OK | MB_ICONERROR,
        );
    }
    std::process::ExitCode::FAILURE
}

#[cfg(not(windows))]
fn main() -> std::process::ExitCode {
    eprintln!("This entry point is used by the Windows installer.");
    std::process::ExitCode::FAILURE
}
