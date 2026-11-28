use std::collections::HashSet;
use std::env;
use std::ffi::OsStr;
use std::fs::{self, File, Metadata};
use std::io::Read;
use std::path::{Path, PathBuf};

#[derive(Clone, Debug)]
pub struct JavaRuntime {
    pub executable: PathBuf,
    pub major: u32,
    pub compatible: bool,
}

#[derive(Clone, Copy, Default, PartialEq, Eq)]
enum Architecture {
    #[default]
    Unknown,
    X86,
    X64,
    Arm,
    Arm64,
}

fn architecture(value: &str) -> Architecture {
    match value {
        "amd64" | "x86_64" | "x64" => Architecture::X64,
        "aarch64" | "arm64" => Architecture::Arm64,
        "x86" | "i386" | "i486" | "i586" | "i686" => Architecture::X86,
        "arm" | "armv7l" => Architecture::Arm,
        _ => Architecture::Unknown,
    }
}

fn parse_major(version: &str) -> Option<u32> {
    let version = version.strip_prefix("1.").unwrap_or(version);
    let suffix = version.find(|character: char| !character.is_ascii_digit());
    let digits = suffix.unwrap_or(version.len());
    if let Some(index) = suffix {
        if !matches!(version.as_bytes()[index], b'.' | b'_' | b'+' | b'-') {
            return None;
        }
    }
    version[..digits]
        .parse::<u32>()
        .ok()
        .filter(|major| (1..=999).contains(major))
}

#[derive(Default)]
struct Release {
    major: Option<u32>,
    architecture: Architecture,
}

fn read_release(home: &Path) -> Release {
    const LIMIT: u64 = 1024 * 1024;
    let path = home.join("release");
    if !fs::metadata(&path).is_ok_and(|metadata| metadata.is_file() && metadata.len() <= LIMIT) {
        return Release::default();
    }
    let Ok(file) = File::open(path) else {
        return Release::default();
    };
    let mut bytes = Vec::new();
    if file.take(LIMIT + 1).read_to_end(&mut bytes).is_err() || bytes.len() as u64 > LIMIT {
        return Release::default();
    }
    let mut release = Release::default();
    for line in String::from_utf8_lossy(&bytes).lines() {
        let Some((key, value)) = line.split_once('=') else {
            continue;
        };
        let value = value
            .strip_prefix('"')
            .and_then(|value| value.strip_suffix('"'))
            .unwrap_or(value);
        match key {
            "JAVA_VERSION" => release.major = parse_major(value),
            "OS_ARCH" => release.architecture = architecture(value),
            _ => {}
        }
    }
    release
}

fn java_filename(path: &Path) -> bool {
    path.file_name().is_some_and(|name| {
        platform::JAVA_FILENAMES
            .iter()
            .any(|candidate| platform::same_name(name, candidate))
    })
}

pub fn identify_java_runtime(executable: &Path) -> Option<JavaRuntime> {
    if !java_filename(executable) {
        return None;
    }
    let executable = platform::canonicalize(executable).ok()?;
    if !platform::executable_file(&executable, &fs::metadata(&executable).ok()?) {
        return None;
    }
    let home = executable.parent()?.parent()?;
    let mut release = read_release(home);
    if release.major.is_none()
        && home
            .file_name()
            .is_some_and(|name| platform::same_name(name, "jre"))
    {
        if let Some(parent) = home.parent() {
            release = read_release(parent);
        }
    }
    let major = release
        .major
        .or_else(|| platform::legacy_java_major(&executable))?;
    let runtime = if release.architecture == Architecture::Unknown {
        platform::executable_architecture(&executable).unwrap_or_default()
    } else {
        release.architecture
    };
    let host = architecture(env::consts::ARCH);
    Some(JavaRuntime {
        executable,
        major,
        compatible: runtime == Architecture::Unknown
            || host == Architecture::Unknown
            || host == runtime,
    })
}

pub fn java_for_major(runtimes: &[JavaRuntime], major: u32) -> Option<&Path> {
    runtimes
        .iter()
        .find(|runtime| runtime.compatible && runtime.major == major)
        .map(|runtime| runtime.executable.as_path())
}

