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

    property bool settingsOpen: false

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

        RowLayout {
            Layout.fillWidth: true
            ColumnLayout {
                spacing: 5
                Text { text: "LDFCL"; color: launcherTheme.focusColor; font.bold: true }
                Text {
                    text: window.settingsOpen ? qsTr("设置") : qsTr("Minecraft 启动器")
                    color: launcherTheme.textColor
                    font.pixelSize: 32
                    font.bold: true
                }
            }
            Item { Layout.fillWidth: true }
            EButton {
                objectName: "settingsButton"
                theme: launcherTheme
                text: window.settingsOpen ? qsTr("返回首页") : qsTr("设置")
                size: "s"
                radius: 11
                containerColor: launcherTheme.primaryColor
                shadowEnabled: false
                onClicked: {
                    versionPicker.opened = false
                    layoutPicker.opened = false
                    window.settingsOpen = !window.settingsOpen
                }
            }
        }

        ECard {
            theme: launcherTheme
            Layout.fillWidth: true
            cardColor: launcherTheme.primaryColor
            padding: 22
            shadowEnabled: false
            visible: !window.settingsOpen
            z: versionPicker.opened ? 2 : 0

            Label { text: qsTr("游戏版本"); color: launcherTheme.textColor; font.bold: true }
            EDropdown {
                id: versionPicker
                objectName: "versionPicker"
                theme: launcherTheme
                Layout.fillWidth: true
                Layout.preferredHeight: 46
                title: qsTr("没有可启动的版本")
                headerHeight: 46
                popupMaxHeight: 180
                radius: 11
                shadowEnabled: false
                enabled: !window.launcher.running && model.length > 0
                model: Array.from(window.launcher.versions, name => ({text: name}))
                onModelChanged: {
                    opened = false
                    selectedIndex = model.length ? 0 : -1
                }
            }
        }

        ECard {
            theme: launcherTheme
            Layout.fillWidth: true
            cardColor: launcherTheme.primaryColor
            padding: 22
            shadowEnabled: false
            visible: window.settingsOpen
            enabled: !window.launcher.running

            Label { text: qsTr("游戏目录"); color: launcherTheme.textColor; font.bold: true }
            PathRow {
                Layout.fillWidth: true
                pathText: window.launcher.localPath(window.launcher.gameFolder)
                fieldName: qsTr("游戏目录")
                onBrowse: gameDialog.open()
            }
            Label { text: qsTr("Java 可执行文件"); color: launcherTheme.textColor; font.bold: true }
            PathRow {
                Layout.fillWidth: true
                pathText: window.launcher.localPath(window.launcher.javaExecutable)
                fieldName: qsTr("Java 可执行文件")
                onBrowse: javaDialog.open()
            }
            Label { text: qsTr("版本隔离"); color: launcherTheme.textColor; font.bold: true }
            EDropdown {
                id: layoutPicker
                theme: launcherTheme
                Layout.fillWidth: true
                Layout.preferredHeight: 42
                headerHeight: 42
                popupDirection: 1
                z: opened ? 2 : 0
                radius: 11
                shadowEnabled: false
                model: [{text: qsTr("自动识别")}, {text: qsTr("共享游戏目录")}, {text: qsTr("各实例独立")}]
                selectedIndex: window.launcher.gameLayout
                onSelectionChanged: function(index) { window.launcher.gameLayout = index }
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
                visible: !window.settingsOpen
                theme: launcherTheme
                text: window.launcher.running ? qsTr("运行中…") : qsTr("启动游戏")
                containerColor: enabled ? launcherTheme.focusColor : "#71857a"
                textColor: "white"
                size: "m"
                radius: 14
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
