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
OutputDir={#OutputRoot}
OutputBaseFilename={#SetupBasename}
Compression=lzma2
SolidCompression=yes
WizardStyle=modern
ShowLanguageDialog=yes

[Languages]
Name: "zhcn"; MessagesFile: "{#ChineseMessages}"; LicenseFile: "LICENSE.zh-CN.txt"
Name: "en"; MessagesFile: "compiler:Default.isl"; LicenseFile: "{#SourceRoot}\LICENSE"

[CustomMessages]
zhcn.GameModeTitle=选择游戏目录
zhcn.GameModeDescription=新建游戏目录，也可沿用现有的 Minecraft 目录。
zhcn.GameModeInfo=全新安装会创建空游戏目录。沿用现有目录时，LDFCL 会直接读取其中已安装的游戏版本。
zhcn.FreshInstall=全新安装
zhcn.ReuseDirectory=使用 PCL / HMCL 的现有游戏目录
zhcn.ExistingGameTitle=选择现有游戏目录
zhcn.ExistingGameDescription=选择 .minecraft 或它所在的启动器目录。
zhcn.ExistingGameInfo=请选中包含 versions 的游戏目录，或包含 .minecraft 的启动器文件夹。
zhcn.GameDirectoryLabel=游戏目录
zhcn.GameDirectoryMissing=这个位置没有找到包含 versions 的 Minecraft 游戏目录。
zhcn.CreateGameDirectoryFailed=无法创建新的 Minecraft 游戏目录。
zhcn.SaveGameDirectoryFailed=无法保存 LDFCL 游戏目录。
zhcn.RemoveLegacyInstallFailed=无法移除旧版启动器文件。请先关闭 LDFCL，从 Windows 设置卸载旧版后重试。

en.GameModeTitle=Choose a game directory
en.GameModeDescription=Create a new game directory or use an existing Minecraft directory.
en.GameModeInfo=A fresh installation creates an empty game directory. If you reuse a directory, LDFCL reads the game versions already installed there.
en.FreshInstall=Fresh installation
en.ReuseDirectory=Use an existing PCL or HMCL game directory
en.ExistingGameTitle=Select an existing game directory
en.ExistingGameDescription=Select .minecraft or its parent launcher folder.
en.ExistingGameInfo=Choose a game directory containing versions or a launcher folder containing .minecraft.
en.GameDirectoryLabel=Game directory
en.GameDirectoryMissing=No Minecraft game directory containing versions was found at this location.
en.CreateGameDirectoryFailed=Could not create the new Minecraft game directory.
en.SaveGameDirectoryFailed=Could not save the LDFCL game directory.
en.RemoveLegacyInstallFailed=Could not remove the older launcher files. Close LDFCL, uninstall the older version in Windows Settings, and try again.

[Files]
Source: "{#SourceRoot}\runtime\*"; DestDir: "{app}\runtime"; Flags: ignoreversion recursesubdirs
Source: "{#SourceRoot}\LICENSE"; DestDir: "{app}\runtime"; Flags: ignoreversion
Source: "LICENSE.zh-CN.txt"; DestDir: "{app}\runtime"; Flags: ignoreversion
Source: "{#SourceRoot}\LDFCL.exe"; DestDir: "{app}"; Flags: ignoreversion
Source: "{#SourceRoot}\ldfcl-uninstall.exe"; DestDir: "{app}"; DestName: "Uninstall.exe"; Flags: ignoreversion

[InstallDelete]
Type: files; Name: "{app}\runtime\bin\LDFCL.exe"; Check: IsPreviousQtLayout
Type: files; Name: "{app}\runtime\bin\Qt6*.dll"; Check: IsPreviousQtLayout

[Icons]
Name: "{autoprograms}\LDFCL"; Filename: "{app}\LDFCL.exe"

[Run]
Filename: "{app}\LDFCL.exe"; Description: "{cm:LaunchProgram,LDFCL}"; Flags: nowait postinstall skipifsilent


[Code]
const
  SettingsKey = 'Software\LDFCL\LDFCL';
  GameDirectoryValue = 'gameDirectory';
  LegacyUninstallKey = 'Software\Microsoft\Windows\CurrentVersion\Uninstall\{D36A8869-A15C-461A-97B8-5811D65F2D38}_is1';
  GameDirectoryFile = 'config\game-directory.txt';
  MoveFileReplaceExisting = 1;

var
  GameMode: TInputOptionWizardPage;
  ExistingGame: TInputDirWizardPage;
  ConfiguredRoot, PreviousPortableGame, SelectedGame: String;
  PreviousQtLayout: Boolean;

function MoveFileEx(Source, Destination: String; Flags: Cardinal): Bool;
external 'MoveFileExW@kernel32.dll stdcall setuponly';

function ExistingGameRoot(Path: String): String;
begin
  Result := '';
  Path := Trim(Path);
  if Path = '' then Exit;
  Path := RemoveBackslashUnlessRoot(ExpandFileName(Path));
  if DirExists(AddBackslash(Path) + 'versions') then
    Result := Path
  else if DirExists(AddBackslash(Path) + '.minecraft\versions') then
    Result := AddBackslash(Path) + '.minecraft';
end;

function ReadPortableGameDirectory(Root: String): String;
var
  Bytes: AnsiString;
  Path: String;
begin
  Result := '';
  if not LoadStringFromFile(AddBackslash(Root) + GameDirectoryFile, Bytes) then Exit;
  Path := UTF8Decode(Bytes);
  if Copy(Path, 1, 1) = #$FEFF then Delete(Path, 1, 1);
  Path := Trim(Path);
  if Path = '' then Exit;
  StringChangeEx(Path, '/', '\', False);
  if (Copy(Path, 1, 2) <> '\\') and (Copy(Path, 2, 2) <> ':\') then
    Path := AddBackslash(Root) + Path;
  Result := RemoveBackslashUnlessRoot(ExpandFileName(Path));
end;

procedure InitializeWizard;
begin
  Log('LDFCL installer language: ' + ActiveLanguage);
  GameMode := CreateInputOptionPage(wpSelectDir, CustomMessage('GameModeTitle'),
    CustomMessage('GameModeDescription'), CustomMessage('GameModeInfo'), True, False);
  GameMode.Add(CustomMessage('FreshInstall'));
  GameMode.Add(CustomMessage('ReuseDirectory'));
  GameMode.SelectedValueIndex := 0;

  ExistingGame := CreateInputDirPage(GameMode.ID, CustomMessage('ExistingGameTitle'),
    CustomMessage('ExistingGameDescription'), CustomMessage('ExistingGameInfo'), False, '');
  ExistingGame.Add(CustomMessage('GameDirectoryLabel'));
end;

procedure CurPageChanged(CurPageID: Integer);
var
  Root, PreviousGame, RequestedGame: String;
begin
  if CurPageID <> GameMode.ID then Exit;
  Root := RemoveBackslashUnlessRoot(ExpandFileName(WizardDirValue));
  if CompareText(Root, ConfiguredRoot) = 0 then Exit;
  ConfiguredRoot := Root;

  RequestedGame := ExpandConstant('{param:GAMEFOLDER|}');
  PreviousPortableGame := ReadPortableGameDirectory(Root);
  if RequestedGame = '' then begin
    RequestedGame := PreviousPortableGame;
    if (RequestedGame = '') and
       RegQueryStringValue(HKCU, SettingsKey, GameDirectoryValue, PreviousGame) then
      RequestedGame := ExistingGameRoot(PreviousGame);
  end;

  ExistingGame.Values[0] := RequestedGame;
  if RequestedGame <> '' then
    GameMode.SelectedValueIndex := 1
  else
    GameMode.SelectedValueIndex := 0;
end;

function ChosenExistingGame: String;
begin
  if (PreviousPortableGame <> '') and
     (CompareText(ExistingGame.Values[0], PreviousPortableGame) = 0) then
    Result := PreviousPortableGame
  else
    Result := ExistingGameRoot(ExistingGame.Values[0]);
end;

function ShouldSkipPage(PageID: Integer): Boolean;
begin
  Result := (PageID = ExistingGame.ID) and (GameMode.SelectedValueIndex <> 1);
end;

function NextButtonClick(CurPageID: Integer): Boolean;
begin
  Result := True;
  if (CurPageID = ExistingGame.ID) and (ChosenExistingGame = '') then begin
    MsgBox(CustomMessage('GameDirectoryMissing'), mbError, MB_OK);
    Result := False;
  end;
end;

function RemovePreviousLayout: Boolean;
var
  RegisteredCommand, OldUninstaller, OldLauncher: String;
  ExitCode: Integer;
begin
  Result := True;
  { Installations with the runtime layout already share the current uninstall log. }
  if PreviousQtLayout then Exit;
  OldLauncher := ExpandConstant('{app}\bin\LDFCL.exe');
  OldUninstaller := ExpandConstant('{app}\unins000.exe');
  if not FileExists(OldLauncher) then Exit;
  if not RegQueryStringValue(HKCU, LegacyUninstallKey, 'UninstallString', RegisteredCommand) then Exit;
  if CompareText(RemoveQuotes(RegisteredCommand), OldUninstaller) <> 0 then Exit;
  Result := Exec(OldUninstaller, '/VERYSILENT /SUPPRESSMSGBOXES /NORESTART', '',
    SW_HIDE, ewWaitUntilTerminated, ExitCode);
  if Result then
    Result := (ExitCode = 0) and not FileExists(OldLauncher);
end;

function IsPreviousQtLayout: Boolean;
begin
  Result := PreviousQtLayout;
end;

function PrepareToInstall(var NeedsRestart: Boolean): String;
begin
  PreviousQtLayout := FileExists(ExpandConstant('{app}\runtime\bin\Qt6Core.dll')) and
    FileExists(ExpandConstant('{app}\runtime\bin\LDFCL.exe'));
  Result := '';
  if GameMode.SelectedValueIndex = 1 then begin
    SelectedGame := ChosenExistingGame;
    if SelectedGame = '' then Result := CustomMessage('GameDirectoryMissing');
  end else begin
    SelectedGame := ExpandConstant('{localappdata}\LDFCL\game');
    if not ForceDirectories(AddBackslash(SelectedGame) + 'versions') then
      Result := CustomMessage('CreateGameDirectoryFailed');
  end;
  if Result = '' then
    if not RemovePreviousLayout then
      Result := CustomMessage('RemoveLegacyInstallFailed');
end;

function SaveGameDirectory: Boolean;
var
  Root, TargetFile, TempFile, StoredPath: String;
begin
  Result := False;
  Root := AddBackslash(ExpandConstant('{app}'));
  TargetFile := Root + GameDirectoryFile;
  if not ForceDirectories(ExtractFileDir(TargetFile)) then Exit;
  TempFile := TargetFile + '.' + ExtractFileName(ExpandConstant('{tmp}')) + '.tmp';
  StoredPath := SelectedGame;
  if CompareText(SelectedGame, RemoveBackslashUnlessRoot(Root)) = 0 then
    StoredPath := '.'
  else if CompareText(Copy(SelectedGame, 1, Length(Root)), Root) = 0 then
    StoredPath := Copy(SelectedGame, Length(Root) + 1, Length(SelectedGame));

  if SaveStringToFile(TempFile, UTF8Encode(StoredPath), False) then
    Result := MoveFileEx(TempFile, TargetFile, MoveFileReplaceExisting);
  if not Result then DeleteFile(TempFile);
end;

procedure CurStepChanged(CurStep: TSetupStep);
begin
  if CurStep = ssPostInstall then
    if not SaveGameDirectory then
      RaiseException(CustomMessage('SaveGameDirectoryFailed'));
end;
