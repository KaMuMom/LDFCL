mod view;

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::thread;

use gpui::{AppContext, Context, Entity, PathPromptOptions, Subscription, Window};
use gpui_component::IndexPath;
use gpui_component::select::{SelectEvent, SelectState};
use ldfcl::java::{JavaRuntime, default_java, discover_java_runtimes, identify_java_runtime};
use ldfcl::launcher::{
    GameLayout, default_game_directory, installed_versions, launch, required_java_major,
    resolve_game_directory,
};
use ldfcl::settings::{Settings, SettingsStore};

use self::view::JavaOption;

const LAYOUTS: [(&str, GameLayout); 3] = [
    ("自动识别", GameLayout::Automatic),
    ("共享游戏目录", GameLayout::Shared),
    ("各实例独立", GameLayout::Isolated),
];

enum ScanEvent {
    Found(JavaRuntime),
    Finished,
}

pub struct Launcher {
    store: Option<SettingsStore>,
    settings: Settings,
    game_directory: PathBuf,
    versions: Vec<String>,
    game_version: Option<String>,
    required_java: u32,
    manual_java: Option<PathBuf>,
    runtimes: Vec<JavaRuntime>,
    scan: Option<Arc<AtomicBool>>,
    scan_failed: bool,
    settings_open: bool,
    running: bool,
    status: String,
    version_picker: Entity<SelectState<Vec<String>>>,
    java_picker: Entity<SelectState<Vec<JavaOption>>>,
    layout_picker: Entity<SelectState<Vec<&'static str>>>,
    _subscriptions: [Subscription; 3],
}

impl Launcher {
    pub fn new(window: &mut Window, cx: &mut Context<Self>) -> Self {
        let (store, settings) = match SettingsStore::for_current_installation() {
            Ok(store) => {
                let settings = store.load();
                (Some(store), settings)
            }
            Err(error) => (None, Err(error)),
        };
        let settings_error = settings
            .as_ref()
            .err()
            .map(|error| format!("读取设置失败：{error}"));
        let cache_error = store.as_ref().and_then(|store| {
            fs::create_dir_all(store.root().join("cache"))
                .err()
                .map(|error| format!("无法创建安装目录中的缓存：{error}"))
        });
        let settings = settings.unwrap_or_default();
        let game_directory = settings
            .game_directory
            .clone()
            .unwrap_or_else(default_game_directory);
        let game_directory = resolve_game_directory(&game_directory).unwrap_or(game_directory);
        let manual_java = settings.java_executable.clone().or_else(default_java);
        let version_picker = cx.new(|cx| SelectState::new(Vec::<String>::new(), None, window, cx));
        let java_picker = cx.new(|cx| SelectState::new(Vec::<JavaOption>::new(), None, window, cx));
        let layout_index = LAYOUTS
            .iter()
            .position(|(_, layout)| *layout == settings.layout);
        let layout_picker = cx.new(|cx| {
            SelectState::new(
                LAYOUTS.iter().map(|(label, _)| *label).collect::<Vec<_>>(),
                layout_index.map(IndexPath::new),
                window,
                cx,
            )
        });
        let subscriptions = [
            cx.subscribe_in(&version_picker, window, |this, _, event, _, cx| {
                let SelectEvent::Confirm(version) = event;
                this.game_version = version.clone();
                this.refresh_requirement();
                cx.notify();
            }),
            cx.subscribe_in::<_, SelectEvent<Vec<JavaOption>>>(
                &java_picker,
                window,
                |this, _, event, _, cx| {
                    let SelectEvent::Confirm(path) = event;
                    if let Some(path) = path {
                        this.manual_java = Some(path.clone());
                        this.settings.java_executable = Some(path.clone());
                        this.save_settings();
                        cx.notify();
                    }
                },
            ),
            cx.subscribe_in(&layout_picker, window, |this, _, event, _, cx| {
                let SelectEvent::Confirm(label) = event;
                if let Some((_, layout)) = LAYOUTS.iter().find(|(name, _)| Some(*name) == *label) {
                    this.settings.layout = *layout;
                    this.save_settings();
                    cx.notify();
                }
            }),
        ];
        let mut launcher = Self {
            store,
            settings,
            game_directory,
            versions: Vec::new(),
            game_version: None,
            required_java: 0,
            manual_java,
            runtimes: Vec::new(),
            scan: None,
            scan_failed: false,
            settings_open: false,
            running: false,
            status: String::new(),
            version_picker,
            java_picker,
            layout_picker,
            _subscriptions: subscriptions,
        };
        launcher.refresh_versions(window, cx);
        launcher.rescan_java(window, cx);
        if let Some(error) = settings_error.or(cache_error) {
            launcher.status = error;
        }
        launcher
    }

