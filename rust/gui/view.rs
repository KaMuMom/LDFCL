use std::path::PathBuf;

use gpui::{
    App, Context, Div, FontWeight, IntoElement, Render, SharedString, Window, div, prelude::*, px,
    rgb,
};
use gpui_component::button::{Button, ButtonVariants};
use gpui_component::select::{Select, SelectItem};
use gpui_component::switch::Switch;
use gpui_component::{Disableable, Sizable};
use ldfcl::java::JavaRuntime;

use super::Launcher;

#[derive(Clone)]
pub(super) struct JavaOption {
    path: PathBuf,
    major: u32,
}

impl From<&JavaRuntime> for JavaOption {
    fn from(runtime: &JavaRuntime) -> Self {
        Self {
            path: runtime.executable.clone(),
            major: runtime.major,
        }
    }
}

impl SelectItem for JavaOption {
    type Value = PathBuf;

    fn title(&self) -> SharedString {
        let label = if self.major == 0 {
            "Java 版本未知".into()
        } else {
            format!("Java {}", self.major)
        };
        format!("{label} · {}", self.path.display()).into()
    }

    fn render(&self, _: &mut Window, _: &mut App) -> impl IntoElement {
        div().min_w(px(0.)).flex_1().truncate().child(self.title())
    }

    fn value(&self) -> &Self::Value {
        &self.path
    }
}

impl Launcher {
    fn java_description(&self) -> String {
        match self.selected_java() {
            Some(java) if self.settings.automatic_java => format!("Java {} · 自动选择", java.major),
            Some(java) if java.major > 0 => format!("Java {} · 手动选择", java.major),
            Some(_) => "Java · 手动选择".into(),
            None if self.game_version.is_none() => String::new(),
            None if !self.settings.automatic_java => "请在设置中选择 Java。".into(),
            None if self.required_java == 0 => {
                "无法确定此游戏版本需要的 Java，可在设置中手动选择。".into()
            }
            None if self.scan.is_some() => format!("正在查找所需的 Java {}…", self.required_java),
            None => format!("请在设置中添加兼容的 Java {}。", self.required_java),
        }
    }

    fn scan_description(&self) -> String {
        let count = self.runtimes.len();
        if self.scan.is_some() {
            format!("正在扫描本机 Java，已找到 {count} 套。")
        } else if self.scan_failed {
            format!("Java 扫描未完成。已找到 {count} 套。")
        } else {
            format!("已找到 {count} 套 Java。")
        }
    }

    fn home_view(&self, cx: &mut Context<Self>) -> impl IntoElement {
        let java_description = self.java_description();
        let can_launch =
            !self.running && self.game_version.is_some() && self.selected_java().is_some();
        div()
            .flex()
            .flex_col()
            .gap_4()
            .child(
                card()
                    .child(label("游戏版本"))
                    .child(
                        div().h(px(42.)).child(
                            Select::new(&self.version_picker)
                                .placeholder("没有可启动的版本")
                                .disabled(self.running || self.versions.is_empty()),
                        ),
                    )
                    .when(!java_description.is_empty(), |this| {
                        this.child(div().text_sm().child(java_description))
                    }),
            )
            .child(
                div()
                    .flex()
                    .items_center()
                    .gap_4()
                    .child(
                        div()
                            .min_w(px(0.))
                            .flex_1()
                            .text_sm()
                            .child(self.status.clone()),
                    )
                    .child(
                        Button::new("launch")
                            .primary()
                            .label(if self.running {
                                "运行中…"
                            } else {
                                "启动游戏"
                            })
                            .disabled(!can_launch)
                            .on_click(
                                cx.listener(|this, _, window, cx| this.launch_game(window, cx)),
                            ),
                    ),
            )
    }