fn nonempty_environment_path(name: &str) -> Option<PathBuf> {
    env::var_os(name)
        .filter(|value| !value.is_empty())
        .map(PathBuf::from)
}

fn environment_candidates() -> impl Iterator<Item = PathBuf> {
    let mut bins = Vec::new();
    if let Some(home) = nonempty_environment_path("JAVA_HOME") {
        bins.push(home.join("bin"));
    }
    if let Some(path) = env::var_os("PATH") {
        bins.extend(env::split_paths(&path).filter(|path| !path.as_os_str().is_empty()));
    }
    bins.into_iter().flat_map(|bin| {
        platform::JAVA_FILENAMES
            .iter()
            .map(move |filename| bin.join(filename))
    })
}

pub fn default_java() -> Option<PathBuf> {
    environment_candidates().find_map(|path| {
        let path = std::path::absolute(path).ok()?;
        platform::executable_file(&path, &fs::metadata(&path).ok()?).then_some(path)
    })
}

struct Scanner<C, F> {
    cancelled: C,
    found: F,
    local: platform::LocalPaths,
    reported: HashSet<PathBuf>,
    scanned: HashSet<PathBuf>,
}

impl<C: Fn() -> bool, F: FnMut(JavaRuntime)> Scanner<C, F> {
    fn inspect(&mut self, path: &Path) {
        if (self.cancelled)() || !self.local.allows(path) {
            return;
        }
        let Some(runtime) = identify_java_runtime(path) else {
            return;
        };
        if !(self.cancelled)()
            && self.local.allows(&runtime.executable)
            && self.reported.insert(
                runtime
                    .executable
                    .parent()
                    .unwrap_or(&runtime.executable)
                    .to_owned(),
            )
        {
            (self.found)(runtime);
        }
    }

    fn scan(&mut self, path: &Path) {
        if (self.cancelled)() || !self.local.allows(path) {
            return;
        }
        let Ok(root) = platform::canonicalize(path) else {
            return;
        };
        if !self.local.allows(&root) || self.scanned.contains(&root) {
            return;
        }
        if !root.is_dir() {
            self.inspect(path);
            return;
        }

        let mut pending = vec![root.clone()];
        while let Some(directory) = pending.pop() {
            if (self.cancelled)() {
                return;
            }
            if self.scanned.contains(&directory) || self.local.excludes_directory(&directory) {
                continue;
            }
            let Ok(entries) = fs::read_dir(directory) else {
                continue;
            };
            for entry in entries {
                if (self.cancelled)() {
                    return;
                }
                let Ok(entry) = entry else {
                    continue;
                };
                let Ok(kind) = entry.file_type() else {
                    continue;
                };
                if kind.is_dir() && platform::ordinary_directory(&entry) {
                    pending.push(entry.path());
                } else if kind.is_file() {
                    let path = entry.path();
                    if java_filename(&path) {
                        self.inspect(&path);
                    }
                }
            }
        }
        self.scanned.insert(root);
    }
}

pub fn discover_java_runtimes(
    preferred: &[PathBuf],
    cancelled: impl Fn() -> bool,
    found: impl FnMut(JavaRuntime),
) {
    if cancelled() {
        return;
    }
    let mut scanner = Scanner {
        cancelled,
        found,
        local: platform::LocalPaths::new(),
        reported: HashSet::new(),
        scanned: HashSet::new(),
    };
    for path in preferred {
        scanner.scan(path);
    }
    for path in environment_candidates() {
        scanner.inspect(&path);
    }
    if (scanner.cancelled)() {
        return;
    }
    if let Some(home) = nonempty_environment_path(platform::HOME_ENV) {
        scanner.scan(&home.join(".jdks"));
        scanner.scan(&home.join(".gradle/jdks"));
    }
    for root in platform::known_roots() {
        scanner.scan(&root);
    }
    for root in platform::local_roots(&scanner.cancelled) {
        scanner.scan(&root);
    }
}

#[cfg(unix)]
mod platform {
    use super::*;
    use std::ffi::{CString, OsString};
    use std::os::unix::ffi::{OsStrExt, OsStringExt};

    pub(super) const JAVA_FILENAMES: &[&str] = &["java"];
    pub(super) const HOME_ENV: &str = "HOME";