    pub fn running(&self) -> bool {
        self.running
    }

    fn save_settings(&mut self) {
        if let Some(store) = &self.store {
            if let Err(error) = store.save(&self.settings) {
                self.status = format!("无法保存设置：{error}");
            }
        } else {
            self.status = "无法确定安装目录，设置未保存。".into();
        }
    }

    fn refresh_versions(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        self.versions.clear();
        match installed_versions(&self.game_directory) {
            Ok(versions) => {
                self.status = if versions.is_empty() {
                    "此目录没有已安装的游戏版本。".into()
                } else {
                    "使用离线身份 Player。".into()
                };
                self.versions = versions;
            }
            Err(error) => self.status = format!("读取游戏版本失败：{error}"),
        }
        let index = self
            .game_version
            .as_ref()
            .and_then(|version| {
                self.versions
                    .iter()
                    .position(|candidate| candidate == version)
            })
            .or_else(|| (!self.versions.is_empty()).then_some(0));
        self.game_version = index.map(|index| self.versions[index].clone());
        self.version_picker.update(cx, |picker, cx| {
            picker.set_items(self.versions.clone(), window, cx);
            picker.set_selected_index(index.map(IndexPath::new), window, cx);
        });
        self.refresh_requirement();
    }

    fn refresh_requirement(&mut self) {
        self.required_java = if self.settings.automatic_java {
            self.game_version
                .as_deref()
                .and_then(|version| required_java_major(&self.game_directory, version).ok())
                .unwrap_or(0)
        } else {
            0
        };
    }

    fn set_automatic_java(&mut self, enabled: bool, cx: &mut Context<Self>) {
        if self.running || self.settings.automatic_java == enabled {
            return;
        }
        self.settings.automatic_java = enabled;
        self.refresh_requirement();
        self.save_settings();
        cx.notify();
    }

    fn selected_java(&self) -> Option<&JavaRuntime> {
        if self.settings.automatic_java {
            self.runtimes.iter().find(|runtime| {
                self.required_java > 0 && runtime.major == self.required_java && runtime.compatible
            })
        } else {
            let path = self.manual_java.as_deref()?;
            self.runtimes
                .iter()
                .find(|runtime| same_path(path, &runtime.executable))
        }
    }

    fn remember_runtime(&mut self, runtime: JavaRuntime) {
        if let Some(existing) = self
            .runtimes
            .iter_mut()
            .find(|existing| same_path(&existing.executable, &runtime.executable))
        {
            *existing = runtime;
        } else {
            self.runtimes.push(runtime);
        }
    }

    fn refresh_java_picker(
        &mut self,
        window: &mut Window,
        cx: &mut Context<Self>,
        selection_may_have_moved: bool,
    ) {
        let options = self.runtimes.iter().map(JavaOption::from).collect();
        let manual = self.manual_java.as_ref().and_then(|path| {
            self.runtimes
                .iter()
                .find(|runtime| same_path(path, &runtime.executable))
                .map(|runtime| &runtime.executable)
        });
        self.java_picker.update(cx, |picker, cx| {
            picker.set_items(options, window, cx);
            if selection_may_have_moved || picker.selected_value() != manual {
                if let Some(path) = manual {
                    picker.set_selected_value(path, window, cx);
                } else {
                    picker.set_selected_index(None, window, cx);
                }
            }
        });
        cx.notify();
    }