    fn settings_view(&self, cx: &mut Context<Self>) -> impl IntoElement {
        div()
            .flex()
            .flex_col()
            .gap_4()
            .child(
                card()
                    .child(label("游戏目录"))
                    .child(
                        div()
                            .flex()
                            .items_center()
                            .gap_2()
                            .child(
                                div()
                                    .min_w(px(0.))
                                    .flex_1()
                                    .rounded(px(8.))
                                    .bg(rgb(0xedf4f0))
                                    .px_3()
                                    .py_2()
                                    .truncate()
                                    .child(self.game_directory.display().to_string()),
                            )
                            .child(
                                Button::new("browse-games")
                                    .label("浏览…")
                                    .disabled(self.running)
                                    .on_click(cx.listener(|this, _, window, cx| {
                                        this.browse(true, window, cx)
                                    })),
                            ),
                    )
                    .child(
                        Switch::new("automatic-java")
                            .label("按游戏版本自动选择 Java")
                            .checked(self.settings.automatic_java)
                            .disabled(self.running)
                            .on_click(cx.listener(|this, enabled, _, cx| {
                                this.set_automatic_java(*enabled, cx)
                            })),
                    )
                    .when(!self.settings.automatic_java, |this| {
                        this.child(
                            div().h(px(42.)).child(
                                Select::new(&self.java_picker)
                                    .placeholder(if self.runtimes.is_empty() {
                                        "暂无可选的 Java"
                                    } else {
                                        "选择 Java"
                                    })
                                    .disabled(self.running || self.runtimes.is_empty()),
                            ),
                        )
                    })
                    .child(
                        div()
                            .flex()
                            .items_center()
                            .gap_3()
                            .child(
                                Button::new("add-java")
                                    .small()
                                    .label("手动添加 Java")
                                    .disabled(self.running)
                                    .on_click(cx.listener(|this, _, window, cx| {
                                        this.browse(false, window, cx)
                                    })),
                            )
                            .child(
                                div()
                                    .min_w(px(0.))
                                    .flex_1()
                                    .text_sm()
                                    .child(self.scan_description()),
                            )
                            .child(
                                Button::new("rescan-java")
                                    .small()
                                    .label("重新扫描")
                                    .disabled(self.running || self.scan.is_some())
                                    .on_click(cx.listener(|this, _, window, cx| {
                                        this.rescan_java(window, cx)
                                    })),
                            ),
                    )
                    .child(label("版本隔离"))
                    .child(
                        div()
                            .h(px(42.))
                            .child(Select::new(&self.layout_picker).disabled(self.running)),
                    ),
            )
            .child(div().text_sm().child(self.status.clone()))
    }
}

impl Render for Launcher {
    fn render(&mut self, _: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let title = if self.settings_open {
            "设置"
        } else {
            "Minecraft 启动器"
        };
        let body = if self.settings_open {
            self.settings_view(cx).into_any_element()
        } else {
            self.home_view(cx).into_any_element()
        };
        div()
            .size_full()
            .flex()
            .items_center()
            .justify_center()
            .px_6()
            .bg(rgb(0xedf3f0))
            .text_color(rgb(0x172c23))
            .child(
                div()
                    .w_full()
                    .max_w(px(620.))
                    .flex()
                    .flex_col()
                    .gap_4()
                    .child(
                        div()
                            .flex()
                            .justify_between()
                            .items_center()
                            .gap_3()
                            .child(
                                div()
                                    .flex()
                                    .flex_col()
                                    .gap_1()
                                    .child(
                                        div()
                                            .text_sm()
                                            .text_color(rgb(0x19734f))
                                            .font_weight(FontWeight::BOLD)
                                            .child("LDFCL"),
                                    )
                                    .child(
                                        div()
                                            .text_size(px(32.))
                                            .font_weight(FontWeight::BOLD)
                                            .child(title),
                                    ),
                            )
                            .child(
                                Button::new("settings")
                                    .label(if self.settings_open {
                                        "返回首页"
                                    } else {
                                        "设置"
                                    })
                                    .on_click(cx.listener(|this, _, _, cx| {
                                        this.settings_open = !this.settings_open;
                                        cx.notify();
                                    })),
                            ),
                    )
                    .child(body),
            )
    }
}

fn card() -> Div {
    div()
        .w_full()
        .flex()
        .flex_col()
        .gap_2()
        .p_5()
        .rounded(px(20.))
        .bg(rgb(0xffffff))
}

fn label(text: &'static str) -> Div {
    div().font_weight(FontWeight::BOLD).child(text)
}
