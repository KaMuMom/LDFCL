#![cfg_attr(target_os = "windows", windows_subsystem = "windows")]

mod gui;

use gpui::{
    App, AppContext, Application, Bounds, TitlebarOptions, WindowBounds, WindowOptions, px, rgb,
    size,
};
use gpui_component::{Root, Theme, ThemeMode};
use gpui_component_assets::Assets;

fn main() {
    Application::new().with_assets(Assets).run(|cx: &mut App| {
        gpui_component::init(cx);
        gpui_component::set_locale("zh-CN");
        Theme::change(ThemeMode::Light, None, cx);
        let theme = Theme::global_mut(cx);
        theme.primary = rgb(0x19734f).into();
        theme.primary_foreground = rgb(0xffffff).into();

        cx.on_window_closed(|cx| {
            if cx.windows().is_empty() {
                cx.quit();
            }
        })
        .detach();
        let bounds = Bounds::centered(None, size(px(720.), px(516.)), cx);
        let result = cx.open_window(
            WindowOptions {
                titlebar: Some(TitlebarOptions {
                    title: Some("LDFCL · Minecraft 启动器".into()),
                    ..Default::default()
                }),
                window_bounds: Some(WindowBounds::Windowed(bounds)),
                window_min_size: Some(size(px(550.), px(480.))),
                app_id: Some("LDFCL".into()),
                ..Default::default()
            },
            |window, cx| {
                let launcher = cx.new(|cx| gui::Launcher::new(window, cx));
                let weak_launcher = launcher.downgrade();
                window.on_window_should_close(cx, move |window, cx| {
                    let running = weak_launcher
                        .upgrade()
                        .is_some_and(|launcher| launcher.read(cx).running());
                    if running {
                        window.minimize_window();
                    }
                    !running
                });
                cx.new(|cx| Root::new(launcher, window, cx))
            },
        );
        if let Err(error) = result {
            eprintln!("LDFCL: {error:#}");
            cx.quit();
            return;
        }
        cx.activate(true);
    });
}
