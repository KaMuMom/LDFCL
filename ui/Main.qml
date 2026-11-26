import QtQuick
import QtQuick.Controls
import QtQuick.Dialogs
import QtQuick.Layouts

ApplicationWindow {
    id: window
    required property var launcher
    width: 720
    height: 516
    minimumWidth: 550
    minimumHeight: 480
    visible: true
    title: qsTr("LDFCL · Minecraft 启动器")
    color: "#edf3f0"

    ETheme {
        id: launcherTheme
        primaryColor: "#ffffff"
        secondaryColor: "#edf4f0"
        textColor: "#172c23"
        defaultFocusColor: "#19734f"
    }

    component PathRow: RowLayout {
        required property string pathText
        required property string fieldName
        signal browse()
        spacing: 10

        TextField {
            Layout.fillWidth: true
            Layout.preferredHeight: 40
            leftPadding: 13
            readOnly: true
            text: parent.pathText
            placeholderText: qsTr("尚未选择")
            Accessible.name: parent.fieldName
            color: launcherTheme.textColor
            selectByMouse: true
            background: Rectangle {
                color: launcherTheme.secondaryColor
                radius: 11
            }
        }
        EButton {
            theme: launcherTheme
            text: qsTr("浏览…")
            size: "s"
            radius: 11
            shadowEnabled: false
            onClicked: parent.browse()
        }
    }

    ColumnLayout {
        width: Math.min(620, window.width - 56)
        anchors.centerIn: parent
        spacing: 18

        ColumnLayout {
            spacing: 5
            Text {
                text: "LDFCL"
                color: launcherTheme.focusColor
                font.pixelSize: 13
                font.bold: true
            }
            Text {
                text: qsTr("Minecraft 启动器")
                color: launcherTheme.textColor
                font.pixelSize: 34
                font.bold: true
            }
        }

        ECard {
            theme: launcherTheme
            Layout.fillWidth: true
            cardColor: launcherTheme.primaryColor
            padding: 22
            shadowEnabled: false

            ColumnLayout {
                Layout.fillWidth: true
                spacing: 7

                Label { text: qsTr("游戏目录"); color: launcherTheme.textColor; font.bold: true }
                PathRow {
                    Layout.fillWidth: true
                    pathText: window.launcher.localPath(window.launcher.gameFolder)
                    fieldName: qsTr("游戏目录")
                    enabled: !window.launcher.running
                    onBrowse: gameDialog.open()
                }
                Label {
                    Layout.topMargin: 8
                    text: qsTr("游戏版本")
                    color: launcherTheme.textColor
                    font.bold: true
                }
                EDropdown {
                    id: versionPicker
                    objectName: "versionPicker"
                    theme: launcherTheme
                    Layout.fillWidth: true
                    Layout.preferredHeight: 42
                    z: opened ? 2 : 0
                    title: qsTr("请选择已安装的版本")
                    headerHeight: 42
                    popupMaxHeight: 150
                    radius: 11
                    shadowEnabled: false
                    enabled: !window.launcher.running && model.length > 0
                    model: Array.from(window.launcher.versions, name => ({text: name}))
                    Component.onCompleted: selectedIndex = model.length ? 0 : -1
                    Connections {
                        target: window.launcher
                        function onVersionsChanged() {
                            versionPicker.opened = false
                            versionPicker.selectedIndex = versionPicker.model.length ? 0 : -1
                        }
                    }
                }
                Label {
                    Layout.topMargin: 8
                    text: qsTr("Java 可执行文件")
                    color: launcherTheme.textColor
                    font.bold: true
                }
                PathRow {
                    Layout.fillWidth: true
                    pathText: window.launcher.localPath(window.launcher.javaExecutable)
                    fieldName: qsTr("Java 可执行文件")
                    enabled: !window.launcher.running
                    onBrowse: javaDialog.open()
                }
            }
        }

        RowLayout {
            Layout.fillWidth: true
            spacing: 14
            Label {
                Layout.fillWidth: true
                text: window.launcher.status
                wrapMode: Text.Wrap
                color: launcherTheme.textColor
                font.pixelSize: 14
            }
            EButton {
                objectName: "launchButton"
                theme: launcherTheme
                text: window.launcher.running ? qsTr("运行中…") : qsTr("启动游戏")
                containerColor: enabled ? launcherTheme.focusColor : "#71857a"
                textColor: "white"
                size: "s"
                radius: 12
                shadowEnabled: false
                enabled: !window.launcher.running
                         && versionPicker.selectedIndex >= 0
                         && versionPicker.selectedIndex < versionPicker.model.length
                         && window.launcher.localPath(window.launcher.javaExecutable) !== ""
                onClicked: {
                    if (enabled)
                        window.launcher.launchGame(versionPicker.model[versionPicker.selectedIndex].text)
                }
            }
        }
    }

    FolderDialog {
        id: gameDialog
        title: qsTr("选择 Minecraft 游戏目录")
        currentFolder: window.launcher.gameFolder
        onAccepted: window.launcher.setGameFolder(selectedFolder)
    }
    FileDialog {
        id: javaDialog
        title: qsTr("选择 Java 可执行文件")
        nameFilters: Qt.platform.os === "windows"
                     ? [qsTr("Java 可执行文件 (java.exe javaw.exe)"), qsTr("所有文件 (*)")]
                     : [qsTr("所有文件 (*)")]
        onAccepted: window.launcher.setJavaExecutable(selectedFile)
    }

    onClosing: function(event) {
        if (window.launcher.running) {
            event.accepted = false
            window.showMinimized()
        }
    }
}