    pub(super) fn same_name(name: &OsStr, expected: &str) -> bool {
        name == expected
    }

    pub(super) use fs::canonicalize;

    pub(super) fn executable_file(path: &Path, metadata: &Metadata) -> bool {
        metadata.is_file()
            && CString::new(path.as_os_str().as_bytes())
                .is_ok_and(|path| unsafe { libc::access(path.as_ptr(), libc::X_OK) == 0 })
    }

    pub(super) fn ordinary_directory(_: &fs::DirEntry) -> bool {
        true
    }

    pub(super) fn legacy_java_major(_: &Path) -> Option<u32> {
        None
    }

    pub(super) fn executable_architecture(path: &Path) -> Option<Architecture> {
        let mut header = [0; 20];
        File::open(path).ok()?.read_exact(&mut header).ok()?;
        if &header[..4] != b"\x7fELF" {
            return None;
        }
        let machine = [header[18], header[19]];
        match match header[5] {
            1 => u16::from_le_bytes(machine),
            2 => u16::from_be_bytes(machine),
            _ => return None,
        } {
            3 => Some(Architecture::X86),
            62 => Some(Architecture::X64),
            40 => Some(Architecture::Arm),
            183 => Some(Architecture::Arm64),
            _ => None,
        }
    }

    #[cfg(target_os = "linux")]
    fn unescape_mount_path(path: &[u8]) -> PathBuf {
        let mut decoded = Vec::with_capacity(path.len());
        let mut path = path;
        while let Some((&first, remaining)) = path.split_first() {
            if first == b'\\'
                && remaining.len() >= 3
                && remaining[..3].iter().all(|c| (b'0'..=b'7').contains(c))
            {
                let number = u16::from(remaining[0] - b'0') * 64
                    + u16::from(remaining[1] - b'0') * 8
                    + u16::from(remaining[2] - b'0');
                if let Ok(number) = u8::try_from(number) {
                    decoded.push(number);
                    path = &remaining[3..];
                    continue;
                }
            }
            decoded.push(first);
            path = remaining;
        }
        OsString::from_vec(decoded).into()
    }

    #[cfg(target_os = "linux")]
    fn additional_exclusions(excluded: &mut HashSet<PathBuf>) {
        let Ok(mounts) = fs::read("/proc/self/mountinfo") else {
            return;
        };
        for line in mounts.split(|byte| *byte == b'\n') {
            let mut parts = line.split(|byte| *byte == b' ');
            let Some(path) = parts.nth(4) else {
                continue;
            };
            let Some(kind) = parts.skip_while(|field| *field != b"-").nth(1) else {
                continue;
            };
            if matches!(
                kind,
                b"afs"
                    | b"autofs"
                    | b"ceph"
                    | b"cifs"
                    | b"davfs"
                    | b"debugfs"
                    | b"glusterfs"
                    | b"lustre"
                    | b"nfs"
                    | b"nfs4"
                    | b"rpc_pipefs"
                    | b"smb3"
                    | b"smbfs"
                    | b"sshfs"
                    | b"tracefs"
                    | b"9p"
            ) || kind.starts_with(b"fuse.")
            {
                excluded.insert(unescape_mount_path(path));
            }
        }
    }

    #[cfg(target_os = "macos")]
    fn additional_exclusions(excluded: &mut HashSet<PathBuf>) {
        use std::ffi::CStr;
        use std::mem::{MaybeUninit, size_of};
        use std::ptr;

        // A caller-owned snapshot avoids getmntinfo's shared, mutable buffer.
        let count = unsafe { libc::getfsstat(ptr::null_mut(), 0, libc::MNT_NOWAIT) };
        if count <= 0 {
            return;
        }
        let mut mounts = vec![MaybeUninit::<libc::statfs>::uninit(); count as usize + 16];
        let Some(bytes) = mounts
            .len()
            .checked_mul(size_of::<libc::statfs>())
            .and_then(|n| libc::c_int::try_from(n).ok())
        else {
            return;
        };
        let count = unsafe { libc::getfsstat(mounts.as_mut_ptr().cast(), bytes, libc::MNT_NOWAIT) };
        for mount in mounts.iter().take(count.max(0) as usize) {
            // getfsstat writes and terminates the name fields for each returned entry.
            let mount = unsafe { mount.assume_init_ref() };
            let kind = unsafe { CStr::from_ptr(mount.f_fstypename.as_ptr()) };
            if mount.f_flags & libc::MNT_LOCAL as u32 == 0 || kind.to_bytes() == b"autofs" {
                let name = unsafe { CStr::from_ptr(mount.f_mntonname.as_ptr()) };
                excluded.insert(OsString::from_vec(name.to_bytes().to_vec()).into());
            }
        }
    }

