#pragma once

#include "launcher.hpp"

#include <QFutureWatcher>
#include <QObject>
#include <QStringList>
#include <QUrl>

class LauncherController : public QObject {
  Q_OBJECT
  Q_PROPERTY(QUrl gameFolder READ gameFolder NOTIFY gameFolderChanged)
  Q_PROPERTY(QUrl javaExecutable READ javaExecutable NOTIFY javaExecutableChanged)
  Q_PROPERTY(QStringList versions READ versions NOTIFY versionsChanged)
  Q_PROPERTY(QString status READ status NOTIFY statusChanged)
  Q_PROPERTY(bool running READ running NOTIFY runningChanged)
  Q_PROPERTY(int gameLayout READ gameLayout WRITE setGameLayout NOTIFY gameLayoutChanged)

 public:
  LauncherController();

  QUrl gameFolder() const { return game_folder_; }
  QUrl javaExecutable() const { return java_; }
  QStringList versions() const { return versions_; }
  QString status() const { return status_; }
  bool running() const { return running_; }
  int gameLayout() const { return static_cast<int>(layout_); }
  void setGameLayout(int layout);

  Q_INVOKABLE QString localPath(const QUrl& url) const;
  Q_INVOKABLE void setGameFolder(const QUrl& url);
  Q_INVOKABLE void setJavaExecutable(const QUrl& url);
  Q_INVOKABLE void launchGame(const QString& version);

 signals:
  void gameFolderChanged();
  void javaExecutableChanged();
  void versionsChanged();
  void statusChanged();
  void runningChanged();
  void gameLayoutChanged();

 private:
  void refreshVersions();
  void setStatus(QString status);

  QUrl game_folder_, java_;
  QStringList versions_;
  QString status_;
  bool running_ = false;
  ldfcl::GameLayout layout_ = ldfcl::GameLayout::automatic;
  QFutureWatcher<QString> launch_;
};
