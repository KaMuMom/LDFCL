#include "controller.hpp"

#include <QtConcurrentRun>

namespace {
QUrl file_url(const ldfcl::fs::path& path) {
  return path.empty() ? QUrl{} : QUrl::fromLocalFile(QString::fromUtf8(path.u8string()));
}

ldfcl::fs::path local_path(const QUrl& url) {
  return ldfcl::fs::u8path(url.toLocalFile().toUtf8().toStdString());
}
}  // namespace

LauncherController::LauncherController()
    : game_folder_(file_url(ldfcl::default_game_directory())),
      java_(file_url(ldfcl::default_java())) {
  connect(&launch_, &QFutureWatcher<QString>::finished, this, [this] {
    running_ = false;
    setStatus(launch_.result());
    emit runningChanged();
  });
  refreshVersions();
}

QString LauncherController::localPath(const QUrl& url) const {
  return url.toLocalFile();
}

void LauncherController::setGameFolder(const QUrl& url) {
  if (running_ || !url.isLocalFile()) return;
  game_folder_ = url;
  emit gameFolderChanged();
  refreshVersions();
}

void LauncherController::setJavaExecutable(const QUrl& url) {
  if (running_ || !url.isLocalFile()) return;
  java_ = url;
  emit javaExecutableChanged();
  setStatus(versions_.empty() ? tr("此目录没有已安装的游戏版本。") : tr("使用离线身份 Player。"));
}

void LauncherController::setStatus(QString status) {
  if (status_ == status) return;
  status_ = std::move(status);
  emit statusChanged();
}

void LauncherController::refreshVersions() {
  versions_.clear();
  try {
    for (const auto& version : ldfcl::installed_versions(local_path(game_folder_)))
      versions_.push_back(QString::fromUtf8(version));
    if (versions_.empty()) setStatus(tr("此目录没有已安装的游戏版本。"));
    else if (java_.isEmpty()) setStatus(tr("请选择已安装的 Java。"));
    else setStatus(tr("使用离线身份 Player。"));
  } catch (const std::exception& error) {
    setStatus(QString::fromUtf8(error.what()));
  }
  emit versionsChanged();
}

void LauncherController::launchGame(const QString& version) {
  if (running_ || java_.isEmpty() || !versions_.contains(version)) return;
  const auto root = local_path(game_folder_);
  const auto java = local_path(java_);
  running_ = true;
  emit runningChanged();
  setStatus(tr("正在启动或运行游戏…"));
  launch_.setFuture(QtConcurrent::run([root, java, id = version.toUtf8().toStdString()] {
    try {
      const auto code = ldfcl::launch(root, id, java, root / "ldfcl-launch.log");
      return code == 0 ? tr("游戏已退出。")
                       : tr("Java 退出码 %1。请查看 ldfcl-launch.log。").arg(code);
    } catch (const std::exception& error) {
      return tr("启动失败：%1").arg(QString::fromUtf8(error.what()));
    }
  }));
}