    #[cfg(not(any(target_os = "linux", target_os = "macos")))]
    fn additional_exclusions(_: &mut HashSet<PathBuf>) {}

    pub(super) struct LocalPaths {
        excluded: HashSet<PathBuf>,
    }

    impl LocalPaths {
        pub(super) fn new() -> Self {
            let mut excluded = ["/dev", "/proc", "/sys"]
                .map(PathBuf::from)
                .into_iter()
                .collect();
            additional_exclusions(&mut excluded);
            Self { excluded }
        }

        pub(super) fn allows(&self, path: &Path) -> bool {
            !path.as_os_str().is_empty()
                && std::path::absolute(path).is_ok_and(|path| {
                    !path
                        .ancestors()
                        .any(|directory| self.excluded.contains(directory))
                })
        }

        pub(super) fn excludes_directory(&self, path: &Path) -> bool {
            self.excluded.contains(path)
        }
    }

    pub(super) fn known_roots() -> Vec<PathBuf> {
        let mut roots =
            Vec::from(["/usr/lib/jvm", "/usr/java", "/usr/local/lib/jvm"].map(PathBuf::from));
        if let Some(home) = nonempty_environment_path(HOME_ENV) {
            roots.extend([
                home.join(".sdkman/candidates/java"),
                home.join(".asdf/installs/java"),
            ]);
            if cfg!(target_os = "macos") {
                roots.push(home.join("Library/Java/JavaVirtualMachines"));
            }
        }
        if cfg!(target_os = "macos") {
            roots.push(PathBuf::from("/Library/Java/JavaVirtualMachines"));
        }
        roots
    }

    pub(super) fn local_roots(cancelled: impl Fn() -> bool) -> Vec<PathBuf> {
        if cancelled() {
            Vec::new()
        } else {
            vec![PathBuf::from("/")]
        }
    }
}

#[cfg(windows)]
mod platform {
    use super::*;
    use std::ffi::OsString;
    use std::fs::OpenOptions;
    use std::io::{self, Seek, SeekFrom};
    use std::os::windows::ffi::{OsStrExt, OsStringExt};
    use std::os::windows::fs::{MetadataExt, OpenOptionsExt};
    use std::os::windows::io::AsRawHandle;
    use std::path::{Component, Prefix};
    use std::ptr;
    use windows_sys::Win32::Foundation::{HANDLE, INVALID_HANDLE_VALUE, MAX_PATH};
    use windows_sys::Win32::Storage::FileSystem::{
        FILE_ATTRIBUTE_REPARSE_POINT, FILE_FLAG_BACKUP_SEMANTICS, FindFirstVolumeW,
        FindNextVolumeW, FindVolumeClose, GetDriveTypeW, GetFileVersionInfoSizeW,
        GetFileVersionInfoW, GetFinalPathNameByHandleW, GetLogicalDrives,
        GetVolumePathNamesForVolumeNameW, VOLUME_NAME_GUID, VOLUME_NAME_NT, VS_FIXEDFILEINFO,
        VerQueryValueW,
    };
    use windows_sys::Win32::System::WindowsProgramming::{
        DRIVE_FIXED, DRIVE_RAMDISK, DRIVE_REMOVABLE,
    };

    pub(super) const JAVA_FILENAMES: &[&str] = &["javaw.exe", "java.exe"];
    pub(super) const HOME_ENV: &str = "USERPROFILE";

    pub(super) fn same_name(name: &OsStr, expected: &str) -> bool {
        name.eq_ignore_ascii_case(OsStr::new(expected))
    }