    fn rescan_java(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if self.running {
            return;
        }
        self.cancel_scan();
        let mut saved = self.settings.added_java_paths.clone();
        if let Some(path) = &self.manual_java {
            saved.insert(0, path.clone());
        }
        let mut preferred = saved.clone();
        preferred.push(self.game_directory.join("runtime"));
        preferred.extend(self.runtimes.drain(..).map(|runtime| runtime.executable));
        for path in &saved {
            if let Some(runtime) = manual_java_runtime(path) {
                if self
                    .manual_java
                    .as_ref()
                    .is_some_and(|manual| same_path(manual, path))
                {
                    self.manual_java = Some(runtime.executable.clone());
                }
                self.remember_runtime(runtime);
            }
        }
        self.refresh_java_picker(window, cx, true);

        let cancelled = Arc::new(AtomicBool::new(false));
        let stop = cancelled.clone();
        let (sender, receiver) = async_channel::unbounded();
        let worker = thread::Builder::new()
            .name("java-scan".into())
            .spawn(move || {
                discover_java_runtimes(
                    &preferred,
                    || stop.load(Ordering::Relaxed),
                    |runtime| {
                        let _ = sender.try_send(ScanEvent::Found(runtime));
                    },
                );
                let _ = sender.try_send(ScanEvent::Finished);
            });
        self.scan_failed = worker.is_err();
        if let Ok(worker) = worker {
            drop(worker);
            self.scan = Some(cancelled.clone());
            cx.spawn_in(window, async move |launcher, cx| {
                while let Ok(event) = receiver.recv().await {
                    let keep_reading = launcher.update_in(cx, |this, window, cx| match event {
                        ScanEvent::Found(runtime) => {
                            if cancelled.load(Ordering::Relaxed) {
                                return false;
                            }
                            this.remember_runtime(runtime);
                            this.refresh_java_picker(window, cx, false);
                            true
                        }
                        ScanEvent::Finished => {
                            if !cancelled.load(Ordering::Relaxed) {
                                this.scan = None;
                                cx.notify();
                            }
                            false
                        }
                    });
                    if !matches!(keep_reading, Ok(true)) {
                        return;
                    }
                }
                let _ = launcher.update_in(cx, |this, _, cx| {
                    if !cancelled.load(Ordering::Relaxed) {
                        this.scan = None;
                        this.scan_failed = true;
                        cx.notify();
                    }
                });
            })
            .detach();
        }
        cx.notify();
    }

    fn cancel_scan(&mut self) {
        if let Some(scan) = self.scan.take() {
            scan.store(true, Ordering::Relaxed);
        }
    }

    fn browse(&self, directory: bool, window: &mut Window, cx: &mut Context<Self>) {
        let result = cx.prompt_for_paths(PathPromptOptions {
            files: !directory,
            directories: directory,
            multiple: false,
            prompt: Some("选择".into()),
        });
        cx.spawn_in(window, async move |launcher, cx| {
            let result = result.await;
            let _ = launcher.update_in(cx, |this, window, cx| {
                if this.running {
                    return;
                }
                match result {
                    Ok(Ok(Some(paths))) => {
                        if let Some(path) = paths.into_iter().next() {
                            if directory {
                                this.set_game_directory(path, window, cx);
                            } else {
                                this.add_java(path, window, cx);
                            }
                        }
                    }
                    Ok(Err(error)) => this.status = format!("无法打开文件选择窗口：{error}"),
                    _ => {}
                }
                cx.notify();
            });
        })
        .detach();
    }

