; The Windows installer (SPEC §26.1). Built by tools/build-release.ts, which
; passes AppVersion, SourceDir (the staged app), OutDir and IconFile.
; Per user, no admin: %LOCALAPPDATA%\Programs\ResolveCollab. Unsigned, so
; SmartScreen warns once ("More info" > "Run anyway"). The app puts its
; bridge into Resolve at every start; uninstalling removes it. Sessions,
; settings, logs and downloaded media (%USERPROFILE%\ResolveCollab,
; Videos\ResolveCollab) are kept, also by an update over an older version.

[Setup]
AppId={{8C4C2A7E-5B1A-4C1E-9E7B-1F2D3C4B5A69}
AppName=ResolveCollab
AppVersion={#AppVersion}
AppPublisher=ResolveCollab
DefaultDirName={localappdata}\Programs\ResolveCollab
DisableDirPage=yes
DisableProgramGroupPage=yes
PrivilegesRequired=lowest
OutputDir={#OutDir}
OutputBaseFilename=ResolveCollab-Setup-{#AppVersion}
SetupIconFile={#IconFile}
UninstallDisplayIcon={app}\window\icon\icon.ico
UninstallDisplayName=ResolveCollab
Compression=lzma2/max
SolidCompression=yes
WizardStyle=modern
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
CloseApplications=yes

[Tasks]
Name: "desktopicon"; Description: "Make a desktop shortcut"; Flags: unchecked

[InstallDelete]
; An update replaces the app's own files, so nothing from an older version stays.
Type: filesandordirs; Name: "{app}\src"
Type: filesandordirs; Name: "{app}\window"
Type: filesandordirs; Name: "{app}\bridge"
Type: filesandordirs; Name: "{app}\node_modules"
Type: filesandordirs; Name: "{app}\runtime"
Type: filesandordirs; Name: "{app}\ffmpeg"
Type: files; Name: "{app}\package-lock.json"

[Files]
Source: "{#SourceDir}\*"; DestDir: "{app}"; Flags: recursesubdirs createallsubdirs ignoreversion

[Icons]
Name: "{userprograms}\ResolveCollab"; Filename: "{app}\runtime\ResolveCollab.exe"; Parameters: """{app}\launch.mjs"""; WorkingDir: "{app}"; IconFilename: "{app}\window\icon\icon.ico"; Comment: "Work on a DaVinci Resolve project together"
Name: "{userdesktop}\ResolveCollab"; Filename: "{app}\runtime\ResolveCollab.exe"; Parameters: """{app}\launch.mjs"""; WorkingDir: "{app}"; IconFilename: "{app}\window\icon\icon.ico"; Tasks: desktopicon

[Run]
Filename: "{app}\runtime\ResolveCollab.exe"; Parameters: """{app}\launch.mjs"""; WorkingDir: "{app}"; Description: "Start ResolveCollab"; Flags: nowait postinstall skipifsilent

[UninstallDelete]
Type: files; Name: "{userappdata}\Blackmagic Design\DaVinci Resolve\Support\Fusion\Scripts\Utility\ResolveCollab.lua"