    fn nul_terminated(path: &OsStr) -> Option<Vec<u16>> {
        let mut units: Vec<_> = path.encode_wide().collect();
        if units.contains(&0) {
            return None;
        }
        units.push(0);
        Some(units)
    }

    fn final_path(file: &File, flag: u32) -> io::Result<OsString> {
        let mut buffer = vec![0u16; MAX_PATH as usize];
        loop {
            // The handle remains open and the buffer is writable for its full length.
            let count = unsafe {
                GetFinalPathNameByHandleW(
                    file.as_raw_handle(),
                    buffer.as_mut_ptr(),
                    buffer.len() as u32,
                    flag,
                )
            } as usize;
            if count == 0 {
                return Err(io::Error::last_os_error());
            }
            if count < buffer.len() {
                return Ok(OsString::from_wide(&buffer[..count]));
            }
            buffer.resize(count + 1, 0);
        }
    }

    pub(super) fn canonicalize(path: &Path) -> io::Result<PathBuf> {
        fs::canonicalize(path).or_else(|error| {
            if error.kind() == io::ErrorKind::NotFound {
                return Err(error);
            }
            // Rust's standard DOS name lookup may fail for a local, letterless volume.
            let file = OpenOptions::new()
                .access_mode(0)
                .custom_flags(FILE_FLAG_BACKUP_SEMANTICS)
                .open(path)?;
            if let Ok(volume) = final_path(&file, VOLUME_NAME_GUID) {
                return Ok(volume.into());
            }
            let mut path = OsString::from(r"\\?\GLOBALROOT");
            path.push(final_path(&file, VOLUME_NAME_NT)?);
            Ok(path.into())
        })
    }

    pub(super) fn executable_file(_: &Path, metadata: &Metadata) -> bool {
        metadata.is_file()
    }

    pub(super) fn ordinary_directory(entry: &fs::DirEntry) -> bool {
        entry
            .metadata()
            .is_ok_and(|metadata| metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT == 0)
    }

    pub(super) fn legacy_java_major(executable: &Path) -> Option<u32> {
        let bin = executable.parent()?;
        // Standalone older JREs may lack a release file. Check for their JVM library.
        if !bin.join("server/jvm.dll").is_file() && !bin.join("client/jvm.dll").is_file() {
            return None;
        }
        let name = nul_terminated(executable.as_os_str())?;
        let size = unsafe { GetFileVersionInfoSizeW(name.as_ptr(), ptr::null_mut()) };
        if size == 0 || size > 1024 * 1024 {
            return None;
        }
        let mut data = vec![0u8; size as usize];
        if unsafe { GetFileVersionInfoW(name.as_ptr(), 0, size, data.as_mut_ptr().cast()) } == 0 {
            return None;
        }
        let mut value = ptr::null_mut();
        let mut length = 0;
        let root = [u16::from(b'\\'), 0];
        if unsafe { VerQueryValueW(data.as_ptr().cast(), root.as_ptr(), &mut value, &mut length) }
            == 0
            || value.is_null()
        {
            return None;
        }
        let start = (value as usize).checked_sub(data.as_ptr() as usize)?;
        let info_size = std::mem::size_of::<VS_FIXEDFILEINFO>();
        if (length as usize) < info_size || start.checked_add(info_size)? > data.len() {
            return None;
        }
        // The complete version structure is inside the live resource buffer.
        let info = unsafe {
            data.as_ptr()
                .add(start)
                .cast::<VS_FIXEDFILEINFO>()
                .read_unaligned()
        };
        if info.dwSignature != 0xfeef04bd {
            return None;
        }
        let major = info.dwProductVersionMS >> 16;
        let major = if major == 1 {
            info.dwProductVersionMS & 0xffff
        } else {
            major
        };
        (1..=999).contains(&major).then_some(major)
    }

