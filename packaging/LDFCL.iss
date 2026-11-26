[Setup]
AppId={{D36A8869-A15C-461A-97B8-5811D65F2D38}
AppName=LDFCL
AppVersion={#ReleaseTag}
AppPublisher=LDFCL
AppPublisherURL=https://github.com/KaMuMom/LDFCL
DefaultDirName={localappdata}\Programs\LDFCL
DefaultGroupName=LDFCL
DisableProgramGroupPage=yes
PrivilegesRequired=lowest
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
UninstallDisplayIcon={app}\LDFCL.exe
UninstallFilesDir={app}\runtime\uninstall
LicenseFile={#SourceRoot}\LICENSE
OutputDir={#OutputRoot}
OutputBaseFilename=LDFCL-{#ReleaseTag}-Windows-x64-Setup
Compression=lzma2
SolidCompression=yes
WizardStyle=modern

[Files]
Source: "{#SourceRoot}\*"; DestDir: "{app}\runtime"; Flags: ignoreversion recursesubdirs
Source: "{#EntryRoot}\LDFCL.exe"; DestDir: "{app}"; Flags: ignoreversion
Source: "{#EntryRoot}\Uninstall.exe"; DestDir: "{app}"; Flags: ignoreversion

[Icons]
Name: "{autoprograms}\LDFCL"; Filename: "{app}\LDFCL.exe"

[Run]
Filename: "{app}\LDFCL.exe"; Description: "{cm:LaunchProgram,LDFCL}"; Flags: nowait postinstall skipifsilent


[Code]
const
  SettingsKey = 'Software\LDFCL\LDFCL';
  GameDirectoryValue = 'gameDirectory';

var
  GameMode: TInputOptionWizardPage;
  ExistingGame: TInputDirWizardPage;
  SelectedGame: String;

function ExistingGameRoot(Path: String): String;
begin
  Result := '';
  Path := Trim(Path);
  if Path = '' then Exit;
  if DirExists(AddBackslash(Path) + 'versions') then
    Result := Path
  else if DirExists(AddBackslash(Path) + '.minecraft\versions') then
    Result := AddBackslash(Path) + '.minecraft';
end;

procedure InitializeWizard;
var
  PreviousGame, RequestedGame: String;
begin
  GameMode := CreateInputOptionPage(wpSelectDir, '选择游戏目录',
    '全新安装或使用现有 Minecraft 游戏目录', '使用现有目录时，LDFCL 会直接读取其中已安装的游戏版本。',
    True, False);
  GameMode.Add('全新安装');
  GameMode.Add('使用 PCL / HMCL 的现有游戏目录');
  GameMode.SelectedValueIndex := 0;

  ExistingGame := CreateInputDirPage(GameMode.ID, '选择现有游戏目录',
    '选择 .minecraft 或它所在的启动器目录',
    '请选择包含 versions 的游戏目录，也可以选择旁边放有 .minecraft 的启动器目录。',
    False, '');
  ExistingGame.Add('游戏目录');

  if RegQueryStringValue(HKCU, SettingsKey, GameDirectoryValue, PreviousGame) then
    if ExistingGameRoot(PreviousGame) <> '' then begin
      ExistingGame.Values[0] := PreviousGame;
      GameMode.SelectedValueIndex := 1;
    end;

  RequestedGame := ExpandConstant('{param:GAMEFOLDER|}');
  if RequestedGame <> '' then begin
    ExistingGame.Values[0] := RequestedGame;
    GameMode.SelectedValueIndex := 1;
  end;
end;

function ShouldSkipPage(PageID: Integer): Boolean;
begin
  Result := (PageID = ExistingGame.ID) and (GameMode.SelectedValueIndex <> 1);
end;

function NextButtonClick(CurPageID: Integer): Boolean;
begin
  Result := True;
  if (CurPageID = ExistingGame.ID) and (ExistingGameRoot(ExistingGame.Values[0]) = '') then begin
    MsgBox('这个位置没有找到包含 versions 的 Minecraft 游戏目录。', mbError, MB_OK);
    Result := False;
  end;
end;

function PrepareToInstall(var NeedsRestart: Boolean): String;
begin
  Result := '';
  if GameMode.SelectedValueIndex = 1 then begin
    SelectedGame := ExistingGameRoot(ExistingGame.Values[0]);
    if SelectedGame = '' then Result := '没有找到现有 Minecraft 游戏目录。';
  end else begin
    SelectedGame := ExpandConstant('{localappdata}\LDFCL\game');
    if not ForceDirectories(AddBackslash(SelectedGame) + 'versions') then
      Result := '无法创建新的 Minecraft 游戏目录。';
  end;
end;

procedure CurStepChanged(CurStep: TSetupStep);
begin
  if CurStep = ssPostInstall then begin
    if not RegWriteStringValue(HKCU, SettingsKey, GameDirectoryValue, SelectedGame) then
      RaiseException('无法保存 LDFCL 游戏目录。');
  end;
end;