    fn set_game_directory(&mut self, path: PathBuf, window: &mut Window, cx: &mut Context<Self>) {
        let root = match resolve_game_directory(&path) {
            Ok(root) => root,
            Err(error) => {
                self.status = format!("无法使用游戏目录：{error}");
                return;
            }
        };
        let changed = !same_path(&self.game_directory, &root);
        self.game_directory = root.clone();
        self.settings.game_directory = Some(root);
        self.refresh_versions(window, cx);
        self.save_settings();
        if changed {
            self.rescan_java(window, cx);
        }
    }

    fn add_java(&mut self, path: PathBuf, window: &mut Window, cx: &mut Context<Self>) {
        let Some(runtime) = manual_java_runtime(&path) else {
            self.status = "所选文件不可执行，请选择 Java 可执行文件。".into();
            return;
        };
        let path = runtime.executable.clone();
        self.remember_runtime(runtime);
        if !self
            .settings
            .added_java_paths
            .iter()
            .any(|saved| same_path(saved, &path))
        {
            self.settings.added_java_paths.push(path.clone());
        }
        if !self.settings.automatic_java {
            self.settings.java_executable = Some(path.clone());
            self.manual_java = Some(path);
        }
        self.save_settings();
        self.refresh_java_picker(window, cx, false);
    }

    fn launch_game(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if self.running {
            return;
        }
        let Some((version, java)) = self.game_version.clone().zip(self.selected_java()) else {
            return;
        };
        let java = java.executable.clone();
        let game_directory = self.game_directory.clone();
        let native_cache = self
            .store
            .as_ref()
            .map(|store| store.root().join("cache").join("natives"));
        let layout = self.settings.layout;
        let (sender, receiver) = async_channel::bounded(1);
        let worker = thread::Builder::new()
            .name("minecraft".into())
            .spawn(move || {
                let result = resolve_game_directory(&game_directory).and_then(|root| {
                    let log = root.join("ldfcl-launch.log");
                    launch(
                        &root,
                        &version,
                        &java,
                        Some(&log),
                        layout,
                        native_cache.as_deref(),
                    )
                });
                let _ = sender.try_send(result);
            });
        if let Err(error) = worker {
            self.status = format!("启动失败：{error}");
            cx.notify();
            return;
        }
        self.running = true;
        self.status = "正在启动或运行游戏…".into();
        cx.notify();

        cx.spawn_in(window, async move |launcher, cx| {
            let status = match receiver.recv().await {
                Ok(Ok(0)) => "游戏已退出。".into(),
                Ok(Ok(code)) => format!("Java 退出码 {code}。请查看 ldfcl-launch.log。"),
                Ok(Err(error)) => format!("启动失败：{error}"),
                Err(_) => "启动任务意外退出。请查看 ldfcl-launch.log。".into(),
            };
            let _ = launcher.update_in(cx, |this, _, cx| {
                this.running = false;
                this.status = status;
                cx.notify();
            });
        })
        .detach();
    }
}

impl Drop for Launcher {
    fn drop(&mut self) {
        self.cancel_scan();
    }
}

fn manual_java_runtime(path: &Path) -> Option<JavaRuntime> {
    if let Some(runtime) = identify_java_runtime(path) {
        return Some(runtime);
    }
    let metadata = fs::metadata(path).ok()?;
    if !metadata.is_file() {
        return None;
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        if metadata.permissions().mode() & 0o111 == 0 {
            return None;
        }
    }
    #[cfg(windows)]
    if !path
        .extension()
        .is_some_and(|ext| ext.eq_ignore_ascii_case("exe"))
    {
        return None;
    }
    Some(JavaRuntime {
        executable: path.to_path_buf(),
        major: 0,
        compatible: false,
    })
}

fn same_path(left: &Path, right: &Path) -> bool {
    #[cfg(windows)]
    {
        left.to_string_lossy()
            .eq_ignore_ascii_case(&right.to_string_lossy())
    }
    #[cfg(not(windows))]
    {
        left == right
    }
}