    pub(super) fn executable_architecture(path: &Path) -> Option<Architecture> {
        let mut stream = File::open(path).ok()?;
        let mut dos = [0; 64];
        stream.read_exact(&mut dos).ok()?;
        if &dos[..2] != b"MZ" {
            return None;
        }
        let offset = u32::from_le_bytes(dos[60..64].try_into().ok()?);
        stream.seek(SeekFrom::Start(offset.into())).ok()?;
        let mut pe = [0; 6];
        stream.read_exact(&mut pe).ok()?;
        if &pe[..4] != b"PE\0\0" {
            return None;
        }
        match u16::from_le_bytes([pe[4], pe[5]]) {
            0x014c => Some(Architecture::X86),
            0x8664 => Some(Architecture::X64),
            0x01c4 => Some(Architecture::Arm),
            0xaa64 => Some(Architecture::Arm64),
            _ => None,
        }
    }

    fn drive_root(letter: u8) -> [u16; 4] {
        [letter.into(), b':'.into(), b'\\'.into(), 0]
    }

    fn local_drive(root: &[u16]) -> bool {
        if root.last() != Some(&0) {
            return false;
        }
        // A root passed here is a NUL-terminated Win32 directory path.
        matches!(
            unsafe { GetDriveTypeW(root.as_ptr()) },
            DRIVE_FIXED | DRIVE_REMOVABLE | DRIVE_RAMDISK
        )
    }

    fn nt_hard_disk(path: &Path) -> bool {
        let mut names = path.components().filter_map(|component| match component {
            Component::Normal(name) => Some(name),
            _ => None,
        });
        names.next().is_some_and(|name| same_name(name, "Device"))
            && names.next().and_then(OsStr::to_str).is_some_and(|name| {
                name.strip_prefix("HarddiskVolume").is_some_and(|suffix| {
                    !suffix.is_empty() && suffix.bytes().all(|byte| byte.is_ascii_digit())
                })
            })
    }

    pub(super) struct LocalPaths;

    impl LocalPaths {
        pub(super) fn new() -> Self {
            Self
        }

        pub(super) fn allows(&self, path: &Path) -> bool {
            let absolute;
            let path = if path.is_absolute() {
                path
            } else {
                let Ok(resolved) = std::path::absolute(path) else {
                    return false;
                };
                absolute = resolved;
                &absolute
            };
            let Some(Component::Prefix(prefix)) = path.components().next() else {
                return false;
            };
            match prefix.kind() {
                Prefix::Disk(letter) | Prefix::VerbatimDisk(letter) => {
                    local_drive(&drive_root(letter))
                }
                Prefix::Verbatim(name) if same_name(name, "GLOBALROOT") => nt_hard_disk(path),
                Prefix::Verbatim(name) if name.as_encoded_bytes().starts_with(b"Volume{") => {
                    let mut root: Vec<_> = prefix.as_os_str().encode_wide().collect();
                    root.extend([u16::from(b'\\'), 0]);
                    local_drive(&root)
                }
                _ => false,
            }
        }

        pub(super) fn excludes_directory(&self, _: &Path) -> bool {
            false
        }
    }

    pub(super) fn known_roots() -> Vec<PathBuf> {
        ["ProgramFiles", "ProgramW6432", "ProgramFiles(x86)"]
            .into_iter()
            .filter_map(nonempty_environment_path)
            .flat_map(|files| {
                [
                    "Java",
                    "Eclipse Adoptium",
                    "Microsoft",
                    "Amazon Corretto",
                    "BellSoft",
                    "Azul Systems",
                    "AdoptOpenJDK",
                    "Minecraft Launcher",
                ]
                .into_iter()
                .map(move |vendor| files.join(vendor))
            })
            .collect()
    }

    struct VolumeSearch(HANDLE);

    impl Drop for VolumeSearch {
        fn drop(&mut self) {
            // This handle was returned by FindFirstVolumeW.
            unsafe { FindVolumeClose(self.0) };
        }
    }

    fn add_folder_mounts(volume: &[u16], roots: &mut Vec<PathBuf>) {
        let mut length = 0;
        unsafe {
            GetVolumePathNamesForVolumeNameW(volume.as_ptr(), ptr::null_mut(), 0, &mut length)
        };
        if length == 0 {
            return;
        }
        let mut names = vec![0u16; length as usize];
        if unsafe {
            GetVolumePathNamesForVolumeNameW(
                volume.as_ptr(),
                names.as_mut_ptr(),
                length,
                &mut length,
            )
        } == 0
        {
            return;
        }
        for name in names
            .split_inclusive(|unit| *unit == 0)
            .take_while(|name| name.len() > 1)
        {
            // Drive letters have already been included. Directory mounts are otherwise skipped as reparse points.
            if name.len() > 4 && local_drive(name) {
                roots.push(OsString::from_wide(&name[..name.len() - 1]).into());
            }
        }
    }

