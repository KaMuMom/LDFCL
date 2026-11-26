#include "controller.hpp"

#include <QGuiApplication>
#include <QQmlApplicationEngine>
#include <QQuickStyle>

int main(int argc, char** argv) {
  QGuiApplication app(argc, argv);
  QCoreApplication::setOrganizationName("LDFCL");
  QCoreApplication::setApplicationName("LDFCL");
  QQuickStyle::setStyle("Basic");

  LauncherController launcher;
  QQmlApplicationEngine engine;
  engine.setInitialProperties({{"launcher", QVariant::fromValue(&launcher)}});
  QObject::connect(&engine, &QQmlApplicationEngine::objectCreationFailed,
                   &app, [] { QCoreApplication::exit(1); }, Qt::QueuedConnection);
  engine.loadFromModule("Ldfcl", "Main");
  return app.exec();
}