    pub(super) fn local_roots(cancelled: impl Fn() -> bool) -> Vec<PathBuf> {
        let mut roots = Vec::new();
        if cancelled() {
            return roots;
        }
        let drives = unsafe { GetLogicalDrives() };
        for index in 0u8..26 {
            if cancelled() {
                return roots;
            }
            let root = drive_root(b'A' + index);
            if drives & (1 << index) != 0 && local_drive(&root) {
                roots.push(OsString::from_wide(&root[..3]).into());
            }
        }
        let mut volume = [0u16; MAX_PATH as usize];
        let search = unsafe { FindFirstVolumeW(volume.as_mut_ptr(), MAX_PATH) };
        if search == INVALID_HANDLE_VALUE {
            return roots;
        }
        let search = VolumeSearch(search);
        while !cancelled() {
            add_folder_mounts(&volume, &mut roots);
            if unsafe { FindNextVolumeW(search.0, volume.as_mut_ptr(), MAX_PATH) } == 0 {
                break;
            }
        }
        roots
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::Cell;
    use std::sync::atomic::{AtomicUsize, Ordering};

    struct Fixture(PathBuf);

    impl Fixture {
        fn new() -> Self {
            static NEXT: AtomicUsize = AtomicUsize::new(0);
            loop {
                let id = NEXT.fetch_add(1, Ordering::Relaxed);
                let path = env::temp_dir().join(format!("ldfcl-java-{}-{id}", std::process::id()));
                match fs::create_dir(&path) {
                    Ok(()) => return Self(path),
                    Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {}
                    Err(error) => panic!("Could not create Java fixture: {error}"),
                }
            }
        }

        fn write_runtime(&self, release: &str) -> PathBuf {
            let home = self.0.join("自定义目录/Java 运行时");
            let bin = home.join("bin");
            fs::create_dir_all(&bin).unwrap();
            fs::write(home.join("release"), release).unwrap();
            let executable = bin.join(platform::JAVA_FILENAMES[0]);
            fs::write(&executable, "fixture").unwrap();
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                fs::set_permissions(&executable, fs::Permissions::from_mode(0o755)).unwrap();
            }
            executable
        }
    }

    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn detects_release_metadata_and_streams_preferred_installation() {
        let fixture = Fixture::new();
        let path = fixture.write_runtime("JAVA_VERSION=\"1.8.0_412\"\r\n");
        let java = identify_java_runtime(&path).unwrap();
        assert_eq!(java.major, 8);
        assert!(java.compatible);

        let cancelled = Cell::new(false);
        let mut discovered = Vec::new();
        discover_java_runtimes(
            &[fixture.0.clone()],
            || cancelled.get(),
            |runtime| {
                discovered.push(runtime);
                cancelled.set(true);
            },
        );
        assert_eq!(discovered.len(), 1);
        assert_eq!(
            java_for_major(&discovered, 8),
            Some(java.executable.as_path())
        );
        assert_eq!(java_for_major(&discovered, 17), None);
    }

    #[test]
    fn rejects_incompatible_architecture_and_malformed_versions() {
        let fixture = Fixture::new();
        let incompatible = if env::consts::ARCH == "x86" {
            "x86_64"
        } else {
            "x86"
        };
        let path = fixture.write_runtime(&format!(
            "JAVA_VERSION=\"21-ea\"\nOS_ARCH=\"{incompatible}\"\n"
        ));
        let java = identify_java_runtime(&path).unwrap();
        assert_eq!(java.major, 21);
        if architecture(env::consts::ARCH) != Architecture::Unknown {
            assert!(!java.compatible);
            assert_eq!(java_for_major(&[java], 21), None);
        }
        assert_eq!(parse_major("21foo"), None);
        assert_eq!(parse_major("1.0"), None);
        assert_eq!(parse_major("21.0.6+7"), Some(21));
    }
}
